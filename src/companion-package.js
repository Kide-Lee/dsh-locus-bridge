// The DSH-side editor extension package that is installed beside the Locus
// Unity package.
//
// Why a second package instead of editing the payload: `payload/locus_unity/`
// is a generated copy of upstream's package (`npm run sync:payload`), and
// `npm run check:payload` fails the build if it diverges. Everything this
// repository adds to the *editor* therefore lives here, is original code under
// this repository's licence, and reaches the bridge through one reflected entry
// point (`Locus.LocusBridge.RegisterExtensionMessageHandler`) instead of a
// project reference — see docs/internal/contracts.md.
//
// Installed layout: <project>/Packages/com.locus.dsh-bridge/
//   package.json
//   Editor/Locus.DshBridge.Editor.asmdef
//   Editor/DshBridgeBootstrap.cs      registration fan-out (this file's siblings)
//   Editor/LocusReflection.cs         reflected bridge entry point
//   Editor/<Feature>/…                one directory per capability

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package folder name Unity sees under `Packages/`. */
export const COMPANION_PACKAGE_NAME = 'com.locus.dsh-bridge'

/** Source directory of the companion package inside this npm package. */
export const COMPANION_PACKAGE_SOURCE = fileURLToPath(
  new URL('../packages/unity-bridge/', import.meta.url),
)

/** Files required at a fixed path in every build of the companion package. */
export const COMPANION_REQUIRED_FILES = Object.freeze([
  'package.json',
  'Editor/Locus.DshBridge.Editor.asmdef',
  'Editor/DshBridgeBootstrap.cs',
  'Editor/LocusReflection.cs',
])

/** Directories inside the companion package that must never be installed. */
export const COMPANION_SKIP_DIR_NAMES = Object.freeze(['obj', 'bin', '.tmp'])

/**
 * Whether a project already carries the companion package.
 *
 * `setup.js` uses this to report the three states a project can be in: Locus
 * package only, both, or neither. It deliberately does not read the manifest
 * version: a hand-edited package that still compiles should not be reported as
 * missing, and the plugin upgrades it by replacing the directory wholesale.
 */
export function hasCompanionPackage(projectRoot) {
  return existsSync(join(projectRoot, 'Packages', COMPANION_PACKAGE_NAME, 'package.json'))
}
