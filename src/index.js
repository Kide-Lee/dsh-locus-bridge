// DSH entry (Cordis plugin).
//
// Two ways to use the package:
//   - Default runtime: `ctx.tools` is the real DSH registry, so the definitions
//     below are registered directly (defineTool() returns a plain object; the
//     registry validates each `parameters` schema against the supported JSON
//     Schema subset and feeds it into the model-facing tool catalog).
//   - If a future DSH requires `defineTool()` wrapping, call
//     `registerLocusTools(defineTool)` and `apply(ctx)` with the returned list.
//
// Tool bodies live in ./tools.js (Unity broker tools) and ./csharp/tools.js
// (Roslyn semantic analysis); only this module touches the host context.
//
// The C# tools are a separate feature plane, not an extension of the Unity
// tools: they own .NET child processes and ~90 MB of downloaded assets, and
// none of that must load, run, or fail for a session that only uses Unity. They
// are therefore registered behind `DSH_LOCUS_CSHARP`, and their teardown is a
// separate effect so a failing Unity pool cannot take the language servers down
// (or the reverse).

import { toolDefinitions, parameterSpecs, shutdownPool, attachHost } from './tools.js'
import { csharpToolDefinitions } from './csharp/tools.js'
import { shutdownCsharpPool } from './csharp/lsp-pool.js'
import { registerAssetRoutes } from './sidebar/routes.js'

export const name = 'dsh-locus-bridge'
/** Services this plugin consumes (the tool registry). */
export const inject = ['tools']

let pending = null

/**
 * Whether the C# analysis tools are registered.
 *
 * Default on: the tools are inert until `code_analysis action:"install"`, so
 * exposing them costs one catalog line each and makes the feature discoverable.
 * `DSH_LOCUS_CSHARP=0` removes them entirely for a profile that must not carry
 * the surface (or where no .NET runtime can ever exist).
 */
export function csharpEnabled(env = process.env) {
  const value = String(env.DSH_LOCUS_CSHARP ?? '').trim().toLowerCase()
  return !(value === '0' || value === 'off' || value === 'false' || value === 'no')
}

/** Every definition this plugin registers, in order. */
export function allToolDefinitions(env = process.env) {
  return csharpEnabled(env) ? [...toolDefinitions, ...csharpToolDefinitions] : [...toolDefinitions]
}

/**
 * Wrap the shared definitions with `defineTool` (drop-in compatible with
 * `@deepseek-ai/dsh-tools`). Returns the wrapped definitions.
 */
export function registerLocusTools(defineTool, env = process.env) {
  // Parameters are plain JSON (not DSL references) because the same objects
  // are validated by scripts/dump-tools.mjs; defineTool compiles both shapes.
  pending = allToolDefinitions(env).map((raw) => defineTool({ ...raw, parameters: parameterSpecs(raw) }))
  return pending
}

/**
 * Attach the Locus tools to a DSH context.
 * @param ctx - context exposing `ctx.tools.register`, `ctx.get` and `ctx.effect`.
 */
export function apply(ctx) {
  // A few tool bodies need Host services at call time (the capture tool asks
  // `attachments` to carry the image itself). They read them off this handle,
  // exactly as `read_image` closes over its own `ctx`.
  attachHost(ctx)
  for (const definition of pending ?? allToolDefinitions()) ctx.tools.register(definition)
  ctx.effect(() => () => shutdownPool().catch(() => {}))
  if (csharpEnabled()) {
    ctx.effect(() => () => shutdownCsharpPool().catch(() => {}))
  }
  // The right-Sidebar asset surface mounts only where a Web Host exists.
  // `ctx.inject` waits for the services instead of requiring them, so the same
  // entry point serves a CLI/TUI session (no `webServer`, no routes, no
  // failure) and `dsh web` (routes mounted, tab type available). Without a
  // `connection` there is no browser-trust fence, and serving Unity writes
  // unfenced would let any page reach the editor — so both are required.
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    registerAssetRoutes(webCtx)
  })
}
