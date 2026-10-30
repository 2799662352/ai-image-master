import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseToml } from 'toml'
import { removeLegacyApiyiMcpEntry } from '../legacyApiyiMcpCleanup'

// apiyi MCP 已从应用里移除。老版本每次启动都会把 `[mcp_servers.apiyi]` 强制写进
// 用户的 ~/.codex/config.toml，所以升级后要在启动时把这条清掉，否则 codex 还会
// 去拉起一个应用已经不再打包的脚本。清理只动 apiyi 这一条，别的配置原样保留。

describe('removeLegacyApiyiMcpEntry', () => {
  let dir: string
  let configPath: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'legacy-apiyi-'))
    configPath = path.join(dir, 'config.toml')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // 老种子写出来的形状：command + args + enabled + env 表（APIYI_API_KEY 为空占位）。
  const seeded = (entry: string): string => [
    '[mcp_servers.apiyi]',
    'command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"',
    `args = [ ${JSON.stringify(entry)} ]`,
    'enabled = true',
    '',
    '  [mcp_servers.apiyi.env]',
    '  APIYI_BASE_URL = "https://api.apiyi.com"',
    '  GEMINI_MODEL = "gemini-3.5-flash"',
    '  APIYI_API_KEY = ""',
    '',
  ].join('\n')

  it('文件不存在：返回 absent，也不凭空创建文件', async () => {
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('absent')
    await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('没有 apiyi 条目：返回 absent，文件一个字节都不动', async () => {
    const original = '# 我的注释\n[mcp_servers.other]\ncommand = "x"\nargs = []\n'
    await writeFile(configPath, original, 'utf8')
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('absent')
    expect(await readFile(configPath, 'utf8')).toBe(original)
  })

  it('清掉应用种下的 apiyi 条目（含 env 子表），其它服务器与顶层键原样保留', async () => {
    const entry = 'D:\\tecx\\app\\resources\\apiyi-mcp\\dist\\index.js'
    // 顶层键必须放在所有表之前，否则 TOML 会把它算进前一张表里。
    const topLevel = 'model = "gpt-5.5"\n\n'
    const others = [
      '[mcp_servers.cinematography_kb]',
      'command = "node"',
      'args = ["kb.js"]',
      'enabled = true',
      '',
      '[projects."d:\\\\work"]',
      'trust_level = "trusted"',
      '',
    ].join('\n')
    await writeFile(configPath, `${topLevel}${seeded(entry)}\n${others}`, 'utf8')

    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('removed')

    const after = parseToml(await readFile(configPath, 'utf8')) as Record<string, any>
    expect(after.mcp_servers.apiyi).toBeUndefined()
    expect(after.mcp_servers.cinematography_kb).toEqual({
      command: 'node',
      args: ['kb.js'],
      enabled: true,
    })
    expect(after.model).toBe('gpt-5.5')
    expect(after.projects['d:\\work']).toEqual({ trust_level: 'trusted' })
  })

  it('打包后的路径（<resources>/apiyi-mcp/dist/index.js，POSIX 斜杠）同样识别', async () => {
    await writeFile(
      configPath,
      `${seeded('/Applications/CATIMATION.app/Contents/Resources/apiyi-mcp/dist/index.js')}\n`,
      'utf8',
    )
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('removed')
  })

  it('apiyi 是 mcp_servers 里唯一一条时，空的 mcp_servers 表也一并去掉', async () => {
    await writeFile(
      configPath,
      `model = "gpt-5.5"\n\n${seeded('D:\\app\\resources\\apiyi-mcp\\dist\\index.js')}`,
      'utf8',
    )
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('removed')
    const after = parseToml(await readFile(configPath, 'utf8')) as Record<string, any>
    expect(after.mcp_servers).toBeUndefined()
    expect(after.model).toBe('gpt-5.5')
  })

  it('用户自己写的、指向别处的 apiyi 条目不碰（只认应用自己种的那种路径）', async () => {
    const mine = [
      '[mcp_servers.apiyi]',
      'command = "python"',
      'args = ["/home/me/my-apiyi/server.py"]',
      'enabled = true',
      '',
    ].join('\n')
    await writeFile(configPath, mine, 'utf8')
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('kept-user-entry')
    expect(await readFile(configPath, 'utf8')).toBe(mine)
  })

  it('TOML 解析失败：不改写（不像种子那样把坏文件重写掉），返回 malformed', async () => {
    const broken = '[mcp_servers.apiyi\ncommand = = =\n'
    await writeFile(configPath, broken, 'utf8')
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('malformed')
    expect(await readFile(configPath, 'utf8')).toBe(broken)
  })

  it('幂等：清完再调一次是 absent', async () => {
    await writeFile(
      configPath,
      seeded('D:\\app\\resources\\apiyi-mcp\\dist\\index.js'),
      'utf8',
    )
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('removed')
    expect(await removeLegacyApiyiMcpEntry({ personalConfigToml: configPath })).toBe('absent')
  })
})
