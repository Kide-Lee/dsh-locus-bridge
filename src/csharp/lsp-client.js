// JSON-RPC client for the Roslyn C# language server.
//
// One `LspConnection` owns one child process and one pending-request table. It
// speaks LSP over the child's stdio with `Content-Length` framing and answers
// every server→client request, which is not optional: the server sends
// `client/registerCapability`, `workspace/configuration` and
// `window/workDoneProgress/create` during startup and stalls if any goes
// unanswered.
//
// Protocol facts worth keeping (all verified against
// `Microsoft.CodeAnalysis.LanguageServer` 5.4.0, and cross-checked with
// `Locus/src-tauri/src/csharp_lsp/client.rs`, which documents the same traps):
//
//   * `--logLevel` and `--extensionLogDirectory` are required arguments;
//     `--stdio` selects stdio transport (the default is a named-pipe handshake).
//   * A request or notification with `"params": null` crashes the server's
//     StreamJsonRpc reader. Always send an object or array.
//   * Project loading completes with the non-standard notification
//     `workspace/projectInitializationComplete` after `solution/open` /
//     `project/open` — which are *notifications*, not requests.
//   * The server answers a query issued before its semantic analysis settles
//     with JSON-RPC error -32800 ("task was canceled"), so queries retry that
//     specific code instead of surfacing it.
//   * Dynamic diagnostic providers are registered one per source; a pull
//     request must echo each provider's own `identifier`.

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { encodeLspMessage, LspReader, pathToFileUri } from './lsp-protocol.js'

/** The server process died or the transport broke. */
export class LspConnectionError extends Error {
  constructor(message, { code = null } = {}) {
    super(message)
    this.name = 'LspConnectionError'
    this.code = code
  }
}

/** A JSON-RPC error response from the server. */
export class LspResponseError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message)
    this.name = 'LspResponseError'
    this.code = code
    this.data = data
  }
}

/** JSON-RPC "server cancelled the request" — the analysis was not ready yet. */
export const REQUEST_CANCELLED = -32800
const REQUEST_TIMEOUT_MS = 120_000
const MAX_DOCUMENT_SIZE = 8 * 1024 * 1024
/** LSP `FileChangeType` values used by `workspace/didChangeWatchedFiles`. */
export const FILE_CREATED = 1
export const FILE_CHANGED = 2
export const FILE_DELETED = 3
/** How much of the last server-reported error is kept for a failure message.
 * Matches upstream's 400-character `last_server_error`. */
const LAST_SERVER_ERROR_LIMIT = 400
/** How many `window/logMessage` lines a connection keeps for diagnostics. */
const SERVER_LOG_LIMIT = 500

/**
 * The text a document is opened with: exactly its on-disk text.
 *
 * Analyzers cannot be added here. The server's MSBuild host evaluates a project
 * from disk, so an `<ItemGroup>` a client appends to the *opened* text never
 * reaches project evaluation (verified live with Unity 2022.3 + Roslyn 5.4.0:
 * no `UNT*` diagnostics). Unity's analyzers are injected the way upstream does
 * it, by writing a marker-tagged `Directory.Build.props` before the server
 * starts (see `analyzer-injection.js`).
 */
function documentText(path) {
  return readSource(path)
}

/** The P/Invoke-heavy kind of MSBuild document `path` is (project or props). */
function projectExtension(path) {
  const lower = String(path ?? '').toLowerCase()
  if (lower.endsWith('.csproj')) return 'proj'
  if (lower.endsWith('.props')) return 'props'
  return null
}

/** Read a file as UTF-8, rejecting anything implausibly large for a source file. */
function readSource(path) {
  const text = readFileSync(path, 'utf8')
  if (text.length > MAX_DOCUMENT_SIZE) {
    throw new Error(`${path} is larger than the 8 MiB document limit`)
  }
  return text
}

function languageIdFor(path) {
  const kind = projectExtension(path)
  return kind === 'proj' ? 'xml' : kind === 'props' ? 'xml' : 'csharp'
}

/**
 * Spawn the language server on `workspaceRoot`.
 *
 * @param {object} options
 * @param {string} options.program       `dotnet`/`dotnet.exe`, or a managed path
 * @param {string} options.serverDll     `Microsoft.CodeAnalysis.LanguageServer.dll`
 * @param {string} options.workspaceRoot absolute checkout root
 * @param {string} [options.logDir]      directory for the server's stderr log
 * @param {string} [options.locale]      server-produced strings locale
 * @param {string} [options.stateDir]    writable dir for the server's runtime state
 * @param {() => void} [options.onServerExit]  called once when the process dies
 */
export class LspConnection {
  #child = null
  #reader = null
  #nextId = 0
  #pending = new Map()
  #buffer = Buffer.alloc(0)
  #closed = false
  #exitError = null
  #loaded = false
  #loadedWaiters = new Set()
  #projectsSeen = new Set()
  #openDocs = new Map()
  #diagnosticProviders = []
  #stderrTail = []
  #serverLog = []
  #lastServerError = null
  #registrations = 0

  constructor(options) {
    const {
      program,
      serverDll,
      workspaceRoot,
      logDir = null,
      stateDir = null,
      locale = 'en-US',
      onServerExit = null,
    } = options
    this.program = program
    this.serverDll = serverDll
    this.workspaceRoot = workspaceRoot
    this.logDir = logDir
    // A writable directory the server may use for its runtime state (see
    // `#childEnv`); `null` keeps the inherited environment untouched.
    this.stateDir = stateDir
    this.locale = locale
    this.onServerExit = onServerExit
    this.reader = new LspReader()
  }

  get connected() {
    return this.#child !== null && !this.#closed && this.#child.exitCode === null
  }

  get loaded() {
    return this.#loaded
  }

  get openDocumentCount() {
    return this.#openDocs.size
  }

  get diagnosticProviders() {
    return [...this.#diagnosticProviders]
  }

  /**
   * How many capability registrations this connection has received.
   *
   * `initialize` answers `workspace: {}` without listing `diagnosticProvider`,
   * so the server registers one provider per source through
   * `client/registerCapability`. That stream is the only readiness signal the
   * analysis pipeline publishes before it starts evaluating the solution, and
   * it is what `code_diagnostics` waits on before trusting an empty answer.
   */
  get registrationCount() {
    return this.#registrations
  }

  /**
   * Server log lines worth keeping.
   *
   * The server reports problems that are not protocol errors through
   * `window/logMessage`: a project that failed to load still completes
   * `projectInitializationComplete`, so the failure only ever appears here. The
   * tail is bounded because a large solution logs thousands of lines.
   */
  get serverLog() {
    return [...this.#serverLog]
  }

  /** Last `window/logMessage`/`window/showMessage` of type Error, if any. */
  get lastServerError() {
    return this.#lastServerError
  }

  /** Everything the server wrote to stderr, for `dumpStderr`. */
  get stderrDump() {
    return this.#stderrTail.join('')
  }

  /**
   * Environment for the server child process.
   *
   * `XDG_RUNTIME_DIR` matters more than it looks: .NET creates its named-mutex
   * and temp-cache directories under it (`/run/user/<uid>` on Linux), and when
   * that path is read-only the server's `dotnet restore` and
   * `MetadataAsSource` composition both fail — the visible symptom is
   * `-32800 task canceled` on the first query followed by a silent exit 0.
   * A sandboxed host (or a headless container) hits this routinely, so an
   * unusable runtime dir is redirected into the asset root instead of being
   * inherited.
   */
  #childEnv() {
    const env = {
      ...process.env,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
      // Project restore is driven explicitly by the loader; the first-run
      // experience would otherwise write outside the workspace.
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    }
    if (this.stateDir) {
      // Ownership matters as much as writability: `fs.mkdtemp` hands the
      // directory to this process alone, which is what makes it usable on a host
      // where the asset root (a sandbox mount, another user's home) is not.
      const dir = this.#ensureWritable(this.stateDir)
      if (dir) {
        env.XDG_RUNTIME_DIR = dir
        env.TMPDIR = dir
        env.DOTNET_CLI_HOME = dir
        env.NUGET_PACKAGES = env.NUGET_PACKAGES ?? join(dir, 'nuget')
      }
    }
    return env
  }

  /**
   * A directory the server can write to, or `null`.
   *
   * The server's MSBuild host evaluates every project through the .NET CLI, and
   * the CLI insists on writing its first-run sentinel and workload state into
   * `DOTNET_CLI_HOME`. When that directory is not writable the build host fails
   * with `IOException: Read-only file system`, every project fails to load, and
   * the server still reports `projectInitializationComplete` — so the failure
   * surfaces only as "no document" / "no diagnostics" for every query. A
   * private temp directory is the fallback; it costs a first-run marker per
   * session and nothing else.
   */
  #ensureWritable(dir) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.dsh-write-test-${process.pid}`)
      writeFileSync(probe, '')
      unlinkSync(probe)
      return dir
    } catch {
      // Fall through to a private copy.
    }
    try {
      return mkdtempSync(join(tmpdir(), 'dsh-csharp-'))
    } catch {
      return null
    }
  }

  /**
   * Start the process and complete the LSP handshake.
   *
   * Resolves once `initialize` has been answered; project loading is awaited
   * separately by `openProject()` + `waitForProjectLoad()`.
   */
  async start() {
    const args = [this.serverDll, '--stdio', '--logLevel', 'Information']
    // `--extensionLogDirectory` is mandatory: without it the server prints
    // "Option '--extensionLogDirectory' is required." and exits 1 before
    // answering `initialize`. Fall back to a temp directory rather than making
    // the argument optional.
    const logDir = this.logDir ?? join(tmpdir(), 'dsh-locus-csharp-logs')
    mkdirSync(logDir, { recursive: true })
    args.push('--extensionLogDirectory', logDir)
    if (this.stateDir) mkdirSync(this.stateDir, { recursive: true })
    this.#child = spawn(this.program, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.#childEnv(),
    })
    this.#child.on('error', (error) => this.#fail(new LspConnectionError(`language server failed to start: ${error.message}`)))
    this.#child.on('exit', (code, signal) => {
      // Upstream records the last error-level log message and puts it in the
      // failure reason: the server has been observed exiting without writing
      // anything to stderr, right after rapid file edits.
      const lastError = this.#lastServerError ? `. Last server error: ${this.#lastServerError}` : ''
      const stderr = this.#stderrTail.length ? `: ${this.#stderrTail.slice(-3).join('').trim().slice(0, 400)}` : ''
      this.#fail(
        new LspConnectionError(
          `C# language server exited (${signal ? `signal ${signal}` : `code ${code}`})${lastError || stderr}`,
          { code: 'server_exited' },
        ),
      )
    })
    this.#child.stderr.setEncoding('utf8')
    this.#child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.#stderrTail.push(`${line}\n`)
      }
      // Keep the tail bounded; server logs are chatty at Information level.
      while (this.#stderrTail.length > 200) this.#stderrTail.shift()
    })
    this.#child.stdout.on('data', (chunk) => this.#onData(chunk))
    this.#child.stdin.on('error', () => {
      // EPIPE surfaces through #fail from the exit handler; swallow the write error.
    })
    await this.initialize()
    return this
  }

  #fail(error) {
    if (this.#closed) return
    this.#closed = true
    this.#exitError = error
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    this.#pending.clear()
    for (const waiter of this.#loadedWaiters) waiter.reject(error)
    this.#loadedWaiters.clear()
    // Tell the pool this process is gone so the next query starts a fresh one
    // instead of reusing a connection every request will reject on.
    try {
      this.onServerExit?.(error)
    } catch {
      // A bookkeeping callback must not mask the failure it reports.
    }
  }

  #onData(chunk) {
    let messages
    try {
      messages = this.reader.push(chunk)
    } catch (error) {
      this.#fail(new LspConnectionError(`malformed LSP frame: ${error.message}`))
      return
    }
    for (const message of messages) this.#onMessage(message)
  }

  #onMessage(message) {
    // Response to one of our requests.
    if (message.id !== undefined && message.id !== null && message.method === undefined) {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new LspResponseError(
            String(message.error.message ?? 'language server error'),
            { code: message.error.code ?? null, data: message.error.data ?? null },
          ),
        )
      } else {
        pending.resolve(message.result ?? null)
      }
      return
    }
    // Server → client request: every one must be answered.
    if (message.id !== undefined && message.id !== null && message.method !== undefined) {
      this.#answerServerRequest(message)
      return
    }
    this.#onNotification(message)
  }

  #answerServerRequest(message) {
    let result = null
    switch (message.method) {
      case 'workspace/configuration': {
        const items = message.params?.items ?? []
        result = items.map((item) => this.#configurationFor(item?.section ?? ''))
        break
      }
      case 'client/registerCapability':
        this.#recordRegistrations(message.params)
        result = null
        break
      case 'client/unregisterCapability':
        this.#forgetRegistrations(message.params)
        result = null
        break
      case 'window/workDoneProgress/create':
        result = null
        break
      case 'workspace/applyEdit':
        result = { applied: false }
        break
      default:
        // Unknown requests get an explicit -32601 rather than silence: the
        // server logs it and moves on, whereas no reply stalls the pipeline.
        this.#write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `method not handled: ${message.method}` },
        })
        return
    }
    this.#write({ jsonrpc: '2.0', id: message.id, result })
  }

  /** Settings the server asks for by section name. */
  #configurationFor(section) {
    // Unity-generated csproj carry no restorable packages, yet the per-project
    // `dotnet restore` sweep dominates load time (upstream measured 48s -> 4.4s
    // on a 107-project solution with it disabled).
    if (section === 'projects.dotnet_enable_automatic_restore') return false
    // The default analysis scope is open files only, which would make
    // workspace diagnostics report almost nothing.
    if (
      section === 'background_analysis.dotnet_analyzer_diagnostics_scope' ||
      section === 'background_analysis.dotnet_compiler_diagnostics_scope'
    ) {
      return 'fullSolution'
    }
    // `null` means "use the server's own default".
    return null
  }

  #recordRegistrations(params) {
    const registrations = params?.registrations ?? []
    this.#registrations += registrations.length
    for (const registration of registrations) {
      if (registration?.method !== 'textDocument/diagnostic') continue
      const identifier = registration.registerOptions?.identifier ?? null
      this.#diagnosticProviders.push({
        identifier,
        workspaceDiagnostics: Boolean(registration.registerOptions?.workspaceDiagnostics),
      })
    }
  }

  #forgetRegistrations(params) {
    const unregisterations = params?.unregisterations ?? params?.unregistrations ?? []
    for (const entry of unregisterations) {
      if (entry?.method !== 'textDocument/diagnostic') continue
      // Unregistering removes every provider sharing that identifier.
      const identifier = entry.registerOptions?.identifier ?? null
      this.#diagnosticProviders = this.#diagnosticProviders.filter(
        (provider) => provider.identifier !== identifier,
      )
    }
  }

  /** Keep the recent server log, and the failures it reports outside the protocol. */
  #recordLog(message) {
    if (message.method !== 'window/logMessage' && message.method !== 'window/showMessage') return
    const text = String(message.params?.message ?? '').trim()
    if (!text) return
    this.#serverLog.push(text)
    while (this.#serverLog.length > SERVER_LOG_LIMIT) this.#serverLog.shift()
  }

  #onNotification(message) {
    this.#recordLog(message)
    if (message.method === 'workspace/projectInitializationComplete') {
      this.#loaded = true
      for (const waiter of this.#loadedWaiters) waiter.resolve(true)
      this.#loadedWaiters.clear()
      return
    }
    // The loader mentions each project as it starts; a count is the closest
    // thing to load progress the server offers.
    if (message.method === 'window/logMessage' || message.method === 'window/showMessage') {
      const text = message.params?.message ?? ''
      // Keep the last error-level message: the server can exit without writing
      // anything to stderr, and this is the only explanation it leaves behind.
      if ((message.params?.type ?? 0) === 1 && text) {
        this.#lastServerError = text.length > LAST_SERVER_ERROR_LIMIT ? `${text.slice(0, LAST_SERVER_ERROR_LIMIT)}…` : text
      }
      const match = /Loading (?:project|solution file) .*?([^\\/]+\.(?:csproj|sln))/.exec(text)
      if (match) this.#projectsSeen.add(match[1])
    }
  }

  #write(message) {
    if (this.#closed || !this.#child) {
      throw this.#exitError ?? new LspConnectionError('C# language server is not running')
    }
    try {
      this.#child.stdin.write(encodeLspMessage(message))
    } catch (error) {
      throw new LspConnectionError(`write to the language server failed: ${error.message}`)
    }
  }

  /** Send a request and await its result. */
  request(method, params, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    if (this.#closed) return Promise.reject(this.#exitError ?? new LspConnectionError('language server is closed'))
    // A JSON `null` params crashes the server's reader; an empty object is the
    // documented-safe way to say "no arguments".
    const payload = params ?? {}
    this.#nextId += 1
    const id = this.#nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new LspConnectionError(`language server did not answer ${method} within ${timeoutMs} ms`, { code: 'timeout' }))
      }, timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params: payload })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  /** Send a notification (no response expected). */
  notify(method, params) {
    this.#write({ jsonrpc: '2.0', method, params: params ?? {} })
  }

  async initialize() {
    const rootUri = pathToFileUri(this.workspaceRoot)
    const name = this.workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
    await this.request('initialize', {
      processId: process.pid,
      // Server-produced strings (symbol containers, diagnostics) stay English
      // regardless of OS locale — agents consume them.
      locale: this.locale,
      rootUri,
      capabilities: {
        workspace: {
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceFolders: true,
          symbol: {},
          diagnostics: {},
        },
        textDocument: {
          synchronization: { didSave: true },
          references: {},
          definition: {},
          hover: { contentFormat: ['plaintext', 'markdown'] },
          diagnostic: { dynamicRegistration: true },
        },
        window: { workDoneProgress: true },
      },
      workspaceFolders: [{ uri: rootUri, name }],
    })
    this.notify('initialized', {})
  }

  /** Ask the server to load a solution or a set of projects. */
  openProject({ solution = null, projects = [] } = {}) {
    if (solution) {
      this.#loaded = false
      this.notify('solution/open', { solution: pathToFileUri(solution) })
      return
    }
    if (projects.length === 0) throw new Error('openProject needs a solution or at least one project')
    this.#loaded = false
    this.notify('project/open', { projects: projects.map((path) => pathToFileUri(path)) })
  }

  /** Wait for `workspace/projectInitializationComplete` or the process dying. */
  waitForProjectLoad(timeoutMs) {
    if (this.#loaded) return Promise.resolve(true)
    if (this.#closed) return Promise.reject(this.#exitError ?? new LspConnectionError('language server is closed'))
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      const timer = setTimeout(() => {
        this.#loadedWaiters.delete(waiter)
        reject(
          new LspConnectionError(
            `the C# language server did not finish loading the project within ${Math.round(timeoutMs / 1000)}s` +
              (this.#stderrTail.length ? `: ${this.#stderrTail.slice(-2).join('').trim().slice(0, 300)}` : ''),
            { code: 'load_timeout' },
          ),
        )
      }, timeoutMs)
      waiter.resolve = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      waiter.reject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      this.#loadedWaiters.add(waiter)
    })
  }

  /** Open `path` (or push its new content) and return the document URI. */
  syncDocument(path) {
    return this.#openDocument(path)
  }

  /**
   * Open a project file (`.csproj`/`.props`) so the server knows it.
   *
   * Analyzers are not injected into this text; see `documentText`.
   */
  syncProjectDocument(path) {
    const kind = projectExtension(path)
    if (!kind) return this.isOpen(path)
    return this.#openDocument(path, kind) !== null
  }

  #openDocument(path, kind = projectExtension(path)) {
    const uri = pathToFileUri(path)
    const text = documentText(path)
    const existing = this.#openDocs.get(uri)
    if (!existing) {
      this.#openDocs.set(uri, { version: 1, text })
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: languageIdFor(path), version: 1, text },
      })
      return uri
    }
    if (existing.text === text) return uri
    // Roslyn negotiates incremental sync and dies with an NRE on a rangeless
    // full-text didChange (`ProtocolConversions.RangeToTextSpan` on a null
    // Range — observed killing the server on every edit→query cycle; see
    // `client.rs` in upstream, which documents the same trap). Reopen instead:
    // didOpen always carries full text and is valid under any sync kind.
    // The version has to keep climbing across the pair: a document reopened
    // with the same version as before reads as "already current" to a server
    // that still remembers the earlier one.
    existing.version += 2
    existing.text = text
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: languageIdFor(path), version: existing.version, text },
    })
    return uri
  }

  /**
   * Re-sync a document only when we already opened it.
   *
   * Open documents shadow the disk state on the server side, so an edit made
   * outside this process has to be pushed; a file we never opened is the
   * server's own business (it follows `workspace/didChangeWatchedFiles`), and
   * opening it here would pin a copy nobody will refresh.
   */
  syncDocumentIfOpen(path) {
    if (!this.isOpen(path)) return null
    return this.syncDocument(path)
  }

  /** Whether this connection has told the server about `path`. */
  isOpen(path) {
    return this.#openDocs.has(pathToFileUri(path))
  }

  /**
   * Close a document we opened before, so the server drops our pinned copy
   * (typically because the file was deleted and the copy must not shadow it).
   */
  closeDocument(path) {
    const uri = pathToFileUri(path)
    if (!this.#openDocs.delete(uri)) return false
    this.notify('textDocument/didClose', { textDocument: { uri } })
    return true
  }

  /** Tell the server a file changed on disk (outside our own writes). */
  notifyFileChanged(path, kind = FILE_CHANGED) {
    this.notifyWatchedFiles([[path, kind]])
  }

  /**
   * Forward file events so the server refreshes documents it did not open and
   * re-evaluates project files. `changes` entries are `[path, kind]` with LSP
   * change kinds (1 created / 2 changed / 3 deleted).
   */
  notifyWatchedFiles(changes) {
    const entries = (changes ?? []).filter((entry) => entry?.[0])
    if (entries.length === 0) return
    this.notify('workspace/didChangeWatchedFiles', {
      changes: entries.map(([path, kind]) => ({ uri: pathToFileUri(path), type: kind ?? FILE_CHANGED })),
    })
  }

  /** Pull every registered diagnostic provider for one document. */
  async documentDiagnostics(path) {
    const uri = this.syncDocument(path)
    const providers = this.#diagnosticProviders.length ? this.#diagnosticProviders : [{ identifier: null }]
    const items = []
    const failures = []
    for (const provider of providers) {
      const params = { textDocument: { uri } }
      if (provider.identifier) params.identifier = provider.identifier
      try {
        const result = await this.request('textDocument/diagnostic', params, { timeoutMs: 60_000 })
        for (const item of result?.items ?? []) items.push(item)
      } catch (error) {
        // A single provider failing must not blank the whole report, but if
        // every provider fails the caller needs to see why.
        failures.push(error)
      }
    }
    if (items.length === 0 && failures.length === providers.length) {
      throw failures[0]
    }
    return items
  }

  /** Close the process. Safe to call twice. */
  async close() {
    if (!this.#child) return
    const child = this.#child
    this.#closed = true
    try {
      this.#child = null
      child.stdin.end()
      child.kill()
    } catch {
      // Already gone.
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(resolve, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

/** Write the server's stderr tail to a log file for later inspection. */
export function dumpStderr(connection, path) {
  if (!connection?.stderrDump) return null
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, connection.stderrDump)
  return path
}