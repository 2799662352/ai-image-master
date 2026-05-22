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
  it('builds a disabled entry with command + args + ELECTRON_RUN_AS_NODE env only', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/path/to/dist/index.js',
      nodeBin: '/path/to/node',
      enabled: false,
    })
    expect(entry).toEqual({
      command: '/path/to/node',
      args: ['/path/to/dist/index.js'],
      enabled: false,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })

  it('builds an enabled entry with literal APIYI_API_KEY + default GEMINI_MODEL when apiKey is provided without an explicit videoModel', () => {
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
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        APIYI_API_KEY: 'sk-live-abc123',
        GEMINI_MODEL: 'gemini-3.5-flash',
      },
    })
  })

  it('disabled form produces ELECTRON_RUN_AS_NODE-only env regardless of apiKey', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: false,
      apiKey: 'sk-should-be-ignored',
    })
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('enabled without apiKey emits ELECTRON_RUN_AS_NODE-only env (defensive)', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
    })
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('apiKey value is written verbatim — no transformation', () => {
    const specialKey = 'sk-$pecial "quoted" `tick`'
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
      apiKey: specialKey,
    })
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      APIYI_API_KEY: specialKey,
      GEMINI_MODEL: 'gemini-3.5-flash',
    })
  })

  it('writes GEMINI_MODEL when enabled + apiKey + videoModel are all provided', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
      apiKey: 'sk-live',
      videoModel: 'gemini-2.5-flash',
    })
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      APIYI_API_KEY: 'sk-live',
      GEMINI_MODEL: 'gemini-2.5-flash',
    })
  })

  it('falls back to DEFAULT_VIDEO_MODEL_ID when videoModel is empty string', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
      apiKey: 'sk-live',
      videoModel: '',
    })
    expect(entry.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      APIYI_API_KEY: 'sk-live',
      GEMINI_MODEL: 'gemini-3.5-flash',
    })
  })

  it('ignores videoModel when apiKey is missing (env stays ELECTRON_RUN_AS_NODE-only)', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: true,
      videoModel: 'gemini-2.5-pro',
    })
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('ignores videoModel when disabled', () => {
    const entry = buildApiyiMcpConfigEntry({
      entryPath: '/x',
      nodeBin: '/y',
      enabled: false,
      apiKey: 'sk-live',
      videoModel: 'gemini-2.5-pro',
    })
    expect(entry.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('ELECTRON_RUN_AS_NODE is always present so spawn never hits Electron GUI subsystem', () => {
    // Regression test for the "ready + 0 tools" bug: without this env var,
    // Electron's startup writes Chromium/GPU noise to stdout and breaks the
    // MCP stdio framing. Always set it, even on disabled entries.
    for (const enabled of [true, false]) {
      for (const withKey of [true, false]) {
        const entry = buildApiyiMcpConfigEntry({
          entryPath: '/x',
          nodeBin: '/y',
          enabled,
          apiKey: withKey ? 'sk-live' : undefined,
        })
        expect(entry.env.ELECTRON_RUN_AS_NODE).toBe('1')
      }
    }
  })
})
