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
  it('builds a disabled entry with command + args + empty env', () => {
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

  it('builds an enabled entry with literal APIYI_API_KEY when apiKey is provided', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      nodeBin: '/path/to/node',
      enabled: true,
      apiKey: 'sk-live-abc123',
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: true,
      env: { APIYI_API_KEY: 'sk-live-abc123' },
    })
  })

  it('disabled form produces empty env regardless of apiKey', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: false,
      apiKey: 'sk-should-be-ignored',
    })
    expect(entry.env).toEqual({})
  })

  it('enabled without apiKey emits empty env (defensive)', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
    })
    expect(entry.env).toEqual({})
  })

  it('apiKey value is written verbatim — no transformation', () => {
    const specialKey = 'sk-$pecial "quoted" `tick`'
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
      apiKey: specialKey,
    })
    expect(entry.env).toEqual({ APIYI_API_KEY: specialKey })
  })
})
