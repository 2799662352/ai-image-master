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
  it('creates config.toml with disabled apiyi entry when file does not exist', async () => {
    await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })

    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = parseToml(raw) as Record<string, unknown>
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers).toBeDefined()
    expect(servers.apiyi).toEqual({
      command: FAKE_NODE,
      args: [FAKE_ENTRY],
      enabled: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
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

  it('preserves command/args/enabled/APIYI_API_KEY when migrating env to add ELECTRON_RUN_AS_NODE', async () => {
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
        'GEMINI_MODEL = "gemini-3.1-pro-preview"',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('migrated')

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
    // Everything the user / settings UI configured stays put.
    expect(apiyi.command).toBe('/custom/node')
    expect(apiyi.args).toEqual(['/custom/path.js'])
    expect(apiyi.enabled).toBe(true)
    expect(apiyi.env.APIYI_API_KEY).toBe('sk-user-already-set')
    expect(apiyi.env.GEMINI_MODEL).toBe('gemini-3.1-pro-preview')
    // The only addition.
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('does NOT migrate when ELECTRON_RUN_AS_NODE is already present (idempotent across reboots)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/custom/node"',
        'args = ["/custom/path.js"]',
        'enabled = true',
        '',
        '[mcp_servers.apiyi.env]',
        'ELECTRON_RUN_AS_NODE = "1"',
        'APIYI_API_KEY = "sk-user-already-set"',
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
  })

  it('returns the action taken: "seeded" | "skipped" | "migrated"', async () => {
    // First call on empty workspace → seeded
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(first).toBe('seeded')

    // Second call when entry already has ELECTRON_RUN_AS_NODE → skipped
    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(second).toBe('skipped')

    // Now simulate an older config without ELECTRON_RUN_AS_NODE → migrated
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/c"',
        'args = ["/a"]',
        'enabled = true',
        '',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = "sk"',
        '',
      ].join('\n'),
      'utf8',
    )
    const third = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(third).toBe('migrated')
  })

  it('survives malformed existing TOML by treating it as empty (logs warning)', async () => {
    await fs.writeFile(configPath, 'this is not = valid [[toml', 'utf8')

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      nodeBin: FAKE_NODE,
    })
    expect(action).toBe('seeded')
    // The post-seed file MUST parse — we recovered, not wiped silently.
    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(
      (parsed.mcp_servers as Record<string, unknown>).apiyi,
    ).toBeDefined()
  })
})
