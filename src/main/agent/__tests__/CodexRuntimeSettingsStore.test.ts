import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { open, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CodexRuntimeSettingsStore,
  type PersistedCodexRuntimeSettingsV1,
} from '../CodexRuntimeSettingsStore'

const DEFAULT_SETTINGS: PersistedCodexRuntimeSettingsV1 = {
  version: 1,
  confirmed: {
    modelContextWindow: 200_000,
    modelAutoCompactTokenLimit: 180_000,
  },
}

describe('CodexRuntimeSettingsStore', () => {
  let userDataDir: string
  let settingsPath: string

  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'codex-runtime-settings-'))
    settingsPath = path.join(userDataDir, 'codex-runtime-settings.json')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  it('returns the fresh 200K/180K default when the file does not exist', () => {
    const store = new CodexRuntimeSettingsStore(userDataDir)

    expect(store.loadSync()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it.each([
    ['malformed JSON', '{ definitely-not-json'],
    ['the wrong version', JSON.stringify({ ...DEFAULT_SETTINGS, version: 2 })],
    ['a non-object root', JSON.stringify(['not', 'an', 'object'])],
    ['a null root', 'null'],
    [
      'a dangerous root prototype key',
      '{"version":1,"confirmed":{"modelContextWindow":372000,"modelAutoCompactTokenLimit":334800},"__proto__":{"polluted":true}}',
    ],
    [
      'a dangerous confirmed prototype key',
      '{"version":1,"confirmed":{"modelContextWindow":372000,"modelAutoCompactTokenLimit":334800,"__proto__":{"polluted":true}}}',
    ],
    [
      'a dangerous pending prototype key',
      '{"version":1,"confirmed":{"modelContextWindow":200000,"modelAutoCompactTokenLimit":180000},"pending":{"target":{"modelContextWindow":372000,"modelAutoCompactTokenLimit":334800},"requestVersion":1,"startedAt":"2026-07-12T10:00:00.000Z","__proto__":{"polluted":true}}}',
    ],
    [
      'a dangerous pending target prototype key',
      '{"version":1,"confirmed":{"modelContextWindow":200000,"modelAutoCompactTokenLimit":180000},"pending":{"target":{"modelContextWindow":372000,"modelAutoCompactTokenLimit":334800,"__proto__":{"polluted":true}},"requestVersion":1,"startedAt":"2026-07-12T10:00:00.000Z"}}',
    ],
  ])('safely falls back for %s', (_label, raw) => {
    writeFileSync(settingsPath, raw, 'utf8')

    expect(new CodexRuntimeSettingsStore(userDataDir).loadSync()).toEqual(DEFAULT_SETTINGS)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it.each([
    ['zero context', { modelContextWindow: 0, modelAutoCompactTokenLimit: 0 }],
    ['negative context', { modelContextWindow: -1, modelAutoCompactTokenLimit: -1 }],
    [
      'unsafe context',
      {
        modelContextWindow: Number.MAX_SAFE_INTEGER + 1,
        modelAutoCompactTokenLimit: 1,
      },
    ],
    ['non-integer context', { modelContextWindow: 200_000.5, modelAutoCompactTokenLimit: 180_000 }],
    ['zero compact limit', { modelContextWindow: 200_000, modelAutoCompactTokenLimit: 0 }],
    ['mismatched compact limit', { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_799 }],
  ])('rejects invalid confirmed config: %s', (_label, confirmed) => {
    writeFileSync(settingsPath, JSON.stringify({ version: 1, confirmed }), 'utf8')

    expect(new CodexRuntimeSettingsStore(userDataDir).loadSync()).toEqual(DEFAULT_SETTINGS)
  })

  it.each([
    [
      'root',
      Object.create({
        version: 1,
        confirmed: DEFAULT_SETTINGS.confirmed,
      }),
    ],
    [
      'confirmed',
      {
        version: 1,
        confirmed: Object.create({
          modelContextWindow: 200_000,
          modelAutoCompactTokenLimit: 180_000,
        }),
      },
    ],
    [
      'pending',
      {
        ...DEFAULT_SETTINGS,
        pending: Object.create({
          target: {
            modelContextWindow: 372_000,
            modelAutoCompactTokenLimit: 334_800,
          },
          requestVersion: 1,
          startedAt: '2026-07-12T10:00:00.000Z',
        }),
      },
    ],
    [
      'pending.target',
      {
        ...DEFAULT_SETTINGS,
        pending: {
          target: Object.create({
            modelContextWindow: 372_000,
            modelAutoCompactTokenLimit: 334_800,
          }),
          requestVersion: 1,
          startedAt: '2026-07-12T10:00:00.000Z',
        },
      },
    ],
  ])('rejects required fields inherited through %s prototype', async (_label, candidate) => {
    const store = new CodexRuntimeSettingsStore(userDataDir)

    await expect(store.replace(candidate as PersistedCodexRuntimeSettingsV1)).rejects.toThrow(
      /invalid.*runtime settings/i,
    )
    expect(store.loadSync()).toEqual(DEFAULT_SETTINGS)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('rejects a root with valid own fields but a polluted custom prototype', async () => {
    const candidate = Object.assign(
      Object.create({ polluted: true }),
      DEFAULT_SETTINGS,
    )
    const store = new CodexRuntimeSettingsStore(userDataDir)

    await expect(store.replace(candidate)).rejects.toThrow(/invalid.*runtime settings/i)
    expect(store.loadSync()).toEqual(DEFAULT_SETTINGS)
  })

  it.each([
    [
      'invalid target',
      {
        target: { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_799 },
        requestVersion: 1,
        startedAt: '2026-07-12T10:00:00.000Z',
      },
    ],
    [
      'non-positive requestVersion',
      {
        target: { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_800 },
        requestVersion: 0,
        startedAt: '2026-07-12T10:00:00.000Z',
      },
    ],
    [
      'unsafe requestVersion',
      {
        target: { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_800 },
        requestVersion: Number.MAX_SAFE_INTEGER + 1,
        startedAt: '2026-07-12T10:00:00.000Z',
      },
    ],
    [
      'invalid startedAt',
      {
        target: { modelContextWindow: 372_000, modelAutoCompactTokenLimit: 334_800 },
        requestVersion: 1,
        startedAt: 'not-an-iso-date',
      },
    ],
  ])('rejects invalid pending transaction: %s', (_label, pending) => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...DEFAULT_SETTINGS, pending }),
      'utf8',
    )

    expect(new CodexRuntimeSettingsStore(userDataDir).loadSync()).toEqual(DEFAULT_SETTINGS)
  })

  it('recovers an interrupted valid pending transaction to old confirmed only', () => {
    const persisted: PersistedCodexRuntimeSettingsV1 = {
      ...DEFAULT_SETTINGS,
      pending: {
        target: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
        requestVersion: 7,
        startedAt: '2026-07-12T10:00:00.000Z',
      },
    }
    writeFileSync(settingsPath, JSON.stringify(persisted), 'utf8')

    const loaded = new CodexRuntimeSettingsStore(userDataDir).loadSync()

    expect(loaded).toEqual(DEFAULT_SETTINGS)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(DEFAULT_SETTINGS)
  })

  it('returns old confirmed and emits a diagnostic when pending cleanup cannot be persisted', () => {
    const persisted: PersistedCodexRuntimeSettingsV1 = {
      ...DEFAULT_SETTINGS,
      pending: {
        target: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
        requestVersion: 8,
        startedAt: '2026-07-12T10:00:00.000Z',
      },
    }
    writeFileSync(settingsPath, JSON.stringify(persisted), 'utf8')
    const diagnostic = vi.fn()
    const store = new CodexRuntimeSettingsStore(userDataDir, {
      renameSyncForRecovery: () => {
        throw new Error('simulated rename failure')
      },
      onDiagnostic: diagnostic,
    })

    expect(store.loadSync()).toEqual(DEFAULT_SETTINGS)
    expect(diagnostic).toHaveBeenCalledWith(
      expect.stringMatching(/pending.*recover/i),
      expect.any(Error),
    )
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(persisted)
  })

  it('returns fresh copies so caller mutation cannot poison later defaults', () => {
    const store = new CodexRuntimeSettingsStore(userDataDir)
    const first = store.loadSync()
    first.confirmed.modelContextWindow = 1
    first.confirmed.modelAutoCompactTokenLimit = 1

    const second = store.loadSync()

    expect(second).toEqual(DEFAULT_SETTINGS)
    expect(second).not.toBe(first)
    expect(second.confirmed).not.toBe(first.confirmed)
  })

  it('replace validates before writing', async () => {
    const store = new CodexRuntimeSettingsStore(userDataDir)
    const invalid = {
      version: 1,
      confirmed: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_799,
      },
    } as PersistedCodexRuntimeSettingsV1

    await expect(store.replace(invalid)).rejects.toThrow(/invalid.*runtime settings/i)
    expect(existsSync(settingsPath)).toBe(false)
  })

  it('replace writes valid JSON through a same-directory unique temp and rename', async () => {
    const renames: Array<[string, string]> = []
    const store = new CodexRuntimeSettingsStore(userDataDir, {
      renameForReplace: async (from, to) => {
        renames.push([from.toString(), to.toString()])
        expect(path.dirname(from.toString())).toBe(userDataDir)
        expect(existsSync(from)).toBe(true)
        await rename(from, to)
      },
    })
    const next: PersistedCodexRuntimeSettingsV1 = {
      version: 1,
      confirmed: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      },
    }

    const replacement = store.replace(next)
    expect(replacement).toBeInstanceOf(Promise)
    await replacement

    expect(renames).toHaveLength(1)
    expect(renames[0][1]).toBe(settingsPath)
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(next)
    expect(readdirSync(userDataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('replace atomically overwrites an existing settings file', async () => {
    const store = new CodexRuntimeSettingsStore(userDataDir)
    await store.replace(DEFAULT_SETTINGS)
    const next: PersistedCodexRuntimeSettingsV1 = {
      version: 1,
      confirmed: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      },
    }

    await store.replace(next)

    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual(next)
    expect(readdirSync(userDataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('concurrent replace attempts leave one complete valid snapshot and no temp files', async () => {
    const snapshots: PersistedCodexRuntimeSettingsV1[] = [
      DEFAULT_SETTINGS,
      {
        version: 1,
        confirmed: {
          modelContextWindow: 272_000,
          modelAutoCompactTokenLimit: 244_800,
        },
      },
      {
        version: 1,
        confirmed: {
          modelContextWindow: 372_000,
          modelAutoCompactTokenLimit: 334_800,
        },
      },
    ]

    let openCount = 0
    let releaseOpenBarrier!: () => void
    let reportAllOpened!: () => void
    const openBarrier = new Promise<void>((resolve) => {
      releaseOpenBarrier = resolve
    })
    const allOpened = new Promise<void>((resolve) => {
      reportAllOpened = resolve
    })
    const openForReplace: typeof open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args)
      openCount += 1
      if (openCount === snapshots.length) reportAllOpened()
      await openBarrier
      return handle
    }
    const stores = snapshots.map(() => new CodexRuntimeSettingsStore(userDataDir, {
      openForReplace,
    }))

    const replacements = snapshots.map((snapshot, index) => stores[index].replace(snapshot))
    expect(replacements.every((replacement) => replacement instanceof Promise)).toBe(true)
    await allOpened
    expect(openCount).toBe(snapshots.length)
    releaseOpenBarrier()
    await Promise.all(replacements)

    const persisted = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(snapshots).toContainEqual(persisted)
    expect(new CodexRuntimeSettingsStore(userDataDir).loadSync()).toEqual(persisted)
    expect(readdirSync(userDataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('replace preserves the confirmed file and cleans its temp when rename fails', async () => {
    const initialStore = new CodexRuntimeSettingsStore(userDataDir)
    await initialStore.replace(DEFAULT_SETTINGS)
    const original = readFileSync(settingsPath, 'utf8')
    let attemptedTemp = ''
    const failingStore = new CodexRuntimeSettingsStore(userDataDir, {
      renameForReplace: async (from) => {
        attemptedTemp = from.toString()
        expect(existsSync(from)).toBe(true)
        throw new Error('simulated rename failure')
      },
    })

    await expect(failingStore.replace({
      version: 1,
      confirmed: {
        modelContextWindow: 372_000,
        modelAutoCompactTokenLimit: 334_800,
      },
    })).rejects.toThrow('simulated rename failure')

    expect(readFileSync(settingsPath, 'utf8')).toBe(original)
    expect(attemptedTemp).not.toBe('')
    expect(existsSync(attemptedTemp)).toBe(false)
    expect(readdirSync(userDataDir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
