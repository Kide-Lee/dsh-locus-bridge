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
  SEVERITIES,
  workspaceDiagnostics,
} from './queries.js'
import { assetsRoot } from './assets.js'
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

/** Run one query, turning setup problems into an actionable message. */
async function runQuery(action) {
  try {
    return await action()
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
    const symbols = await runQuery(() =>
      searchSymbols(root, { query: args.query, maxResults: args.max_results, signal: exec.signal }),
    )
    return { text: formatSymbols(args.query, symbols), count: symbols.length }
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
    const result = await runQuery(() =>
      gotoDefinition(root, {
        filePath: args.file_path,
        symbol: args.symbol,
        line: args.line,
        signal: exec.signal,
      }),
    )
    return { text: formatDefinition(args.symbol, result), locations: result.locations }
  },
}

// ─── code_find_references ───────────────────────────────────────────────────

const codeFindReferences = {
  name: 'code_find_references',
  description:
    'Find references to a C# symbol across the workspace using Roslyn semantic analysis (the same engine as Visual ' +
    'Studio). Unlike grep, results are semantically exact: overloads, partial classes, generics and using-aliases ' +
    'are resolved, and comment/string mentions are excluded. Code references only — serialized references in ' +
    'scenes, prefabs and assets are not visible here; use unity_code_usages for those.\n\n' +
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
    const result = await runQuery(() =>
      findReferences(root, {
        filePath: args.file_path,
        symbol: args.symbol,
        line: args.line,
        includeDeclaration: args.include_declaration === true,
        signal: exec.signal,
      }),
    )
    return {
      text: formatReferences(args.symbol, result, { includeDeclaration: args.include_declaration === true }),
      count: result.locations.length,
      locations: result.locations,
    }
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
    const result = await runQuery(() =>
      hover(root, { filePath: args.file_path, symbol: args.symbol, line: args.line, signal: exec.signal }),
    )
    return { text: formatHover(args.symbol, result), contents: result.contents }
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
    'its caches. Reports compiler errors plus Roslyn and Unity analyzers. Unlike the desktop client it does NOT also ' +
    'validate tags, layers, build-scene references, Resources paths or legacy Input axes — those need the desktop ' +
    'asset database.\n\n' +
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
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
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
    const minSeverity = SEVERITIES.includes(args.min_severity) ? args.min_severity : 'warning'
    const result = await runQuery(() =>
      scope === 'workspace'
        ? workspaceDiagnostics(root, { signal: exec.signal })
        : fileDiagnostics(root, { filePath, signal: exec.signal }),
    )
    const text = formatDiagnostics(result, { minSeverity, maxResults: args.max_results })
    const threshold = minSeverity === 'error' ? 1 : minSeverity === 'warning' ? 2 : minSeverity === 'info' ? 3 : 4
    const visible = result.diagnostics.filter((entry) => entry.severity <= threshold)
    return {
      text,
      scope,
      errors: visible.filter((entry) => entry.severity === 1).length,
      warnings: visible.filter((entry) => entry.severity === 2).length,
      total: visible.length,
    }
  },
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