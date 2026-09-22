/**
 * Unit tests for marketplace-versioning helpers.
 * Run: node --test scripts/lib/marketplace-versioning.test.mjs
 */
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  bumpPatch,
  decideVersion,
  nextStateFromDecisions,
  pluginContentSignature,
  stripVersion,
} from './marketplace-versioning.mjs'

async function writePlugin(root, eol, extra = '') {
  const dir = path.join(root, 'p')
  await fs.mkdir(path.join(dir, '.codex-plugin'), { recursive: true })
  await fs.mkdir(path.join(dir, 'skills', 's'), { recursive: true })
  const body = ['---', 'name: s', 'description: d', '---', '', '# S', extra].join(eol)
  await fs.writeFile(path.join(dir, 'skills', 's', 'SKILL.md'), body, 'utf8')
  await fs.writeFile(
    path.join(dir, '.codex-plugin', 'plugin.json'),
    ['{', '  "name": "p",', '  "version": "1.0.0"', '}'].join(eol),
    'utf8',
  )
  await fs.writeFile(path.join(dir, 'logo.bin'), Buffer.from([0x0d, 0x0a, 0x00, 0x0d, 0x0a]))
  return dir
}

test('pluginContentSignature ignores CRLF vs LF in text files (autocrlf checkouts must not auto-bump)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mp-sig-'))
  try {
    const lf = await pluginContentSignature(await writePlugin(path.join(root, 'lf'), '\n'))
    const crlf = await pluginContentSignature(await writePlugin(path.join(root, 'crlf'), '\r\n'))
    assert.equal(lf, crlf)
    // Real content edits still change it.
    const edited = await pluginContentSignature(await writePlugin(path.join(root, 'edited'), '\n', 'one more line'))
    assert.notEqual(lf, edited)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

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
