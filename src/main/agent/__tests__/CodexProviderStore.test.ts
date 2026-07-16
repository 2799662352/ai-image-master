import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CodexProviderStore } from '../CodexProviderStore'
import { DEFAULT_PROVIDER_ID } from '../codexProviders'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-providers-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function makeStore(): CodexProviderStore {
  return new CodexProviderStore({ userDataDir: tmpDir })
}

describe('CodexProviderStore', () => {
  it('returns sensible defaults when no file exists', async () => {
    const store = makeStore()
    const state = await store.load()
    expect(state.version).toBe(1)
    expect(state.selectedProviderId).toBe(DEFAULT_PROVIDER_ID)
    expect(state.apiKeys).toEqual({})
    expect(state.customProviders).toEqual([])
  })

  it('persists and reloads selected provider id', async () => {
    const store = makeStore()
    await store.setSelectedId('rightcode')

    const reopened = makeStore()
    expect(await reopened.getSelectedId()).toBe('rightcode')
  })

  it('persists per-provider api keys without leaking across providers', async () => {
    const store = makeStore()
    await store.setApiKey('apiyi', 'sk-apiyi-1')
    await store.setApiKey('rightcode', 'sk-rc-1')

    const reopened = makeStore()
    expect(await reopened.getApiKey('apiyi')).toBe('sk-apiyi-1')
    expect(await reopened.getApiKey('rightcode')).toBe('sk-rc-1')
    // Empty for unknown ids — never undefined leaking into UI inputs.
    expect(await reopened.getApiKey('nope')).toBe('')
  })

  it('shares one stored credential across builtin channels from the same gateway', async () => {
    const store = makeStore()

    await store.setApiKey('rightcode', 'sk-shared')
    expect(await store.getApiKey('rightcode-grok')).toBe('sk-shared')

    await store.setApiKey('rightcode-grok', 'sk-rotated')
    expect(await store.getApiKey('rightcode')).toBe('sk-rotated')
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(persisted.apiKeys).toEqual({ rightcode: 'sk-rotated' })
  })

  it('shares the API Yi credential with its Grok channel', async () => {
    const store = makeStore()

    await store.setApiKey('apiyi', 'sk-apiyi')
    expect(await store.getApiKey('apiyi-grok')).toBe('sk-apiyi')

    await store.setApiKey('apiyi-grok', 'sk-rotated')
    expect(await store.getApiKey('apiyi')).toBe('sk-rotated')
  })

  it('migrates legacy codex-agent.json once into apiyi key slot', async () => {
    const legacyPath = path.join(tmpDir, 'codex-agent.json')
    await fs.writeFile(legacyPath, JSON.stringify({ openaiApiKey: 'sk-legacy-key' }))

    const store = makeStore()
    const state = await store.load()
    expect(state.selectedProviderId).toBe(DEFAULT_PROVIDER_ID)
    expect(state.apiKeys.apiyi).toBe('sk-legacy-key')

    // Migration creates the new file so subsequent loads do not re-migrate.
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-providers.json'), 'utf8'),
    )
    expect(persisted.apiKeys.apiyi).toBe('sk-legacy-key')
  })

  it('remaps retired rightcode-pro state onto rightcode at load time', async () => {
    // Right.Codes retired /codex-pro on 2026-06-12 (merged into /codex). A
    // user who had selected the old preset must come back to a WORKING
    // provider with their key intact, without re-entering anything.
    await fs.writeFile(
      path.join(tmpDir, 'codex-providers.json'),
      JSON.stringify({
        version: 1,
        selectedProviderId: 'rightcode-pro',
        apiKeys: { 'rightcode-pro': 'sk-rc-key', apiyi: 'sk-apiyi' },
        customProviders: [],
      }),
    )

    const store = makeStore()
    const state = await store.load()
    expect(state.selectedProviderId).toBe('rightcode')
    expect(state.apiKeys.rightcode).toBe('sk-rc-key')
    expect(state.apiKeys['rightcode-pro']).toBeUndefined()
    expect(state.apiKeys.apiyi).toBe('sk-apiyi')

    // Same remap on the sync path used at AgentManager construction.
    const syncStore = new CodexProviderStore({ userDataDir: tmpDir })
    const syncState = syncStore.loadSync()
    expect(syncState.selectedProviderId).toBe('rightcode')
    expect(syncState.apiKeys.rightcode).toBe('sk-rc-key')
  })

  it('rightcode-pro key does NOT clobber an existing rightcode key', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-providers.json'),
      JSON.stringify({
        version: 1,
        selectedProviderId: 'apiyi',
        apiKeys: { 'rightcode-pro': 'sk-old-pro', rightcode: 'sk-current' },
        customProviders: [],
      }),
    )

    const store = makeStore()
    const state = await store.load()
    expect(state.apiKeys.rightcode).toBe('sk-current')
    expect(state.apiKeys['rightcode-pro']).toBeUndefined()
  })

  it('treats malformed json as fresh defaults rather than crashing', async () => {
    await fs.writeFile(path.join(tmpDir, 'codex-providers.json'), '{not json')
    const store = makeStore()
    const state = await store.load()
    expect(state.selectedProviderId).toBe(DEFAULT_PROVIDER_ID)
    expect(state.apiKeys).toEqual({})
    expect(state.customProviders).toEqual([])
  })

  it('addCustomProvider assigns custom-* id, refuses builtin id collision', async () => {
    const store = makeStore()
    const created = await store.addCustomProvider({
      name: 'My Gateway',
      baseUrl: 'https://gw.example.com/v1',
      envKey: 'OPENAI_API_KEY',
    })
    expect(created.id).toMatch(/^custom-/)
    expect(created.isCustom).toBe(true)
    expect(created.name).toBe('My Gateway')

    await expect(
      store.addCustomProvider({
        id: 'apiyi',
        name: 'shadow',
        baseUrl: 'https://x',
        envKey: 'OPENAI_API_KEY',
      }),
    ).rejects.toThrow(/builtin/i)
  })

  it('updateCustomProvider merges fields and rejects non-existent / builtin ids', async () => {
    const store = makeStore()
    const created = await store.addCustomProvider({
      name: 'My Gateway',
      baseUrl: 'https://gw.example.com/v1',
      envKey: 'OPENAI_API_KEY',
    })

    await store.updateCustomProvider(created.id, { name: 'Renamed', model: 'gpt-5.5' })
    const fresh = makeStore()
    const list = await fresh.getCustomProviders()
    expect(list[0].name).toBe('Renamed')
    expect(list[0].model).toBe('gpt-5.5')

    await expect(
      store.updateCustomProvider('not-real', { name: 'x' }),
    ).rejects.toThrow(/not found/i)
    await expect(
      store.updateCustomProvider('apiyi', { name: 'shadow' }),
    ).rejects.toThrow(/builtin/i)
  })

  it('removeCustomProvider clears custom + falls back to default if it was selected', async () => {
    const store = makeStore()
    const created = await store.addCustomProvider({
      name: 'Tmp',
      baseUrl: 'https://t.example.com/v1',
      envKey: 'OPENAI_API_KEY',
    })
    await store.setSelectedId(created.id)
    await store.setApiKey(created.id, 'sk-tmp')

    await store.removeCustomProvider(created.id)

    const reopened = makeStore()
    expect(await reopened.getCustomProviders()).toEqual([])
    expect(await reopened.getSelectedId()).toBe(DEFAULT_PROVIDER_ID)
    // Removing the provider also drops its api key — no orphaned secrets.
    expect(await reopened.getApiKey(created.id)).toBe('')
  })

  it('atomically restores a complete snapshot after an applied Provider transaction fails', async () => {
    const store = makeStore()
    const created = await store.addCustomProvider({
      id: 'custom-rollback',
      name: 'Before',
      baseUrl: 'https://before.example.com/v1',
      envKey: 'OPENAI_API_KEY',
    })
    await store.setSelectedId(created.id)
    await store.setApiKey(created.id, 'sk-before')
    const before = await store.load()

    await store.updateCustomProvider(created.id, {
      baseUrl: 'https://after.example.com/v1',
    })
    await store.setApiKey(created.id, 'sk-after')
    await store.setSelectedId('apiyi')
    await store.restore(before)

    const reopened = makeStore()
    expect(await reopened.load()).toEqual(before)
  })

  it('serializes concurrent Provider mutations without losing selected id or keys', async () => {
    const store = makeStore()

    await Promise.all([
      store.setSelectedId('rightcode'),
      store.setApiKey('rightcode', 'sk-rightcode'),
    ])

    const reopened = makeStore()
    expect(await reopened.getSelectedId()).toBe('rightcode')
    expect(await reopened.getApiKey('rightcode')).toBe('sk-rightcode')
  })

  it('atomic write does not corrupt existing file when interrupted', async () => {
    const store = makeStore()
    await store.setApiKey('apiyi', 'sk-good')
    const filePath = path.join(tmpDir, 'codex-providers.json')
    const before = await fs.readFile(filePath, 'utf8')
    expect(before).toContain('sk-good')

    // Simulate a temp-file leftover from a crashed previous write.
    await fs.writeFile(`${filePath}.${process.pid}.123.tmp`, 'partial garbage')

    // Reopen and re-read — the leftover tmp must not poison the canonical file.
    const fresh = makeStore()
    expect(await fresh.getApiKey('apiyi')).toBe('sk-good')
  })
})
