// Archive extraction for the C# analysis assets.
//
// Two formats, both read in-process with `node:zlib` so the plugin keeps its
// zero-npm-dependency property:
//
//   * `.nupkg` — the Roslyn language server and Microsoft.Unity.Analyzers come
//     from NuGet, which is a ZIP whose payload sits under a `content/…` prefix;
//   * `.tar.gz` — the official .NET runtime archive on Linux/macOS. Windows
//     ships the same runtime as a ZIP.
//
// Only regular files and directories are materialized. Symbolic links, hard
// links and device nodes are skipped: the archives above contain device nodes
// on macOS (`./usr/lib/libc.dylib` style entries) and following them out of the
// destination would be an escape. Entry paths are rejected when they traverse
// (`..`) or are absolute, matching what the desktop extractor enforces.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

/** A malformed or unsupported archive. */
export class ArchiveError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ArchiveError'
  }
}

const ZIP_LOCAL_SIGNATURE = 0x04034b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_EOCD_MIN_BYTES = 22

/** Resolve one entry path under `destDir`, refusing escapes. */
function safeTarget(destDir, entryPath) {
  const cleaned = String(entryPath ?? '').replaceAll('\\', '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.endsWith('/')) return null
  const normalized = normalize(cleaned)
  if (normalized.startsWith('..') || normalized.includes(`..${sep}`) || /^[A-Za-z]:/.test(normalized)) {
    throw new ArchiveError(`archive entry escapes the destination: ${entryPath}`)
  }
  return join(destDir, normalized)
}

/** Central-directory entries of a ZIP buffer. */
function readZipEntries(buffer) {
  let eocd = -1
  const stop = Math.max(0, buffer.length - (ZIP_EOCD_MIN_BYTES + 0xffff))
  for (let offset = buffer.length - ZIP_EOCD_MIN_BYTES; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new ArchiveError('not a ZIP archive (no end-of-central-directory record)')

  const entryCount = buffer.readUInt16LE(eocd + 10)
  let cursor = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length) throw new ArchiveError('truncated ZIP central directory')
    if (buffer.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ArchiveError('corrupt ZIP central directory entry')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    entries.push({ name, flags, method, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Inflate one central-directory entry. */
function readZipEntry(buffer, entry) {
  const { localOffset } = entry
  if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new ArchiveError(`corrupt ZIP local header for ${entry.name}`)
  }
  const nameLength = buffer.readUInt16LE(localOffset + 26)
  const extraLength = buffer.readUInt16LE(localOffset + 28)
  const dataStart = localOffset + 30 + nameLength + extraLength
  // A streaming writer (NuGet does this) leaves the local header's sizes at
  // zero and puts the real values in the central directory, so the central
  // record is authoritative here.
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize)
  if (data.length !== entry.compressedSize) throw new ArchiveError(`truncated ZIP entry ${entry.name}`)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new ArchiveError(`unsupported ZIP compression method ${entry.method}`)
  try {
    const inflated = inflateRawSync(data)
    return inflated
  } catch (error) {
    throw new ArchiveError(`cannot inflate ZIP entry ${entry.name}: ${error.message}`)
  }
}

/**
 * Extract a ZIP buffer under `destDir`.
 *
 * @param {Buffer} buffer        archive bytes
 * @param {string} destDir       directory to write into (created)
 * @param {object} [options]
 * @param {string} [options.prefix] keep only entries starting with this prefix
 *                                  and strip it from the written path
 * @param {(relative: string) => boolean} [options.filter]
 * @returns {{ files: string[], skipped: number }}
 */
export function extractZip(buffer, destDir, { prefix = '', filter = null } = {}) {
  const entries = readZipEntries(buffer)
  const files = []
  let skipped = 0
  for (const entry of entries) {
    if (entry.flags & 0x1) {
      skipped += 1 // encrypted
      continue
    }
    if (prefix) {
      if (!entry.name.startsWith(prefix)) {
        skipped += 1
        continue
      }
      entry.name = entry.name.slice(prefix.length)
    }
    if (filter && !filter(entry.name)) {
      skipped += 1
      continue
    }
    const target = safeTarget(destDir, entry.name)
    if (!target) {
      skipped += 1
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readZipEntry(buffer, entry))
    files.push(entry.name)
  }
  return { files, skipped }
}

/** Read the octal size field of a ustar header. */
function tarSize(header) {
  const raw = header.subarray(124, 136).toString('ascii').replace(/[\0 ]+$/, '').trim()
  if (!raw) return 0
  const value = Number.parseInt(raw, 8)
  if (!Number.isFinite(value) || value < 0) throw new ArchiveError(`corrupt tar entry size: ${raw}`)
  return value
}

/**
 * Extract a gzip-compressed tar into `destDir`.
 *
 * Only regular files are written; links and device nodes are counted and
 * skipped, because the .NET runtime tarball carries macOS dylib symlinks that
 * must not be followed out of the directory.
 *
 * @returns {{ files: string[], skipped: number }}
 */
export function extractTarGz(buffer, destDir, { filter = null } = {}) {
  const tar = gunzipSync(buffer)
  const files = []
  let skipped = 0
  let cursor = 0
  while (cursor + 512 <= tar.length) {
    const header = tar.subarray(cursor, cursor + 512)
    if (header.every((byte) => byte === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const prefixField = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = prefixField ? `${prefixField}/${name}` : name
    const size = tarSize(header)
    const typeFlag = String.fromCharCode(header[156] || 0x30)
    const dataStart = cursor + 512
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new ArchiveError(`truncated tar entry ${fullName}`)
    cursor = dataStart + Math.ceil(size / 512) * 512

    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '5') {
      skipped += 1 // link, device, fifo, pax header…
      continue
    }
    if (typeFlag === '5') {
      const target = safeTarget(destDir, `${fullName}/`)
      if (target) mkdirSync(target, { recursive: true })
      continue
    }
    if (filter && !filter(fullName)) {
      skipped += 1
      continue
    }
    const target = safeTarget(destDir, fullName)
    if (!target) {
      skipped += 1
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, tar.subarray(dataStart, dataEnd))
    files.push(fullName)
  }
  return { files, skipped }
}

/** Extract by archive extension: `.zip`/`.nupkg` or `.tar.gz`/`.tgz`. */
export function extractArchive(buffer, destDir, { archiveName, prefix = '', filter = null } = {}) {
  const name = String(archiveName ?? '').toLowerCase()
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
    return extractTarGz(buffer, destDir, { filter })
  }
  return extractZip(buffer, destDir, { prefix, filter })
}