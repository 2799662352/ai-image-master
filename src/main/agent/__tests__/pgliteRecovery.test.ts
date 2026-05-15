/**
 * Pure-helper tests for the PGlite NODEFS recovery path.
 *
 * Why this file exists:
 *   PGlite #884 + #794 (open upstream, PR #892 in flight): when the dataDir
 *   wasn't cleanly closed (crash, force-quit, installer overwrite, dual
 *   instance), the next `PGlite.create(dataDir)` aborts inside Emscripten
 *   with `RuntimeError: Aborted()` deep in callMain. The user is then
 *   permanently bricked until they manually nuke %APPDATA%/.../pgdata.
 *
 *   We can't fix the upstream bug, but we can detect the abort and
 *   automatically move the corrupt dir aside, with a circuit breaker so a
 *   genuinely broken WASM binary doesn't trap us in a reset loop.
 *
 * @see https://github.com/electric-sql/pglite/issues/884
 * @see https://github.com/electric-sql/pglite/issues/794
 * @see https://github.com/electric-sql/pglite/pull/892
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isPgliteAbortedError,
  moveCorruptDataDir,
  recordResetAttempt,
  isResetAllowedNow,
  type ResetAttemptsState,
} from '../pgliteRecovery'

describe('isPgliteAbortedError', () => {
  it('matches the canonical Emscripten Aborted() message', () => {
    const err = new Error('PGlite worker error: Aborted(). Build with -sASSERTIONS for more info.')
    expect(isPgliteAbortedError(err)).toBe(true)
  })

  it('matches a RuntimeError surfacing through the worker IPC tunnel', () => {
    const err = new Error(
      'PGlite worker error: RuntimeError: Aborted(). Build with -sASSERTIONS for more info.\n' +
        '  at abort (...index.cjs:11:78179)\n' +
        '  at callMain (...index.cjs:13:270645)',
    )
    expect(isPgliteAbortedError(err)).toBe(true)
  })

  it('matches when the wasm-function abort frame is the only signal', () => {
    const err = new Error('worker exited (code 1). stderr: wasm-function[11285]:0x5b9c80\n  at callMain')
    expect(isPgliteAbortedError(err)).toBe(true)
  })

  it('does NOT match a port-conflict / EADDRINUSE error', () => {
    const err = new Error('listen EADDRINUSE: address already in use 127.0.0.1:5433')
    expect(isPgliteAbortedError(err)).toBe(false)
  })

  it('does NOT match a worker-bundle-missing preflight error', () => {
    const err = new Error(
      'PGlite worker bundle not found at C:\\app\\dist\\main\\pgliteWorker.js. ' +
        'Run `npm run build:pglite-worker`',
    )
    expect(isPgliteAbortedError(err)).toBe(false)
  })

  it('handles non-Error inputs without throwing', () => {
    expect(isPgliteAbortedError(null)).toBe(false)
    expect(isPgliteAbortedError(undefined)).toBe(false)
    expect(isPgliteAbortedError('Aborted()')).toBe(true) // bare string still detected
    expect(isPgliteAbortedError({ message: 'Aborted()' })).toBe(true)
  })
})

describe('moveCorruptDataDir', () => {
  let tmpRoot: string
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-recover-'))
  })
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('renames the live dataDir to a timestamped backup and returns the new path', () => {
    const dataDir = path.join(tmpRoot, 'pgdata')
    fs.mkdirSync(dataDir)
    fs.writeFileSync(path.join(dataDir, 'postmaster.pid'), 'fake')

    const fixedNow = new Date('2026-05-14T03:14:15.926Z')
    const backup = moveCorruptDataDir({ dataDir, now: () => fixedNow })

    expect(backup).not.toBeNull()
    expect(backup!).toContain('pgdata.corrupted-')
    expect(backup!).toContain('2026-05-14T03-14-15')
    // Original dir is gone
    expect(fs.existsSync(dataDir)).toBe(false)
    // Backup exists with the original contents
    expect(fs.existsSync(backup!)).toBe(true)
    expect(fs.readFileSync(path.join(backup!, 'postmaster.pid'), 'utf8')).toBe('fake')
  })

  it('returns null when the dataDir does not exist (nothing to move)', () => {
    const dataDir = path.join(tmpRoot, 'pgdata-missing')
    const backup = moveCorruptDataDir({ dataDir, now: () => new Date() })
    expect(backup).toBeNull()
  })

  it('produces unique backup names when called twice in the same millisecond', () => {
    const dataDir = path.join(tmpRoot, 'pgdata')
    fs.mkdirSync(dataDir)
    const fixedNow = new Date('2026-05-14T03:14:15.926Z')
    const backup1 = moveCorruptDataDir({ dataDir, now: () => fixedNow })
    fs.mkdirSync(dataDir)
    const backup2 = moveCorruptDataDir({ dataDir, now: () => fixedNow })
    expect(backup1).not.toBeNull()
    expect(backup2).not.toBeNull()
    expect(backup2).not.toBe(backup1)
  })
})

describe('reset circuit breaker', () => {
  let tmpRoot: string
  let markerPath: string
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-circuit-'))
    markerPath = path.join(tmpRoot, '.pglite-reset-attempts.json')
  })
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('allows reset when there are zero prior attempts', () => {
    const decision = isResetAllowedNow({
      markerPath,
      now: () => new Date('2026-05-14T12:00:00Z'),
      maxResets: 4,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.recentResets).toBe(0)
  })

  it('allows reset when prior attempts are outside the rolling window', () => {
    const oldState: ResetAttemptsState = {
      attempts: [
        new Date('2026-05-10T12:00:00Z').toISOString(), // > 24h before now
      ],
    }
    fs.writeFileSync(markerPath, JSON.stringify(oldState), 'utf8')

    const decision = isResetAllowedNow({
      markerPath,
      now: () => new Date('2026-05-14T12:00:00Z'),
      maxResets: 4,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.recentResets).toBe(0)
  })

  it('blocks reset when maxResets reached inside the window', () => {
    const now = new Date('2026-05-14T12:00:00Z')
    const oldState: ResetAttemptsState = {
      attempts: [
        new Date('2026-05-14T01:00:00Z').toISOString(),
        new Date('2026-05-14T03:00:00Z').toISOString(),
        new Date('2026-05-14T05:00:00Z').toISOString(),
        new Date('2026-05-14T11:00:00Z').toISOString(),
      ],
    }
    fs.writeFileSync(markerPath, JSON.stringify(oldState), 'utf8')

    const decision = isResetAllowedNow({
      markerPath,
      now: () => now,
      maxResets: 4,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.recentResets).toBe(4)
  })

  it('recordResetAttempt persists timestamps and prunes outside-window entries', () => {
    const oldState: ResetAttemptsState = {
      attempts: [
        new Date('2026-05-10T12:00:00Z').toISOString(), // pruned (> window)
        new Date('2026-05-14T01:00:00Z').toISOString(), // kept
      ],
    }
    fs.writeFileSync(markerPath, JSON.stringify(oldState), 'utf8')

    const now = new Date('2026-05-14T12:00:00Z')
    recordResetAttempt({
      markerPath,
      now: () => now,
      windowMs: 24 * 60 * 60 * 1000,
    })

    const written = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as ResetAttemptsState
    expect(written.attempts).toHaveLength(2) // pruned + new
    expect(written.attempts).toContain(now.toISOString())
    expect(written.attempts).toContain(new Date('2026-05-14T01:00:00Z').toISOString())
    expect(written.attempts).not.toContain(new Date('2026-05-10T12:00:00Z').toISOString())
  })

  it('survives a missing or unreadable marker file (treats as zero attempts)', () => {
    // No file written
    const decision = isResetAllowedNow({
      markerPath,
      now: () => new Date(),
      maxResets: 4,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(decision.allowed).toBe(true)
    expect(decision.recentResets).toBe(0)

    // Corrupt JSON
    fs.writeFileSync(markerPath, 'not-json{{{', 'utf8')
    const decision2 = isResetAllowedNow({
      markerPath,
      now: () => new Date(),
      maxResets: 4,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(decision2.allowed).toBe(true)
    expect(decision2.recentResets).toBe(0)
  })

  it('recordResetAttempt creates the marker file when it does not exist', () => {
    expect(fs.existsSync(markerPath)).toBe(false)
    const now = new Date('2026-05-14T12:00:00Z')
    recordResetAttempt({
      markerPath,
      now: () => now,
      windowMs: 24 * 60 * 60 * 1000,
    })
    expect(fs.existsSync(markerPath)).toBe(true)
    const written = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as ResetAttemptsState
    expect(written.attempts).toEqual([now.toISOString()])
  })
})
