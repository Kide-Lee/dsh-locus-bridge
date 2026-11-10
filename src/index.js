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
// Tool bodies live in ./tools.js, the wire client in ./locus-client.js; only
// this module touches the host context.

import { toolDefinitions, parameterSpecs, shutdownPool, attachHost } from './tools.js'

export const name = 'dsh-locus-bridge'
/** Services this plugin consumes (the tool registry). */
export const inject = ['tools']

let pending = null

/**
 * Wrap the shared definitions with `defineTool` (drop-in compatible with
 * `@deepseek-ai/dsh-tools`). Returns the wrapped definitions.
 */
export function registerLocusTools(defineTool) {
  // Parameters are plain JSON (not DSL references) because the same objects
  // are validated by scripts/dump-tools.mjs; defineTool compiles both shapes.
  pending = toolDefinitions.map((raw) => defineTool({ ...raw, parameters: parameterSpecs(raw) }))
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
  for (const definition of pending ?? toolDefinitions) ctx.tools.register(definition)
  ctx.effect(() => () => shutdownPool().catch(() => {}))
}
