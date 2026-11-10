#!/usr/bin/env node
// Install the bundled Locus Unity package into a project, plus the
// native-bridge marker, without going through a tool call.
//
// This is the executable half of the setup path: `unity_status` keeps the
// upstream tool schema, and when it finds no package it prints this command.
// The agent runs it with the ordinary shell tool, so the capability costs no
// schema context in projects that already work.
//
// Usage:
//   node scripts/install-unity-package.mjs <project>            # diagnose only
//   node scripts/install-unity-package.mjs <project> --install   # copy + marker
//   node scripts/install-unity-package.mjs <project> --install --marker-only

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatSetup, inspectSetup, installPackage, manifestDependency, writeMarker } from '../src/setup.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = { project: null, install: false, markerOnly: false }
  for (const arg of argv) {
    if (arg === '--install') options.install = true
    else if (arg === '--marker-only') options.markerOnly = true
    else if (!arg.startsWith('-')) options.project = options.project ?? arg
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const project = options.project ?? ROOT

  const before = inspectSetup(project)
  if (!options.install && !options.markerOnly) {
    const text = formatSetup(before)
    console.log(text || `Nothing to do: ${project} has the package, the broker and the marker.`)
    process.exit(before.ready ? 0 : 1)
  }

  const changed = []
  let installed = null
  if (!options.markerOnly && !before.package) {
    installed = installPackage(project)
    changed.push(`installed ${installed.relativeTarget} (v${installed.version})`)
    if (installed.keptSkills > 0) changed.push(`kept ${installed.keptSkills} file(s) under Editor/Skills`)
  }
  if (!before.marker.present) {
    const marker = writeMarker(project, before.endpoint)
    changed.push(`wrote ${marker.relativePath}`)
  }

  const after = inspectSetup(project)
  if (changed.length === 0) {
    console.log('Nothing to do: the package and marker are already in place.')
  } else {
    console.log(`${changed.join('; ')}.`)
    const dependency = manifestDependency(project)
    if (installed && dependency.declared) {
      console.log(
        `Note: Packages/manifest.json still lists "com.farlocus.locus": "${dependency.specifier}"; ` +
          'the embedded package wins, but drop that line to keep it unambiguous.',
      )
    }
    console.log('Close and reopen the Unity Editor, then run unity_status to confirm the connection.')
  }

  const remaining = formatSetup(after)
  if (remaining) {
    console.error(`\nStill blocking:\n${remaining}`)
    process.exit(1)
  }
}

main()
