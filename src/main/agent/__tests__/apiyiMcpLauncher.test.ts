import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  APIYI_MCP_ENV_SCAFFOLD,
  buildApiyiMcpConfigEntry,
  getApiyiMcpEntryPath,
} from '../apiyiMcpLauncher'

describe('getApiyiMcpEntryPath', () => {
  it('returns <resourcesPath>/apiyi-mcp/dist/index.js when packaged', () => {
    const p = getApiyiMcpEntryPath({
      appPath: '/ignored/when/packaged',
      isPackaged: true,
      resourcesPath: '/Applications/CATIMATION.app/Contents/Resources',
    })
    expect(p).toBe(
      path.join(
        '/Applications/CATIMATION.app/Contents/Resources',
        'apiyi-mcp',
        'dist',
        'index.js',
      ),
    )
  })

  it('returns <appPath>/resources/apiyi-mcp/dist/index.js when unpackaged (dev)', () => {
    const p = getApiyiMcpEntryPath({
      appPath: '/repo/temp-ai-image-master-source',
      isPackaged: false,
    })
    expect(p).toBe(
      path.join(
        '/repo/temp-ai-image-master-source',
        'resources',
        'apiyi-mcp',
        'dist',
        'index.js',
      ),
    )
  })

  it('ignores resourcesPath when not packaged', () => {
    const p = getApiyiMcpEntryPath({
      appPath: '/dev/root',
      isPackaged: false,
      resourcesPath: '/should/be/ignored',
    })
    expect(p).toBe(
      path.join('/dev/root', 'resources', 'apiyi-mcp', 'dist', 'index.js'),
    )
  })
})

describe('APIYI_MCP_ENV_SCAFFOLD', () => {
  // Pins the contract for the JSON-editor scaffold the user sees on first
  // boot. Empty APIYI_API_KEY is the *only* field they must edit; everything
  // else is sensible defaults aligned with the working Cursor mcp.json shape.

  it('ships the apiyi.com base URL (NOT bltcy.ai), so sk- keys validate', () => {
    expect(APIYI_MCP_ENV_SCAFFOLD.APIYI_BASE_URL).toBe('https://api.apiyi.com')
  })

  it('leaves APIYI_API_KEY empty so the JSON editor surfaces it visibly', () => {
    expect(APIYI_MCP_ENV_SCAFFOLD.APIYI_API_KEY).toBe('')
  })

  it('does NOT bake ELECTRON_RUN_AS_NODE into the scaffold (only injected via extraEnv on the Electron-as-Node fallback)', () => {
    // System-node is the standard path; `command = "node"` makes ELECTRON_RUN_AS_NODE
    // meaningless. We only need that flag when `command = electron.exe`, in which
    // case `resolveApiyiCommand` returns it via `extraEnv`. Keeping it out of the
    // shared scaffold prevents leaking a misleading env into the system-node path.
    expect(APIYI_MCP_ENV_SCAFFOLD.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('pre-fills a sane model + long-context tokens + 30min timeout', () => {
    // Default is the best price/perf 3.x model. The other two canonical
    // choices (`gemini-3.1-pro-preview-thinking` for thinking-heavy work and
    // `gemini-3-flash-preview` for cheapest-token batch work) are documented
    // in apiyiMcpLauncher.ts but NOT enforced — the JSON editor accepts any
    // string. Bumping this default is a deliberate UX change; if you flip it,
    // also update the steady-state TOML fixture in apiyiMcpSeed.test.ts.
    expect(APIYI_MCP_ENV_SCAFFOLD.GEMINI_MODEL).toBe('gemini-3.5-flash')
    expect(APIYI_MCP_ENV_SCAFFOLD.GEMINI_MAX_OUTPUT_TOKENS).toBe('65536')
    expect(APIYI_MCP_ENV_SCAFFOLD.GEMINI_TIMEOUT).toBe('1800000')
  })

  it('is frozen so accidental imports cannot mutate the shared template', () => {
    expect(Object.isFrozen(APIYI_MCP_ENV_SCAFFOLD)).toBe(true)
  })
})

describe('buildApiyiMcpConfigEntry', () => {
  // The seeded env block is a full scaffold (NOT empty {}) so the user only
  // has to fill APIYI_API_KEY in the JSON editor.

  it('builds a disabled stub with the full env scaffold pre-filled (system-node path)', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      command: '/path/to/node',
      enabled: false,
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: false,
      env: { ...APIYI_MCP_ENV_SCAFFOLD },
    })
  })

  it('merges extraEnv on top of the scaffold for the Electron-as-Node fallback path', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      command: '/path/to/electron.exe',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      enabled: false,
    })
    expect(entry.command).toBe('/path/to/electron.exe')
    expect(entry.env).toEqual({
      ...APIYI_MCP_ENV_SCAFFOLD,
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('builds an enabled stub with the same scaffold (env is independent of enabled)', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      command: '/path/to/node',
      enabled: true,
    })
    expect(entry.enabled).toBe(true)
    expect(entry.env).toEqual({ ...APIYI_MCP_ENV_SCAFFOLD })
  })

  it('returns a fresh env object per call so callers can mutate safely', () => {
    const a = buildApiyiMcpConfigEntry({ entryPath: '/x', command: '/y', enabled: false })
    const b = buildApiyiMcpConfigEntry({ entryPath: '/x', command: '/y', enabled: false })
    expect(a.env).not.toBe(b.env)
    expect(a.env).not.toBe(APIYI_MCP_ENV_SCAFFOLD)
    // Mutating one copy must not affect the next call.
    a.env.APIYI_API_KEY = 'sk-mutated'
    expect(b.env.APIYI_API_KEY).toBe('')
  })
})
