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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/** Read a file as UTF-8, rejecting anything implausibly large for a source file. */
function readSource(path) {
  const text = readFileSync(path, 'utf8')
  if (text.length > MAX_DOCUMENT_SIZE) {
    throw new Error(`${path} is larger than the 8 MiB document limit`)
  }
  return text
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

  constructor({ program, serverDll, workspaceRoot, logDir = null, stateDir = null, locale = 'en-US' }) {
    this.program = program
    this.serverDll = serverDll
    this.workspaceRoot = workspaceRoot
    this.logDir = logDir
    // A writable directory the server may use for its runtime state (see
    // `#childEnv`); `null` keeps the inherited environment untouched.
    this.stateDir = stateDir
    this.locale = locale
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

  /** Last lines of the server's stderr, for a failure message. */
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
      env.XDG_RUNTIME_DIR = this.stateDir
      env.TMPDIR = this.stateDir
      env.DOTNET_CLI_HOME = this.stateDir
      env.NUGET_PACKAGES = env.NUGET_PACKAGES ?? join(this.stateDir, 'nuget')
    }
    return env
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
      this.#fail(
        new LspConnectionError(
          `C# language server exited (${signal ? `signal ${signal}` : `code ${code}`})` +
            (this.#stderrTail.length ? `: ${this.#stderrTail.slice(-3).join('').trim().slice(0, 400)}` : ''),
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

  #onNotification(message) {
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
    const uri = pathToFileUri(path)
    const text = readSource(path)
    const existing = this.#openDocs.get(uri)
    if (!existing) {
      this.#openDocs.set(uri, { version: 1, text })
      this.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'csharp', version: 1, text },
      })
      return uri
    }
    if (existing.text === text) return uri
    existing.version += 1
    existing.text = text
    this.notify('textDocument/didChange', {
      textDocument: { uri, version: existing.version },
      contentChanges: [{ text }],
    })
    return uri
  }

  /** Tell the server a file changed on disk (outside our own writes). */
  notifyFileChanged(path, kind = 2) {
    const uri = pathToFileUri(path)
    this.notify('workspace/didChangeWatchedFiles', {
      changes: [{ uri, type: kind }],
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
  if (!connection?.stderrTail) return null
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, connection.stderrTail)
  return path
}