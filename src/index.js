// DSH entry (Cordis plugin).
//
// Tools are authored in ./tools.js (Unity broker tools) and ./csharp/tools.js
// (Roslyn semantic analysis); only this module touches the host context.
//
// Registration MUST go through `toRegistryDefinition()`: the authored
// `parameters` is an *implicit property map* (`{ code: { type: 'string' } }`),
// and the registry hands a definition's `parameters` to the model verbatim as
// `input_schema` without compiling it. Registering the map directly therefore
// declares no properties at all — every call arrives as `{}` and the required
// checks never run. See src/schema.js.
//
// The C# tools are a separate feature plane, not an extension of the Unity
// tools: they own .NET child processes and ~90 MB of downloaded assets, and
// none of that must load, run, or fail for a session that only uses Unity. They
// are therefore registered behind `DSH_LOCUS_CSHARP`, and their teardown is a
// separate effect so a failing Unity pool cannot take the language servers down
// (or the reverse).

import { toolDefinitions, parameterSpecs, shutdownPool, attachHost } from './tools.js'
import { attachWorkingDirectory } from './args.js'
import { csharpToolDefinitions } from './csharp/tools.js'
import { shutdownCsharpPool } from './csharp/lsp-pool.js'
import { registerAssetRoutes } from './sidebar/routes.js'
import { toRegistryDefinition } from './schema.js'

export const name = 'dsh-locus-bridge'
/**
 * Services this plugin consumes.
 *
 * `workingDirectory` is required, not optional: tool bodies only ever see a
 * tool `exec`, which has no service accessors, so without this injection the
 * project resolution can only read the Session's frozen `header.cwd` and a
 * mid-session `working_directory` change never applies. `apply()` registers the
 * service with `src/args.js` so every Unity tool resolves against the live
 * directory.
 */
export const inject = ['tools', 'workingDirectory']

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
 * The definitions this plugin hands to `ctx.tools.register`: one per authored
 * tool, with `parameters` and `output.schema` compiled to raw JSON Schema.
 *
 * Registration must use these, not the authored definitions: the registry
 * forwards `parameters` to the model as `input_schema` without compiling it.
 */
export function registryDefinitions(env = process.env) {
  return allToolDefinitions(env).map((raw) => toRegistryDefinition({ ...raw, parameters: parameterSpecs(raw) }))
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
  // Tool bodies receive a tool `exec`, never this context, so the live
  // Session directory has to be registered rather than read off `exec`.
  attachWorkingDirectory(ctx.workingDirectory)
  for (const definition of registryDefinitions()) ctx.tools.register(definition)
  ctx.effect(() => () => {
    attachWorkingDirectory(null)
    return shutdownPool().catch(() => {})
  })
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
