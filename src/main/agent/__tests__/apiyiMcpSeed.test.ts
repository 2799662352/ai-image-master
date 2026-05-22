import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { seedApiyiMcpEntry } from '../apiyiMcpSeed'

let tmpDir: string
let configPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apiyi-seed-'))
  configPath = path.join(tmpDir, 'config.toml')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const FAKE_ENTRY = '/Resources/apiyi-mcp/dist/index.js'
const FAKE_NODE = '/usr/local/bin/node'

describe('seedApiyiMcpEntry', () => {
  // Per design: seed ONLY when entry doesn't exist; never touch an existing
  // entry. The user is the sole source of truth for env / enabled, editing
  // via the MCP JSON editor in the agent workspace.

  it('creates config.toml with disabled apiyi stub when file does not exist', async () => {
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('seeded')

    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = parseToml(raw) as Record<string, unknown>
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers).toBeDefined()
    expect(servers.apiyi).toEqual({
      command: FAKE_NODE,
      args: [FAKE_ENTRY],
      enabled: false,
      env: {},
    })
  })

  it('preserves existing mcp_servers and other top-level keys', async () => {
    await fs.writeFile(
      configPath,
      [
        'some_top_level = "value"',
        '',
        '[mcp_servers.existing]',
        'command = "/bin/foo"',
        'args = ["x"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    )

    await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(parsed.some_top_level).toBe('value')
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers.existing).toEqual({
      command: '/bin/foo',
      args: ['x'],
      enabled: true,
    })
    expect((servers.apiyi as { enabled: boolean }).enabled).toBe(false)
  })

  it('DOES NOT overwrite an existing apiyi entry — user config is sacred', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/custom/node"',
        'args = ["/custom/path.js"]',
        'enabled = true',
        '',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = "sk-user-already-set"',
        'ELECTRON_RUN_AS_NODE = "1"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('skipped')

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string
      args: string[]
      enabled: boolean
      env: Record<string, string>
    }
    expect(apiyi.command).toBe('/custom/node')
    expect(apiyi.args).toEqual(['/custom/path.js'])
    expect(apiyi.enabled).toBe(true)
    expect(apiyi.env.APIYI_API_KEY).toBe('sk-user-already-set')
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(apiyi.env.GEMINI_MODEL).toBe('gemini-3.5-flash')
  })

  it('skips even a partial / env-less existing entry — does not "fix" or migrate', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/c"',
        'args = ["/a"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('skipped')

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string
      env?: Record<string, string>
    }
    // No env injection — user must add it themselves via the JSON editor.
    expect(apiyi.command).toBe('/c')
    expect(apiyi.env).toBeUndefined()
  })

  it('is idempotent on repeated boots (seed then skip)', async () => {
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(first).toBe('seeded')

    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(second).toBe('skipped')
  })

  it('survives malformed existing TOML by treating it as empty (logs warning)', async () => {
    await fs.writeFile(configPath, 'this is not = valid [[toml', 'utf8')

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('seeded')
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(
      (parsed.mcp_servers as Record<string, unknown>).apiyi,
    ).toBeDefined()
  })
})
