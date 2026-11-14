// Minimal SemVer helpers for release preflight checks. This intentionally avoids a
// dependency so `node scripts/pack-release.mjs` works from a clean checkout.

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value) {
  const match = VERSION_RE.exec(String(value ?? '').trim())
  if (!match) throw new Error(`invalid semantic version: ${JSON.stringify(value)}`)
  const prerelease = match[4] ? match[4].split('.') : []
  for (const identifier of prerelease) {
    if (!identifier) throw new Error(`invalid semantic version prerelease: ${JSON.stringify(value)}`)
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const a = left[i]
    const b = right[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const diff = Number(a) - Number(b)
      if (diff !== 0) return diff < 0 ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return comparePrerelease(a.prerelease, b.prerelease)
}

export function normalizeVersion(value) {
  const parsed = parseVersion(value)
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  return parsed.prerelease.length > 0 ? `${base}-${parsed.prerelease.join('.')}` : base
}

function testComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator)
  if (!match) throw new Error(`invalid version comparator: ${JSON.stringify(comparator)}`)
  const operator = match[1] ?? '='
  const target = normalizeVersion(match[2])
  const result = compareVersions(version, target)
  switch (operator) {
    case '>=': return result >= 0
    case '>': return result > 0
    case '<=': return result <= 0
    case '<': return result < 0
    case '=': return result === 0
    default: throw new Error(`unsupported version operator: ${operator}`)
  }
}

export function satisfiesRange(version, range) {
  const normalized = normalizeVersion(version)
  const alternatives = String(range ?? '').split('||')
  return alternatives.some((alternative) => {
    const trimmed = alternative.trim()
    if (!trimmed) return false
    const comparators = trimmed.split(/\s+/)
    return comparators.every((comparator) => testComparator(normalized, comparator))
  })
}
