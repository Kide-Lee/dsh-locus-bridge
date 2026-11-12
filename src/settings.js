// User-facing feature switches for this plugin, and where they are stored.
//
// Three planes can be turned off independently:
//
//   unity     the ten `unity_*` broker tools
//   csharp    the `code_*` Roslyn tools (and their ~90 MB of downloaded assets)
//   preview   the right-Sidebar Unity asset tab and its `/locus/api/*` routes
//
// They are deliberately *additive* to the environment switches, not a
// replacement: `DSH_LOCUS_CSHARP=0` is a deployment-level statement ("this
// profile must never carry the surface") that a user must not be able to
// undo from the UI, while this file records a user preference inside that
// envelope. `resolveFeatures()` intersects the two.
//
// Storage is one JSON document beside the other Locus caches, not inside the
// profile's `cordis.patch.yml`: the patch layer is configuration the user edits
// by hand, and a settings page rewriting it would fight every manual edit and
// every `plugin_manager` write. A small owned file also keeps the plugin usable
// in a Host with no `settings` service mounted at all.
//
// Why a module-level cache: the tool registry re-reads the switches whenever
// they change, and the web routes read them per request; a `statSync` on a
// small file is cheap, but parsing it per request would not be. The cache is
// keyed by path and invalidated by (mtimeMs, size), so an edit between two runs
// (or a test that writes the file directly) is still observed.

import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The feature planes a user may switch off, in UI order. */
export const FEATURE_KEYS = Object.freeze(['unity', 'csharp', 'preview'])

/**
 * Default switches.
 *
 * Everything is on: the tools are inert until a Unity editor connects or
 * `code_analysis action:"install"` runs, so a default-off plugin would only
 * make the feature invisible. `preview` is on because the tab is how a Unity
 * project becomes browsable from the conversation.
 */
export const DEFAULT_FEATURES = Object.freeze({ unity: true, csharp: true, preview: true })

/**
 * Secondary preferences that the same page owns.
 *
 * `frameCache` is the one non-feature switch worth a control: a rendered
 * preview frame is persisted under `Library/Locus/asset-preview-cache` (a
 * directory inside the user's Unity project), so a project that must not grow
 * files from a browser session needs a way to say so.
 */
export const DEFAULT_PREFERENCES = Object.freeze({ frameCache: true })

/** The keys `preferences` may carry; the route rejects anything else. */
export const PREFERENCE_KEYS = Object.freeze(Object.keys(DEFAULT_PREFERENCES))

/** Environment variable that relocates the store (tests, air-gapped setups). */
export const HOME_ENV = 'DSH_LOCUS_BRIDGE_HOME'

/** File name inside the bridge home. */
export const SETTINGS_FILE = 'settings.json'

const SCHEMA_VERSION = 1

/**
 * The directory this plugin owns for its own state.
 *
 * Mirrors `assetsRoot()` in `src/csharp/assets.js`: the platform's per-user data
 * directory, with a `locus/` grouping so every Locus cache sits together.
 */
export function bridgeHome(env = process.env) {
  if (env?.[HOME_ENV]) return env[HOME_ENV]
  const base =
    process.platform === 'win32'
      ? env?.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : env?.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'locus', 'locus-bridge')
}

/** Absolute path of the settings document. */
export function settingsPath(env = process.env) {
  return join(bridgeHome(env), SETTINGS_FILE)
}

function freezeSettings(value) {
  return Object.freeze({
    version: SCHEMA_VERSION,
    features: Object.freeze({ ...value.features }),
    preferences: Object.freeze({ ...value.preferences }),
  })
}

/** The all-default document (a fresh value on every call, never shared mutable state). */
export function defaultSettings() {
  return freezeSettings({ features: DEFAULT_FEATURES, preferences: DEFAULT_PREFERENCES })
}

/**
 * Coerce anything a user or a hand-edited file may contain into the exact
 * document shape.
 *
 * Unknown keys are dropped rather than rejected: the file is user-editable and
 * a stale key from an older version must not cost the whole document. A
 * non-boolean switch falls back to its default instead of being coerced, so a
 * typo (`"off"`, `0`) cannot silently disable a plane.
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const featuresIn = source.features && typeof source.features === 'object' ? source.features : {}
  const preferencesIn = source.preferences && typeof source.preferences === 'object' ? source.preferences : {}
  const features = {}
  for (const key of FEATURE_KEYS) {
    features[key] = typeof featuresIn[key] === 'boolean' ? featuresIn[key] : DEFAULT_FEATURES[key]
  }
  const preferences = {}
  for (const key of Object.keys(DEFAULT_PREFERENCES)) {
    preferences[key] = typeof preferencesIn[key] === 'boolean' ? preferencesIn[key] : DEFAULT_PREFERENCES[key]
  }
  return freezeSettings({ features, preferences })
}

/** path → { mtimeMs, size, value } */
const cache = new Map()

/**
 * Read the stored document, falling back to the defaults.
 *
 * A missing file is the normal first-run state, not an error. An unreadable or
 * malformed file is reported once through `onWarning` and then treated as
 * "defaults": refusing to register any tool because a JSON file was truncated
 * would be a worse outcome than losing a preference.
 */
export function readSettings(env = process.env, { onWarning = null } = {}) {
  const path = settingsPath(env)
  let info
  try {
    info = statSync(path)
  } catch {
    cache.delete(path)
    return defaultSettings()
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    onWarning?.(`cannot read ${path}: ${error?.message ?? error}`)
    return defaultSettings()
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    onWarning?.(`ignoring malformed ${path}: ${error?.message ?? error}`)
    return defaultSettings()
  }
  const value = normalizeSettings(parsed)
  cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value })
  return value
}

/** Replace the cached value after a successful write. */
function remember(path, value) {
  try {
    const info = statSync(path)
    cache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value })
  } catch {
    cache.delete(path)
  }
}

const listeners = new Set()

/**
 * Observe settings changes.
 *
 * Only changes made through {@link saveSettings} are observed; a file edited by
 * hand is picked up by the next {@link readSettings} but never notifies. That is
 * intentional: the notification drives re-registration, and re-reading the file
 * on a timer to catch external edits would be a polling loop for an event the
 * user performs at most once.
 */
export function onSettingsChanged(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Merge a patch into the stored document, persist it, and notify listeners.
 *
 * Merge is shallow per section: `{ features: { csharp: false } }` leaves
 * `unity` and `preview` alone. The write is atomic (temporary file + rename) so
 * a crash cannot leave a half-written document that the next read would have to
 * treat as malformed.
 *
 * @returns the normalized document that is now stored.
 */
export function saveSettings(patch, env = process.env) {
  const current = readSettings(env)
  const next = normalizeSettings({
    features: { ...current.features, ...(patch?.features ?? {}) },
    preferences: { ...current.preferences, ...(patch?.preferences ?? {}) },
  })
  const path = settingsPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify({ version: SCHEMA_VERSION, ...next }, null, 2)}\n`, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temporary file may not exist; the original error is the one to report.
    }
    throw error
  }
  remember(path, next)
  for (const listener of [...listeners]) {
    try {
      listener(next)
    } catch {
      // A listener that throws must not stop the others or the write.
    }
  }
  return next
}

/**
 * The effective switches for this process.
 *
 * `DSH_LOCUS_CSHARP=0` (and friends, see `csharpEnabled`) is a hard deployment
 * switch: a stored `csharp: true` cannot override it. The returned object is
 * the stored document with that intersection applied, so callers do not have to
 * repeat the rule.
 */
export function resolveFeatures(settings, env = process.env) {
  const value = String(env?.DSH_LOCUS_CSHARP ?? '').trim().toLowerCase()
  const csharpForcedOff = value === '0' || value === 'off' || value === 'false' || value === 'no'
  return Object.freeze({
    ...settings.features,
    csharp: settings.features.csharp && !csharpForcedOff,
  })
}

/** Drop the read cache (tests only: a fixture rewrites the file in place). */
export function __resetSettingsCacheForTest() {
  cache.clear()
  listeners.clear()
}