import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
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

describe('buildApiyiMcpConfigEntry', () => {
  // Per design: env is ALWAYS empty `{}` regardless of `enabled`. The user
  // fills `APIYI_API_KEY`, `ELECTRON_RUN_AS_NODE`, `GEMINI_MODEL` themselves
  // via the MCP JSON editor. No auto-write of secrets / runtime flags.

  it('builds a disabled stub: command + args + enabled=false + env={}', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      nodeBin: '/path/to/node',
      enabled: false,
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: false,
      env: {},
    })
  })

  it('builds an enabled stub with the same empty env shape', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      nodeBin: '/path/to/node',
      enabled: true,
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: true,
      env: {},
    })
  })

  it('env is always {} — no auto-injection of secrets or ELECTRON_RUN_AS_NODE', () => {
    for (const enabled of [true, false]) {
      const entry = buildApiyiMcpConfigEntry({
        entryPath: '/x',
        nodeBin: '/y',
        enabled,
      })
      expect(entry.env).toEqual({})
      expect(Object.keys(entry.env)).toHaveLength(0)
    }
  })

  it('returns a fresh env object per call so callers can mutate safely', () => {
    const a = buildApiyiMcpConfigEntry({ entryPath: '/x', nodeBin: '/y', enabled: false })
    const b = buildApiyiMcpConfigEntry({ entryPath: '/x', nodeBin: '/y', enabled: false })
    expect(a.env).not.toBe(b.env)
  })
})
