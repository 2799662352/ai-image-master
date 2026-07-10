import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { mergeEnvWithScaffold, seedCinematographyKbMcpEntry } from '../cinematographyKbMcpSeed'
import {
  CINEMATOGRAPHY_KB_ENV_SCAFFOLD,
  getCinematographyKbMcpEntryPath,
} from '../cinematographyKbMcpLauncher'

let tmpDir: string
let configPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinema-kb-seed-'))
  configPath = path.join(tmpDir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const FAKE_ENTRY = '/Resources/cinematography-kb-mcp/index.js'
const FAKE_NODE = '/usr/local/bin/node'

function readServers(raw: string): Record<string, unknown> {
  return (parseToml(raw) as Record<string, unknown>).mcp_servers as Record<string, unknown>
}

describe('getCinematographyKbMcpEntryPath', () => {
  it('resolves dev path under <appPath>/resources', () => {
    const p = getCinematographyKbMcpEntryPath({ appPath: '/app', isPackaged: false })
    expect(p).toBe(path.join('/app', 'resources', 'cinematography-kb-mcp', 'index.js'))
  })

  it('resolves packaged path under resourcesPath', () => {
    const p = getCinematographyKbMcpEntryPath({
      appPath: '/app',
      isPackaged: true,
      resourcesPath: '/res',
    })
    expect(p).toBe(path.join('/res', 'cinematography-kb-mcp', 'index.js'))
  })
})

describe('mergeEnvWithScaffold', () => {
  // The scaffold bakes ONLY the (non-secret) DashVector endpoint; keys are
  // injected at spawn from 设置 and never baked.
  it('bakes the DashVector endpoint and no secret', () => {
    expect(CINEMATOGRAPHY_KB_ENV_SCAFFOLD).toEqual({
      DASHVECTOR_ENDPOINT: 'vrs-cn-1zz4v38oq0001l.dashvector.cn-beijing.aliyuncs.com',
    })
    expect(Object.keys(CINEMATOGRAPHY_KB_ENV_SCAFFOLD).some((k) => k.includes('KEY'))).toBe(false)
  })

  it('adds the endpoint to an env that lacks it', () => {
    expect(mergeEnvWithScaffold({})).toEqual({ ...CINEMATOGRAPHY_KB_ENV_SCAFFOLD })
    expect(mergeEnvWithScaffold({ DASHSCOPE_API_KEY: 'sk-user-own' })).toEqual({
      DASHSCOPE_API_KEY: 'sk-user-own',
      ...CINEMATOGRAPHY_KB_ENV_SCAFFOLD,
    })
  })

  it('returns null once the scaffold is already present (idempotent)', () => {
    expect(mergeEnvWithScaffold({ ...CINEMATOGRAPHY_KB_ENV_SCAFFOLD })).toBeNull()
  })

  it('never overwrites a user-set endpoint (own cluster)', () => {
    expect(mergeEnvWithScaffold({ DASHVECTOR_ENDPOINT: 'vrs-user-own.example.com' })).toBeNull()
  })

  it('normalizes a present-but-non-object env into the scaffold', () => {
    expect(mergeEnvWithScaffold('broken')).toEqual({ ...CINEMATOGRAPHY_KB_ENV_SCAFFOLD })
  })
})

describe('seedCinematographyKbMcpEntry', () => {
  it('seeds an ENABLED node entry WITHOUT a baked key (key comes from 设置 at spawn)', async () => {
    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('seeded')

    const servers = readServers(await fs.readFile(configPath, 'utf8'))
    const kb = servers.cinematography_kb as {
      command: string
      args: string[]
      enabled: boolean
      env?: Record<string, string>
    }
    expect(kb.command).toBe(FAKE_NODE)
    expect(kb.args).toEqual([FAKE_ENTRY])
    expect(kb.enabled).toBe(true)
    // No secret is baked — the key is injected at codex spawn from 设置.
    expect(kb.env?.DASHSCOPE_API_KEY).toBeUndefined()
  })

  it('layers extraEnv (Electron-as-Node fallback) without baking a key', async () => {
    await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/path/to/electron.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
    const servers = readServers(await fs.readFile(configPath, 'utf8'))
    const kb = servers.cinematography_kb as { command: string; env: Record<string, string> }
    expect(kb.command).toBe('/path/to/electron.exe')
    expect(kb.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(kb.env.DASHSCOPE_API_KEY).toBeUndefined()
  })

  it('preserves other top-level keys and existing servers', async () => {
    await fs.writeFile(
      configPath,
      ['top = "keep"', '', '[mcp_servers.existing]', 'command = "/bin/foo"', 'args = ["x"]', ''].join('\n'),
      'utf8',
    )
    await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(parsed.top).toBe('keep')
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers.existing).toEqual({ command: '/bin/foo', args: ['x'] })
    expect((servers.cinematography_kb as { enabled: boolean }).enabled).toBe(true)
  })

  it('migrates the legacy Python-wrapper entry to the vendored Node entry (repaired)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.cinematography_kb]',
        'command = "python"',
        'args = ["D:\\\\tecx\\\\text\\\\cinematography-kb-mcp\\\\server.py"]',
        'enabled = true',
        '',
        '[mcp_servers.cinematography_kb.env]',
        'DASHSCOPE_API_KEY = "sk-existing"',
        '',
      ].join('\n'),
      'utf8',
    )
    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')

    const servers = readServers(await fs.readFile(configPath, 'utf8'))
    const kb = servers.cinematography_kb as {
      command: string
      args: string[]
      enabled: boolean
      env: Record<string, string>
    }
    expect(kb.command).toBe(FAKE_NODE)
    expect(kb.args).toEqual([FAKE_ENTRY])
    expect(kb.enabled).toBe(true) // sacred
    expect(kb.env.DASHSCOPE_API_KEY).toBe('sk-existing') // user value preserved
  })

  it('repairs a missing-transport entry (no command, no url)', async () => {
    await fs.writeFile(
      configPath,
      ['[mcp_servers.cinematography_kb]', 'args = ["/old.js"]', 'enabled = false', ''].join('\n'),
      'utf8',
    )
    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')
    const servers = readServers(await fs.readFile(configPath, 'utf8'))
    const kb = servers.cinematography_kb as { command: string; enabled: boolean; env?: Record<string, string> }
    expect(kb.command).toBe(FAKE_NODE)
    expect(kb.enabled).toBe(false) // sacred
    expect(kb.env?.DASHSCOPE_API_KEY).toBeUndefined()
  })

  it('is idempotent: seed → skip', async () => {
    expect(
      await seedCinematographyKbMcpEntry({ personalConfigToml: configPath, entryPath: FAKE_ENTRY, command: FAKE_NODE }),
    ).toBe('seeded')
    expect(
      await seedCinematographyKbMcpEntry({ personalConfigToml: configPath, entryPath: FAKE_ENTRY, command: FAKE_NODE }),
    ).toBe('skipped')
  })

  it('survives malformed TOML by treating it as empty', async () => {
    await fs.writeFile(configPath, 'not = valid [[toml', 'utf8')
    const action = await seedCinematographyKbMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('seeded')
    expect(readServers(await fs.readFile(configPath, 'utf8')).cinematography_kb).toBeDefined()
  })
})
