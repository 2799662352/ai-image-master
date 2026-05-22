import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { mergeEnvWithScaffold, seedApiyiMcpEntry } from '../apiyiMcpSeed'
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

describe('mergeEnvWithScaffold', () => {
  it('returns null when existing env already has every scaffold key', () => {
    const complete: Record<string, string> = { ...APIYI_MCP_ENV_SCAFFOLD, APIYI_API_KEY: 'sk-user' }
    expect(mergeEnvWithScaffold(complete)).toBeNull()
  })

  it('fills missing scaffold keys when existing env is empty', () => {
    const merged = mergeEnvWithScaffold({})
    expect(merged).not.toBeNull()
    expect(merged).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD })
  })

  it('preserves every user-set value and only fills the gaps', () => {
    const userEnv = {
      APIYI_API_KEY: 'sk-user-keep',
      GEMINI_MODEL: 'gemini-2.5-flash',
      // missing: APIYI_BASE_URL, GEMINI_MAX_OUTPUT_TOKENS, GEMINI_TIMEOUT
      // NOTE: ELECTRON_RUN_AS_NODE is NOT in the scaffold by design — it's
      // only meaningful for the Electron-as-Node fallback and gets layered on
      // via `extraEnv` in resolveApiyiCommand, never via the scaffold.
    }
    const merged = mergeEnvWithScaffold(userEnv)
    expect(merged).not.toBeNull()
    expect(merged!.APIYI_API_KEY).toBe('sk-user-keep')      // ← preserved
    expect(merged!.GEMINI_MODEL).toBe('gemini-2.5-flash')   // ← preserved (NOT overwritten with scaffold default)
    expect(merged!.APIYI_BASE_URL).toBe('https://api.apiyi.com') // ← filled
    expect(merged!.GEMINI_MAX_OUTPUT_TOKENS).toBe('65536')  // ← filled
    expect(merged!.GEMINI_TIMEOUT).toBe('1800000')          // ← filled
    expect(merged!.ELECTRON_RUN_AS_NODE).toBeUndefined()    // ← NOT in scaffold; not filled
  })

  it('treats a non-object env (e.g. user wrote env = "broken") as empty and replaces with scaffold', () => {
    const merged = mergeEnvWithScaffold('not an object')
    expect(merged).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD })
  })

  it('treats undefined env as empty and returns the full scaffold', () => {
    const merged = mergeEnvWithScaffold(undefined)
    expect(merged).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD })
  })
})

describe('seedApiyiMcpEntry', () => {
  // Three outcomes:
  //   'seeded'     → entry didn't exist; fresh full scaffold written
  //   'backfilled' → entry existed but env was missing scaffold keys;
  //                  add the missing ones without ever overwriting user values
  //   'skipped'    → entry exists and env already has every scaffold key
  // command / args / enabled / tool_timeout_sec are NEVER touched on the
  // backfill path.

  it('creates config.toml with disabled apiyi stub + pre-filled env scaffold', async () => {
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('seeded')

    const raw = await fs.readFile(configPath, 'utf8')
    const parsed = parseToml(raw) as Record<string, unknown>
    const servers = parsed.mcp_servers as Record<string, unknown>
    expect(servers).toBeDefined()
    const apiyi = servers.apiyi as {
      command: string
      args: string[]
      enabled: boolean
      env: Record<string, string>
    }
    expect(apiyi.command).toBe(FAKE_NODE)
    expect(apiyi.args).toEqual([FAKE_ENTRY])
    expect(apiyi.enabled).toBe(false)
    // The scaffolded env: only APIYI_API_KEY is empty for the user to fill.
    expect(apiyi.env.APIYI_API_KEY).toBe('')
    expect(apiyi.env.APIYI_BASE_URL).toBe('https://api.apiyi.com')
    expect(apiyi.env.GEMINI_MODEL).toBe('gemini-3.5-flash')
    expect(apiyi.env.GEMINI_MAX_OUTPUT_TOKENS).toBe('65536')
    expect(apiyi.env.GEMINI_TIMEOUT).toBe('1800000')
    // ELECTRON_RUN_AS_NODE is intentionally NOT in the scaffold — the
    // Electron-as-Node fallback adds it via `extraEnv`, the system-node path
    // doesn't need it. A bare seed (no extraEnv) does not write it.
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('layers caller-supplied extraEnv on top of the scaffold (Electron-as-Node fallback)', async () => {
    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: '/path/to/electron.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(action).toBe('seeded')

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string
      env: Record<string, string>
    }
    expect(apiyi.command).toBe('/path/to/electron.exe')
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBe('1') // ← from extraEnv
    expect(apiyi.env.APIYI_BASE_URL).toBe('https://api.apiyi.com') // ← from scaffold
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
      command: FAKE_NODE,
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

  it('backfills missing env keys but NEVER overwrites user-set values', async () => {
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
        'GEMINI_MODEL = "gemini-2.5-flash"',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('backfilled')

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
    // command / args / enabled — NEVER touched on backfill path.
    expect(apiyi.command).toBe('/custom/node')
    expect(apiyi.args).toEqual(['/custom/path.js'])
    expect(apiyi.enabled).toBe(true)
    // User-set env values preserved verbatim.
    expect(apiyi.env.APIYI_API_KEY).toBe('sk-user-already-set')
    expect(apiyi.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(apiyi.env.GEMINI_MODEL).toBe('gemini-2.5-flash') // user override, NOT scaffold default
    // Missing scaffold fields backfilled.
    expect(apiyi.env.APIYI_BASE_URL).toBe('https://api.apiyi.com')
    expect(apiyi.env.GEMINI_MAX_OUTPUT_TOKENS).toBe('65536')
    expect(apiyi.env.GEMINI_TIMEOUT).toBe('1800000')
  })

  it('backfills the entire env scaffold when existing entry has no env block at all', async () => {
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
      command: FAKE_NODE,
    })
    expect(action).toBe('backfilled')

    const parsed = parseToml(await fs.readFile(configPath, 'utf8')) as Record<
      string,
      unknown
    >
    const apiyi = (parsed.mcp_servers as Record<string, unknown>).apiyi as {
      command: string
      env: Record<string, string>
    }
    expect(apiyi.command).toBe('/c') // command preserved
    expect(apiyi.env).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD })
  })

  it('skips when existing entry already has every scaffold key (steady state)', async () => {
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/c"',
        'args = ["/a"]',
        'enabled = true',
        '',
        '[mcp_servers.apiyi.env]',
        'APIYI_API_KEY = "sk-keep"',
        'APIYI_BASE_URL = "https://api.apiyi.com"',
        'GEMINI_MODEL = "gemini-3.5-flash"',
        'GEMINI_MAX_OUTPUT_TOKENS = "65536"',
        'GEMINI_TIMEOUT = "1800000"',
        'ELECTRON_RUN_AS_NODE = "1"',
        '',
      ].join('\n'),
      'utf8',
    )

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(action).toBe('skipped')
  })

  it('is idempotent on repeated boots (seed → skip; backfill → skip)', async () => {
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(first).toBe('seeded')

    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(second).toBe('skipped')
  })

  it('post-backfill is also idempotent (backfill → skip on next boot)', async () => {
    // Start with a legacy empty-env entry (what older seeds produced).
    await fs.writeFile(
      configPath,
      [
        '[mcp_servers.apiyi]',
        'command = "/c"',
        'args = ["/a"]',
        'enabled = false',
        '',
        '[mcp_servers.apiyi.env]',
        '',
      ].join('\n'),
      'utf8',
    )
    const first = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(first).toBe('backfilled')

    const second = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
    })
    expect(second).toBe('skipped')
  })

  it('survives malformed existing TOML by treating it as empty (logs warning)', async () => {
    await fs.writeFile(configPath, 'this is not = valid [[toml', 'utf8')

    const action = await seedApiyiMcpEntry({
      personalConfigToml: configPath,
      entryPath: FAKE_ENTRY,
      command: FAKE_NODE,
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
