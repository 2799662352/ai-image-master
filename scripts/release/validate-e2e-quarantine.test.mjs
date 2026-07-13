import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  validateQuarantineManifest,
} from './validate-e2e-quarantine.mjs'

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-quarantine-'))
  mkdirSync(path.join(root, 'e2e'))
  writeFileSync(
    path.join(root, 'e2e', 'flaky.e2e.ts'),
    "test('flaky flow @quarantine', async () => {})\n",
  )
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function validEntry() {
  return {
    testId: 'e2e/flaky.e2e.ts :: flaky flow @quarantine',
    reason: 'Windows CI window focus race reproduced in three runs',
    issue: 'https://github.com/owner/repo/issues/123',
    addedAt: '2026-07-13',
    expiresAt: '2026-07-27',
  }
}

test('accepts a registered, unexpired tagged test', (t) => {
  const root = fixture(t)
  assert.deepEqual(
    validateQuarantineManifest([validEntry()], {
      repoRoot: root,
      now: new Date('2026-07-14T00:00:00Z'),
    }),
    [validEntry()],
  )
})

test('rejects expired, duplicated, missing, and unregistered quarantine entries', (t) => {
  const root = fixture(t)
  assert.throws(
    () =>
      validateQuarantineManifest(
        [{ ...validEntry(), expiresAt: '2026-07-13' }],
        { repoRoot: root, now: new Date('2026-07-14T00:00:00Z') },
      ),
    /expired/i,
  )
  assert.throws(
    () =>
      validateQuarantineManifest([validEntry(), validEntry()], {
        repoRoot: root,
        now: new Date('2026-07-14T00:00:00Z'),
      }),
    /duplicate/i,
  )
  assert.throws(
    () =>
      validateQuarantineManifest(
        [{ ...validEntry(), testId: 'e2e/missing.e2e.ts :: missing @quarantine' }],
        { repoRoot: root, now: new Date('2026-07-14T00:00:00Z') },
      ),
    /does not exist/i,
  )
  assert.throws(
    () =>
      validateQuarantineManifest([], {
        repoRoot: root,
        now: new Date('2026-07-14T00:00:00Z'),
      }),
    /not registered/i,
  )
})
