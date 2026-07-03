import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { seedApiyiMcpEntry } from '../apiyiMcpSeed'
import { APIYI_MCP_ENV_SCAFFOLD } from '../apiyiMcpLauncher'

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

interface ApiyiEntryShape {
  command: string
  args: string[]
  enabled: boolean
  env: Record<string, string>
}

async function readApiyi(): Promise<ApiyiEntryShape> {
  const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
  return (parsed.mcp_servers as Record<string, unknown>).apiyi as ApiyiEntryShape
}

// FORCE-convergence semantics: `mcp_servers.apiyi` is app-managed. Every boot
// rewrites it to the canonical form (fresh command/args, full env scaffold,
// enabled=true). User edits do NOT survive. Three outcomes:
//   'seeded'   → entry absent, canonical written
//   'repaired' → entry present but non-canonical, overwritten wholesale
//   'skipped'  → entry already exactly canonical (steady state, no write)
describe('seedApiyiMcpEntry — force convergence', () => {
  it('creates config.toml with the canonical ENABLED entry (system-node path)', async () => {
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('seeded')

    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.args).toEqual([FAKE_ENTRY])
    expect(apiyi.enabled).toBe(true)
    // The canonical env carries no key — APIYI_API_KEY is injected at codex
    // spawn from 设置 → API易 (the ONLY key source), never persisted.
    expect(apiyi.env.APIYI_API_KEY).toBeUndefined()
    expect(apiyi.env).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD })
  })

  it('layers extraEnv on top of the scaffold (Electron-as-Node fallback)', async () => {
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/path/to/electron.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(action).toBe('seeded')

    const apiyi = await readApiyi()
    expect(apiyi.command).toBe('/path/to/electron.exe')
    expect(apiyi.env).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD, ELECTRON_RUN_AS_NODE: '1' })
  })

  it('preserves other servers and top-level keys when converging apiyi', async () => {
    await fs.writeFile(
      configPath,
      [
        'some_top_level = "value"',
        '',
        '[mcp_servers.existing]',
        'command = "/bin/foo"',
        'args = ["x"]',
        'enabled = true',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('seeded')

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(parsed.some_top_level).toBe('value')
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers.existing).toEqual({ command: '/bin/foo', args: ['x'], enabled: true })
    expect((servers.apiyi as ApiyiEntryShape).enabled).toBe(true)
  })

  it('OVERWRITES a stale disabled entry (old seeds wrote enabled=false; users stayed dead forever)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "D:\\\\old-install\\\\CATIMATION.exe"',
        'args = ["D:\\\\old-install\\\\resources\\\\apiyi-mcp\\\\dist\\\\index.js"]',
        'enabled = false',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = ""',
        'ELECTRON_RUN_AS_NODE = "1"',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        'GEMINI_MAX_OUTPUT_TOKENS = "65536"',
        'GEMINI_TIMEOUT = "1800000"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')

    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.args).toEqual([FAKE_ENTRY])
    expect(apiyi.enabled).toBe(true) // force ON
    expect(apiyi.env.APIYI_API_KEY).toBeUndefined() // empty key slot wiped
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBeUndefined() // node path: marker dropped
  })

  it('OVERWRITES user hand-edits including a hand-typed key (设置 is the only key source)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/my/custom/node"',
        `args = ["${FAKE_ENTRY}"]`,
        'enabled = true',
        'tool_timeout_sec = 99',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = "sk-hand-typed"',
        'GEMINI_MODEL = "gemini-3.1-pro-preview-thinking"',
        'APIYI_BASE_URL = "https://api.bltcy.ai"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')

    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE) // custom command overwritten
    expect(apiyi.env.APIYI_API_KEY).toBeUndefined() // hand-typed key wiped
    expect(apiyi.env.GEMINI_MODEL).toBe('gemini-3.5-flash') // model reset to default
    expect(apiyi.env.APIYI_BASE_URL).toBe('https://api.apiyi.com') // bad base URL fixed
    expect((apiyi as unknown as Record<string, unknown>).tool_timeout_sec).toBeUndefined() // extra field dropped
  })

  it('repairs the v4.3.16 "missing transport" regression shape (no command, no url)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'args = ["D:\\\\old\\\\path.js"]',
        'enabled = true',
        '[mcp_servers.apiyi.env]',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')
    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.args).toEqual([FAKE_ENTRY])
  })

  it('converges a stale Electron-as-Node entry to the freshly resolved node form', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/old/uninstalled/electron"',
        'args = ["/old/uninstalled/resources/apiyi-mcp/dist/index.js"]',
        'enabled = true',
        '[mcp_servers.apiyi.env]',
        'ELECTRON_RUN_AS_NODE = "1"',
      ].join('\n'),
      'utf8',
    )
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')
    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('skips when the entry is already exactly canonical (steady state, idempotent)', async () => {
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(first).toBe('seeded')
    const before = await fs.readFile(configPath, 'utf8')

    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(second).toBe('skipped')
    expect(await fs.readFile(configPath, 'utf8')).toBe(before) // no rewrite
  })

  it('skips the canonical Electron-fallback form too (extraEnv considered)', async () => {
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/app/CATIMATION.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(first).toBe('seeded')
    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/app/CATIMATION.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(second).toBe('skipped')
  })

  it('re-converges when the resolved command changes (e.g. node installed later)', async () => {
    await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/app/CATIMATION.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('repaired')
    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('treats malformed existing TOML as empty and rewrites a clean canonical entry', async () => {
    await fs.writeFile(configPath, 'this is = not [valid toml', 'utf8')
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('seeded')
    const apiyi = await readApiyi()
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.enabled).toBe(true)
  })
})
