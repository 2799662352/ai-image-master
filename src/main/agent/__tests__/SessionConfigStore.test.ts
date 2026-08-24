import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionConfigStore } from '../SessionConfigStore'
import { DEFAULT_CODEX_SESSION_CONFIG } from '../codexLaunch'
import type { CodexSessionConfig } from '../../../types/agent'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'session-config-store-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function storePath(): string {
  return path.join(tmpDir, 'agent-session-config.json')
}

function fullConfig(overrides: Partial<CodexSessionConfig>): CodexSessionConfig {
  return { ...DEFAULT_CODEX_SESSION_CONFIG, ...overrides }
}

describe('SessionConfigStore', () => {
  it('returns an empty override set when no file exists', () => {
    const store = new SessionConfigStore(tmpDir)
    expect(store.loadSync()).toEqual({})
  })

  it('persists only the diff against defaults and round-trips it', () => {
    const store = new SessionConfigStore(tmpDir)
    store.saveSync(fullConfig({
      personality: 'pragmatic',
      modelVerbosity: 'high',
    }))

    const reloaded = new SessionConfigStore(tmpDir).loadSync()
    expect(reloaded).toEqual({
      personality: 'pragmatic',
      modelVerbosity: 'high',
    })
  })

  it('persists the memoriesEnabled=false override and round-trips it', () => {
    const store = new SessionConfigStore(tmpDir)
    store.saveSync(fullConfig({ memoriesEnabled: false }))

    const reloaded = new SessionConfigStore(tmpDir).loadSync()
    expect(reloaded).toEqual({ memoriesEnabled: false })
  })

  it('never persists writableRoots (workspace-scoped, runtime-owned)', () => {
    const store = new SessionConfigStore(tmpDir)
    store.saveSync(fullConfig({
      webSearch: 'disabled',
      writableRoots: ['D:/some/workspace'],
    }))

    const reloaded = new SessionConfigStore(tmpDir).loadSync()
    expect(reloaded).toEqual({ webSearch: 'disabled' })
    expect(readFileSync(storePath(), 'utf8')).not.toContain('writableRoots')
  })

  it('removes the file when the config equals the defaults (reset semantics)', () => {
    const store = new SessionConfigStore(tmpDir)
    store.saveSync(fullConfig({ webSearch: 'disabled' }))
    expect(existsSync(storePath())).toBe(true)

    store.saveSync(fullConfig({}))
    expect(existsSync(storePath())).toBe(false)
    expect(store.loadSync()).toEqual({})
  })

  it('clearSync removes the persisted overrides', () => {
    const store = new SessionConfigStore(tmpDir)
    store.saveSync(fullConfig({ approvalPolicy: 'on-request' }))

    store.clearSync()
    expect(existsSync(storePath())).toBe(false)
    expect(store.loadSync()).toEqual({})
  })

  it('fails safe to empty overrides on corrupt JSON', () => {
    writeFileSync(storePath(), '{ not json', 'utf8')
    expect(new SessionConfigStore(tmpDir).loadSync()).toEqual({})
  })

  it('fails safe to empty overrides on invalid enum values (whole file rejected)', () => {
    writeFileSync(storePath(), JSON.stringify({
      version: 1,
      overrides: { personality: 'sassy', webSearch: 'disabled' },
    }), 'utf8')
    expect(new SessionConfigStore(tmpDir).loadSync()).toEqual({})
  })

  it('fails safe to empty overrides on unknown version', () => {
    writeFileSync(storePath(), JSON.stringify({
      version: 999,
      overrides: { webSearch: 'disabled' },
    }), 'utf8')
    expect(new SessionConfigStore(tmpDir).loadSync()).toEqual({})
  })

  it('migrates the retired untrusted approval policy to on-request', () => {
    writeFileSync(storePath(), JSON.stringify({
      version: 1,
      overrides: { approvalPolicy: 'untrusted' },
    }), 'utf8')
    expect(new SessionConfigStore(tmpDir).loadSync()).toEqual({ approvalPolicy: 'on-request' })
  })

  it('keeps sibling overrides when migrating a retired approval policy', () => {
    // The whole-file rejection path would drop these too, which is exactly what
    // the migration exists to avoid.
    writeFileSync(storePath(), JSON.stringify({
      version: 1,
      overrides: {
        approvalPolicy: 'untrusted',
        sandboxMode: 'workspace-write',
        personality: 'pragmatic',
      },
    }), 'utf8')
    expect(new SessionConfigStore(tmpDir).loadSync()).toEqual({
      approvalPolicy: 'on-request',
      sandboxMode: 'workspace-write',
      personality: 'pragmatic',
    })
  })

  it('ignores writableRoots smuggled into a persisted file', () => {
    writeFileSync(storePath(), JSON.stringify({
      version: 1,
      overrides: { webSearch: 'disabled', writableRoots: ['C:/evil'] },
    }), 'utf8')
    expect(new SessionConfigStore(tmpDir).loadSync()).toEqual({ webSearch: 'disabled' })
  })
})
