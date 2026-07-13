import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  expectedRuntimeAssetDigest,
  githubAssetDigest,
  verifyRuntimeAssetBytes,
} from './runtime-asset-integrity.mjs'

const bytes = Buffer.from('trusted-runtime')
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const lock = {
  schemaVersion: 1,
  components: {
    codex: {
      version: '1.2.3',
      targets: {
        'win32-x64': {
          'codex.exe': digest,
        },
      },
    },
  },
}

test('requires exact component version, target, asset, and bytes', () => {
  const expected = expectedRuntimeAssetDigest(lock, {
    component: 'codex',
    version: '1.2.3',
    target: 'win32-x64',
    assetName: 'codex.exe',
  })
  assert.equal(expected, digest)
  assert.doesNotThrow(() =>
    verifyRuntimeAssetBytes(bytes, expected, 'codex.exe'),
  )
  assert.throws(
    () => verifyRuntimeAssetBytes(Buffer.from('changed'), expected, 'codex.exe'),
    /SHA-256 mismatch/,
  )
  assert.throws(
    () =>
      expectedRuntimeAssetDigest(lock, {
        component: 'codex',
        version: '1.2.4',
        target: 'win32-x64',
        assetName: 'codex.exe',
      }),
    /does not pin/,
  )
})

test('accepts only GitHub SHA-256 asset digests', () => {
  assert.equal(githubAssetDigest({ name: 'codex.exe', digest }), digest)
  assert.throws(
    () => githubAssetDigest({ name: 'codex.exe', digest: null }),
    /no SHA-256 digest/,
  )
})
