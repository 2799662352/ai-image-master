/**
 * Unit tests for marketplace-versioning helpers.
 * Run: node --test scripts/lib/marketplace-versioning.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bumpPatch, decideVersion, nextStateFromDecisions, stripVersion } from './marketplace-versioning.mjs'

test('bumpPatch increments patch', () => {
  assert.equal(bumpPatch('1.0.9'), '1.0.10')
  assert.equal(bumpPatch('1.0.0'), '1.0.1')
  assert.equal(bumpPatch('2.3.4'), '2.3.5')
})

test('bumpPatch falls back for malformed input', () => {
  assert.equal(bumpPatch(''), '1.0.1')
  assert.equal(bumpPatch(undefined), '1.0.1')
  assert.equal(bumpPatch('abc'), '1.0.1')
})

test('stripVersion removes version, tolerates junk', () => {
  assert.equal(stripVersion('{"version":"1.0.0","name":"x"}'), '{"name":"x"}')
  assert.equal(stripVersion('not json'), 'not json')
})

test('decideVersion: no baseline → seed at current version', () => {
  const d = decideVersion({ name: 'p', version: '1.0.3' }, 'SIG', undefined)
  assert.equal(d.action, 'seed')
  assert.equal(d.version, '1.0.3')
})

test('decideVersion: unchanged content → keep version', () => {
  const d = decideVersion({ name: 'p', version: '1.0.3' }, 'SIG', { sig: 'SIG', version: '1.0.3' })
  assert.equal(d.action, 'unchanged')
  assert.equal(d.version, '1.0.3')
})

test('decideVersion: changed content, no manual bump → auto-bump', () => {
  const d = decideVersion({ name: 'p', version: '1.0.3' }, 'NEW', { sig: 'OLD', version: '1.0.3' })
  assert.equal(d.action, 'auto-bump')
  assert.equal(d.version, '1.0.4')
})

test('decideVersion: changed content + author already bumped → respect, no double bump', () => {
  const d = decideVersion({ name: 'p', version: '1.1.0' }, 'NEW', { sig: 'OLD', version: '1.0.3' })
  assert.equal(d.action, 'manual')
  assert.equal(d.version, '1.1.0')
})

test('nextStateFromDecisions maps name → {sig,version}', () => {
  const state = nextStateFromDecisions([
    { name: 'a', sig: 'SA', version: '1.0.0' },
    { name: 'b', sig: 'SB', version: '2.0.1' },
  ])
  assert.deepEqual(state, {
    a: { sig: 'SA', version: '1.0.0' },
    b: { sig: 'SB', version: '2.0.1' },
  })
})
