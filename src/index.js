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
import { onSettingsChanged, readSettings, resolveFeatures } from './settings.js'
import { createDomainSkillProvider } from './skills/provider.js'
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
 *
 * This is the *deployment* switch. The per-user switch lives in
 * `src/settings.js` and is intersected with it by {@link effectiveFeatures};
 * `DSH_LOCUS_CSHARP=0` always wins, because a profile that refuses the surface
 * must not be reversible from a settings page.
 */
export function csharpEnabled(env = process.env) {
  const value = String(env.DSH_LOCUS_CSHARP ?? '').trim().toLowerCase()
  return !(value === '0' || value === 'off' || value === 'false' || value === 'no')
}

/**
 * The switches that are actually in force: the stored user preferences
 * intersected with the deployment switches.
 */
export function effectiveFeatures(env = process.env) {
  return resolveFeatures(readSettings(env), env)
}

/** The Unity definitions, gated by the `unity` switch. */
export function unityDefinitions(env = process.env) {
  return effectiveFeatures(env).unity ? toolDefinitions : []
}

/** The C# definitions, gated by the `csharp` switch and the deployment switch. */
export function csharpDefinitions(env = process.env) {
  return effectiveFeatures(env).csharp ? csharpToolDefinitions : []
}

/** Every definition this plugin registers, in order. */
export function allToolDefinitions(env = process.env) {
  return [...unityDefinitions(env), ...csharpDefinitions(env)]
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

  // Tool registration is re-runnable so the settings page can switch a plane on
  // or off without restarting the Host: `syncTools()` disposes what it
  // registered last time and registers the current set. The registry disposer is
  // the same value `ctx.tools.register` returns, so there is no bookkeeping to
  // get wrong.
  //
  // Disposing a tool definition hides it from the model; it does not free what
  // the plane already allocated. Switching `csharp` off therefore also closes
  // the Roslyn servers, which is the difference between "hidden" and "off" for
  // a feature that can hold ~90 MB of on-disk assets and several .NET heaps.
  let toolDisposers = []
  let csharpWasEnabled = false
  const syncTools = () => {
    const features = effectiveFeatures()
    for (const dispose of toolDisposers) {
      try {
        dispose()
      } catch {
        // A registry that already dropped the entry is not an error here.
      }
    }
    toolDisposers = registryDefinitions().map((definition) => ctx.tools.register(definition))
    if (csharpWasEnabled && !features.csharp) {
      shutdownCsharpPool().catch(() => {})
    }
    csharpWasEnabled = features.csharp
    return toolDisposers.length
  }
  syncTools()

  // One listener is enough for both entry points: the settings route calls
  // `saveSettings`, which notifies every subscriber, so the route must NOT also
  // call `syncTools` directly or one save would re-register the whole catalog
  // twice. The route only needs to know whether the notification left the Host
  // in the new state, which it learns by re-reading the effective switches.
  const stopListening = onSettingsChanged(() => {
    try {
      syncTools()
    } catch (error) {
      // A failed re-registration must surface: the page said the switch took
      // effect. `console` is the only channel a plugin has that does not depend
      // on a service this plugin already failed to use.
      console.error(`[dsh-locus-bridge] could not apply the tool switches: ${error?.message ?? error}`)
    }
  })

  // The domain skills are a *model-facing* plane, not a tool plane: they are
  // contributed to `ctx.skills` as an in-memory provider (see
  // `src/skills/provider.js`) and never written into a workspace. There is no
  // master switch — each skill has its own boolean, and the provider exists only
  // while at least one of them is on. Turning one on or off disposes and
  // re-registers the provider, which invalidates the catalog, so
  // `dsh-tool-skill` appends the replacement list at the next model step instead
  // of waiting for a restart.
  //
  // `inject` rather than a required dependency: a composition without the skill
  // registry must still get every other plane.
  ctx.inject(['skills'], (skillCtx) => {
    let disposeProvider = null
    const syncSkills = () => {
      if (disposeProvider !== null) {
        const dispose = disposeProvider
        disposeProvider = null
        try {
          dispose()
        } catch {
          // A provider the registry already dropped is not an error here.
        }
      }
      const stored = readSettings()
      if (!Object.values(stored.skills).some(Boolean)) return
      disposeProvider = skillCtx.skills.registerProvider(
        () => createDomainSkillProvider({ enabled: stored.skills }),
      )
    }
    syncSkills()
    const stop = onSettingsChanged(syncSkills)
    skillCtx.effect(() => () => {
      stop()
      if (disposeProvider !== null) {
        const dispose = disposeProvider
        disposeProvider = null
        try {
          dispose()
        } catch {
          // Disposal during teardown is best effort.
        }
      }
    })
  })

  ctx.effect(() => () => {
    stopListening()
    for (const dispose of toolDisposers) {
      try {
        dispose()
      } catch {
        // Disposal during teardown is best effort.
      }
    }
    toolDisposers = []
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
  //
  // The routes are registered unconditionally even while `preview` is off: the
  // settings endpoint itself lives there, and turning the preview back on has to
  // reach a Host that never mounted routes. Each asset route refuses with
  // `feature_disabled` while the switch is off (see `previewOff`).
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    registerAssetRoutes(webCtx, {
      // The settings route reports a failure back to the page instead of
      // pretending the switch took effect. Re-registration itself is driven by
      // `onSettingsChanged` above; this only asserts that the process really is
      // in the state the page is about to display, and throws when it is not.
      onFeaturesChanged: (effective) => {
        const actual = effectiveFeatures()
        for (const key of Object.keys(effective)) {
          if (actual[key] !== effective[key]) {
            throw new Error(
              `the ${key} switch did not take effect (wanted ${effective[key]}, got ${actual[key]})`,
            )
          }
        }
      },
    })
  })
}
