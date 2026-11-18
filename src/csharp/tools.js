// DSH tool definitions for C# semantic analysis.
//
// These are separate from `src/tools.js` because they do not touch the Unity
// broker at all: they drive a Roslyn language server, whose ~90 MB of assets and
// .NET child processes must not be part of the Unity tools' lifecycle. See
// `src/index.js` for how they are registered behind their own gate.
//
// Parameter shapes mirror `Locus/tools/code_*.json` so a prompt or habit that
// works in the desktop agent works here; `project_path` is the only addition,
// because this client has no ambient "current checkout".

import {
  displayPath,
  fileDiagnostics,
  findReferences,
  formatDefinition,
  formatDiagnostics,
  formatHover,
  formatReferences,
  formatSymbols,
  gotoDefinition,
  hover,
  searchSymbols,
  severityRank,
  SEVERITIES,
  workspaceDiagnostics,
} from './queries.js'
import { assetsRoot } from './assets.js'
import { formatDownloadStatus, watchDownload } from './lsp-pool.js'
import { resolveProjectRoot } from '../args.js'

const PROJECT_PATH = {
  type: 'string',
  description:
    'Unity project root (the folder containing Assets/ and ProjectSettings/). Relative paths resolve from the ' +
    'Session working directory. Omit it when the working directory is the Unity project, or when exactly one ' +
    'Unity project sits within three levels below it.',
}

const FILE_PATH = {
  type: 'string',
  description: 'Workspace-relative or absolute path to the .cs file (for example Assets/Scripts/Player.cs).',
  required: true,
}

const SYMBOL = {
  type: 'string',
  description: 'The identifier to resolve (for example TakeDamage or AudioCueEventChannelSO).',
  required: true,
}

const LINE_HINT = {
  type: 'integer',
  description:
    'Optional 1-based line hint where the symbol appears (use the line numbers read showed). Forgiving: when the ' +
    'symbol is not on this line the nearest whole-word occurrence is used and the output notes the adjustment. Omit ' +
    'it (or pass 0) when the symbol appears on only one line; with several occurrences and no hint, the candidate ' +
    'lines are listed instead.',
}

const ANALYSIS_SETUP =
  'Requires the C# analysis assets (Roslyn language server + .NET runtime, ~90 MB) and the project\'s ' +
  'Unity-generated .sln/.csproj files. The first query in a profile downloads the assets once and reuses them; ' +
  'project files are generated automatically from a connected editor, or by a one-shot headless Unity run.'

/**
 * Run one query, turning setup problems into an actionable message.
 *
 * A query that had to fetch assets first carries what it downloaded into the
 * text: upstream reports the same thing as `downloading server 37%` in its
 * status bar, and without a line the caller only sees a long silence.
 */
async function runQuery(action) {
  try {
    return await withDownloadNote(action)
  } catch (error) {
    if (error?.code === 'assets_missing' || error?.code === 'asset_corrupt') {
      throw new Error(
        `${error.message} The first query downloads the Roslyn server and, when no system .NET 10 runtime is ` +
          `present, the runtime too (~90 MB, cached under ${assetsRoot()}); retrying runs that download again.`,
      )
    }
    if (error?.code === 'project_files_missing') {
      throw new Error(
        `${error.message} Open the project in Unity once (Unity writes .sln/.csproj on open), or connect the editor ` +
          'so the generator can run.',
      )
    }
    if (error?.code === 'unsupported_platform') {
      throw new Error(error.message)
    }
    throw error
  }
}

/**
 * Run `action` and append what it downloaded, if anything.
 *
 * The observation has to wrap the query itself: a second query on a warm
 * workspace starts and finishes without passing through the install path, and
 * must not be annotated with the previous transfer.
 */
async function withDownloadNote(action) {
  let latest = null
  const stop = watchDownload((status) => {
    latest = status
  })
  try {
    return await action((value) => noteDownload(value, latest))
  } finally {
    stop()
  }
}

/** Append the transfer summary to a {@link QUERY_TEXT} result. */
function noteDownload(value, latest) {
  const progress = formatDownloadStatus(latest)
  if (!progress || typeof value?.text !== 'string') return value
  return { ...value, text: `${value.text}\n\n(First run in this profile: ${progress} of C# analysis assets.)` }
}

function projectRootFor(args, exec) {
  return resolveProjectRoot(args.project_path, exec)
}

// ─── code_symbol_search ─────────────────────────────────────────────────────

const codeSymbolSearch = {
  name: 'code_symbol_search',
  description:
    'Search C# symbols (classes, methods, properties, fields, ...) across the workspace by name using Roslyn. ' +
    'Fuzzy/camel-hump matching works (ACECSO matches AudioCueEventChannelSO). More precise than grep for locating a ' +
    'declaration by name when the file is unknown; follow up with code_find_references or code_goto_definition.\n\n' +
    ANALYSIS_SETUP,
  parameters: {
    project_path: PROJECT_PATH,
    query: { type: 'string', description: 'Symbol name or fragment to search for (case-insensitive, fuzzy).', required: true },
    max_results: { type: 'integer', description: 'Maximum number of symbols to return (1..200, default 50).' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' }, count: { type: 'integer' } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const root = projectRootFor(args, exec)
    return runQuery(async (note) => {
      const symbols = await searchSymbols(root, { query: args.query, maxResults: args.max_results, signal: exec.signal })
      return note({ text: formatSymbols(args.query, symbols), count: symbols.length })
    })
  },
}

// ─── code_goto_definition ───────────────────────────────────────────────────

const codeGotoDefinition = {
  name: 'code_goto_definition',
  description:
    'Jump to the definition of a C# symbol using Roslyn semantic analysis. Resolves the exact declaration site of a ' +
    'type, method, property, field or variable from any usage — including symbols in other files, other asmdef ' +
    'assemblies, or Unity packages. Symbols defined in compiled assemblies report as external metadata with no path.\n\n' +
    ANALYSIS_SETUP,
  parameters: {
    project_path: PROJECT_PATH,
    file_path: FILE_PATH,
    symbol: SYMBOL,
    line: LINE_HINT,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        locations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const root = projectRootFor(args, exec)
    return runQuery(async (note) => {
      const result = await gotoDefinition(root, {
        filePath: args.file_path,
        symbol: args.symbol,
        line: args.line,
        signal: exec.signal,
      })
      return note({ text: formatDefinition(args.symbol, result), locations: result.locations })
    })
  },
}

// ─── code_find_references ───────────────────────────────────────────────────

const codeFindReferences = {
  name: 'code_find_references',
  description:
    'Find references to a C# symbol across the workspace using Roslyn semantic analysis (the same engine as Visual ' +
    'Studio). Unlike grep, results are semantically exact: overloads, partial classes, generics and using-aliases ' +
    'are resolved, and comment/string mentions are excluded. Code references only — serialized references in ' +
    'scenes, prefabs and assets are not visible here; use unity_yaml_search, unity_yaml_read or code_diagnostics for ' +
    'those.\n\n' +
    ANALYSIS_SETUP,
  parameters: {
    project_path: PROJECT_PATH,
    file_path: FILE_PATH,
    symbol: SYMBOL,
    line: LINE_HINT,
    include_declaration: {
      type: 'boolean',
      description: 'Include the declaration itself in the results. Default false.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        count: { type: 'integer' },
        locations: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const root = projectRootFor(args, exec)
    return runQuery(async (note) => {
      const result = await findReferences(root, {
        filePath: args.file_path,
        symbol: args.symbol,
        line: args.line,
        includeDeclaration: args.include_declaration === true,
        signal: exec.signal,
      })
      return note({
        text: formatReferences(args.symbol, result, { includeDeclaration: args.include_declaration === true }),
        count: result.locations.length,
        locations: result.locations,
      })
    })
  },
}

// ─── code_hover ─────────────────────────────────────────────────────────────

const codeHover = {
  name: 'code_hover',
  description:
    'Get the exact signature, type and XML documentation of a C# symbol via Roslyn — what an IDE shows on hover. ' +
    'Use it to confirm parameters, overloads and the return type before writing a call instead of guessing from ' +
    'memory; works for symbols from Unity assemblies and packages too.\n\n' +
    ANALYSIS_SETUP,
  parameters: {
    project_path: PROJECT_PATH,
    file_path: FILE_PATH,
    symbol: SYMBOL,
    line: LINE_HINT,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' }, contents: { type: 'string' } },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const root = projectRootFor(args, exec)
    return runQuery(async (note) => {
      const result = await hover(root, { filePath: args.file_path, symbol: args.symbol, line: args.line, signal: exec.signal })
      return note({ text: formatHover(args.symbol, result), contents: result.contents })
    })
  },
}

// ─── code_diagnostics ───────────────────────────────────────────────────────

const codeDiagnostics = {
  name: 'code_diagnostics',
  description:
    'Read Roslyn compiler and analyzer diagnostics for Unity-managed C# under Assets/ or Packages/. This validates ' +
    'source without applying changes or reloading Unity, so it answers "did I just break the build" in a second ' +
    'instead of waiting for a Unity compile.\n\n' +
    'File scope is fast; workspace scope catches cross-file errors but its first call waits for the server to warm ' +
    'its caches. Reports compiler errors plus Roslyn and Unity analyzers.\n\n' +
    'After the diagnostics it also reports what Roslyn cannot see, as upstream does: string references that compile ' +
    'but fail at run time (tags, layers, build scenes, Resources paths, legacy Input axes) and [SerializeReference] ' +
    'types whose stored identity no longer names a type. The second needs an asset index, which unity_asset_search ' +
    'builds; a project that has never been scanned simply omits that section.\n\n' +
    ANALYSIS_SETUP,
  parameters: {
    project_path: PROJECT_PATH,
    file_path: {
      type: 'string',
      description:
        'Workspace-relative or absolute path to a Unity-managed .cs file under Assets/ or Packages/. Omit to query ' +
        'the whole workspace.',
    },
    scope: {
      type: 'string',
      enum: ['file', 'workspace'],
      description: "Default: 'file' when file_path is given, otherwise 'workspace'.",
    },
    min_severity: {
      type: 'string',
      enum: SEVERITIES,
      description: "'warning' (the default) reports errors and warnings; 'hint' reports everything.",
    },
    max_results: { type: 'integer', description: 'Maximum number of diagnostics to return (1..400, default 100).' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        scope: { type: 'string' },
        errors: { type: 'integer' },
        warnings: { type: 'integer' },
        total: { type: 'integer' },
        // Appended to `text` by `formatDiagnostics`, so the two stay in one
        // string for the model and separately inspectable for a client that
        // wants them apart. Same split upstream keeps in its structured result.
        project_refs: { type: 'string' },
        managed_types: { type: 'string' },
        member: { type: 'string' },
        providers_ready: { type: 'boolean' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: renderDiagnostics(value) }],
  },
  async execute(args, exec) {
    // An out-of-range value is refused rather than silently treated as the
    // default: asking for 'Warning' and getting an error-only list back would
    // hide the answer without saying so (upstream rejects these the same way).
    // Validated before the project is resolved so a typo is answered as a typo.
    if (args.scope !== undefined && args.scope !== 'file' && args.scope !== 'workspace') {
      return {
        text: `Error: scope must be 'file' or 'workspace' (got \`${String(args.scope)}\`).`,
        scope: 'workspace',
        errors: 0,
        warnings: 0,
        total: 0,
      }
    }
    if (args.min_severity !== undefined && !SEVERITIES.includes(args.min_severity)) {
      return {
        text: `Error: min_severity must be one of ${SEVERITIES.join(', ')} (got \`${String(args.min_severity)}\`).`,
        scope: args.scope ?? 'workspace',
        errors: 0,
        warnings: 0,
        total: 0,
      }
    }
    const root = projectRootFor(args, exec)
    const filePath = String(args.file_path ?? '').trim()
    const scope = args.scope === 'workspace' || (!args.scope && !filePath) ? 'workspace' : 'file'
    if (scope === 'file' && !filePath) {
      return {
        text: 'Error: scope "file" requires file_path (omit both to query the whole workspace).',
        scope,
        errors: 0,
        warnings: 0,
        total: 0,
      }
    }
    const minSeverity = args.min_severity ?? 'warning'
    return runQuery(async (note) => {
      const result = scope === 'workspace'
        ? await workspaceDiagnostics(root, { signal: exec.signal })
        : await fileDiagnostics(root, { filePath, signal: exec.signal })
      const text = formatDiagnostics(result, { minSeverity, maxResults: args.max_results })
      const threshold = severityRank(minSeverity)
      const visible = result.diagnostics.filter((entry) => entry.severity <= threshold)
      return note({
        text,
        scope,
        errors: visible.filter((entry) => entry.severity === 1).length,
        warnings: visible.filter((entry) => entry.severity === 2).length,
        total: visible.length,
        project_refs: result.projectRefs ? formatProjectRefsSection(result.projectRefs) : '',
        managed_types: result.managedTypes ?? '',
        member: result.member ?? null,
        providers_ready: result.providersReady !== false,
      })
    })
  },
}

/**
 * The model-facing text for `code_diagnostics`.
 *
 * `formatDiagnostics` already appends the string-reference and
 * [SerializeReference] sections, so the primary text is complete on its own.
 * When a result carries those sections as separate fields and the text does not
 * contain them (a caller that formatted without them), they are appended here
 * rather than dropped — the previous render forwarded `text` only, which is how
 * a section the tool had computed never reached the model.
 */
export function renderDiagnostics(value) {
  const text = String(value?.text ?? '')
  const missing = [value?.project_refs, value?.managed_types]
    .filter((section) => typeof section === 'string' && section.trim() !== '')
    .filter((section) => !text.includes(section))
  return missing.length > 0 ? `${text}${missing.join('')}` : text
}

/** Every C# analysis tool, in registration order. */
export const csharpToolDefinitions = [
  codeSymbolSearch,
  codeGotoDefinition,
  codeFindReferences,
  codeHover,
  codeDiagnostics,
]

/** Names the C# tools register under. */
export const csharpToolNames = csharpToolDefinitions.map((definition) => definition.name)