import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compareVersions,
  normalizeVersion,
  satisfiesRange,
} from '../scripts/lib/semver.mjs'
import {
  evaluateDshCompatibility,
  evaluateLocusVersion,
} from '../scripts/pack-release.mjs'

test('release semver handles v prefixes, build metadata and prereleases', () => {
  assert.equal(normalizeVersion('v0.9.3'), '0.9.3')
  assert.equal(normalizeVersion('0.9.3+build.7'), '0.9.3')
  assert.equal(compareVersions('v0.9.3', '0.9.3'), 0)
  assert.equal(compareVersions('0.2.1-alpha.2', '0.2.1-alpha.10'), -1)
  assert.equal(compareVersions('0.2.1-alpha.2', '0.2.1-beta'), -1)
  assert.equal(compareVersions('0.2.1', '0.2.1-rc.1'), 1)
  assert.equal(compareVersions('0.3.0-0', '0.3.0'), -1)
  assert.equal(compareVersions('0.3.0-rc.1', '0.3.0-0'), 1)
})

test('release semver rejects malformed versions', () => {
  for (const value of ['', '1.2', '1.2.3.4', 'v1.2.3-', 'not-a-version']) {
    assert.throws(() => normalizeVersion(value), /invalid semantic version/)
  }
})

test('engines.dsh accepts the current line and rejects the next minor', () => {
  const range = '>=0.2.1-alpha.2 <0.3.0-0'
  for (const version of ['0.2.1-alpha.2', '0.2.2-rc.1', '0.2.1', '0.2.99']) {
    assert.equal(satisfiesRange(version, range), true, version)
  }
  for (const version of ['0.2.1-alpha.1', '0.3.0-0', '0.3.0', '1.0.0']) {
    assert.equal(satisfiesRange(version, range), false, version)
  }
})

test('Locus hard gate stops on any upstream mismatch', () => {
  assert.deepEqual(evaluateLocusVersion('0.9.3', 'v0.9.3'), {
    baseline: '0.9.3',
    latest: '0.9.3',
  })
  assert.throws(
    () => evaluateLocusVersion('0.9.3', 'v0.9.4'),
    /vendored Locus 0\.9\.3 is not the latest upstream release 0\.9\.4/,
  )
  assert.throws(
    () => evaluateLocusVersion('', 'v0.9.3'),
    /missing "locus\.version"/,
  )
})

test('DSH compatibility is a soft gate value', () => {
  assert.deepEqual(evaluateDshCompatibility('>=0.2.1-alpha.2 <0.3.0-0', '0.2.2-rc.1'), {
    status: 'compatible',
    latest: '0.2.2-rc.1',
    range: '>=0.2.1-alpha.2 <0.3.0-0',
  })
  assert.equal(
    evaluateDshCompatibility('>=0.2.1-alpha.2 <0.3.0-0', '0.3.0').status,
    'incompatible',
  )
  assert.equal(evaluateDshCompatibility(null, '0.2.2').status, 'unknown')
})
