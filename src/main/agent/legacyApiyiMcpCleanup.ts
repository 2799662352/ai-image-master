import { promises as fs } from 'node:fs'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import { atomicWriteFile } from './codexConfigStore'

/**
 * apiyi MCP（Gemini 看图 / 理解）已从应用里移除：不再打包脚本、不再往
 * codex 启动参数里注入 `mcp_servers.apiyi.*`。
 *
 * 但老版本每次启动都会把 `[mcp_servers.apiyi]` 强制写进用户的
 * `~/.codex/config.toml`（command + args 指向应用自带的
 * `…/apiyi-mcp/dist/index.js` + 一份 env 脚手架）。升级后这条会一直留着，
 * 让 codex 去拉起一个已经不存在的脚本。所以启动时清一次。
 *
 * 清理的边界（宁可少清，不误伤）：
 *  - 只动 `mcp_servers.apiyi` 这一条，且 `args[0]` 必须是应用种下的那种路径
 *    （以 `/apiyi-mcp/dist/index.js` 结尾，反斜杠先归一化）。用户自己写的、
 *    指向别处的同名条目原样保留。
 *  - TOML 解析失败就不动文件。种子当年遇到坏文件会「当空文档重写」，那是
 *    为了保证应用条目存在；清理没有这个需要，不该因为清理去覆盖用户的坏文件。
 *  - 没有要清的就不写盘；清完 `mcp_servers` 若空了，一并去掉。
 *
 * 结果：
 *  - `'removed'`         清掉了应用种下的条目；
 *  - `'absent'`          文件不存在 / 没有 apiyi 条目，什么都没写；
 *  - `'kept-user-entry'` 有 apiyi 条目但不是应用种的，没动；
 *  - `'malformed'`       TOML 解析失败，没动。
 *
 * 幂等，可以每次启动都调。
 */
export type LegacyApiyiCleanupResult = 'removed' | 'absent' | 'kept-user-entry' | 'malformed'

export interface LegacyApiyiCleanupInput {
  personalConfigToml: string
}

/** 应用当年种下的入口脚本路径特征（Windows 反斜杠先归一成 `/`）。 */
const APP_SEEDED_ENTRY_SUFFIX = '/apiyi-mcp/dist/index.js'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function looksAppSeeded(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false
  const args = entry.args
  if (!Array.isArray(args) || typeof args[0] !== 'string') return false
  return args[0].replace(/\\/g, '/').toLowerCase().endsWith(APP_SEEDED_ENTRY_SUFFIX)
}

export async function removeLegacyApiyiMcpEntry(
  input: LegacyApiyiCleanupInput,
): Promise<LegacyApiyiCleanupResult> {
  let raw: string
  try {
    raw = await fs.readFile(input.personalConfigToml, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
    throw err
  }
  if (!raw.trim()) return 'absent'

  let doc: Record<string, unknown>
  try {
    doc = parseToml(raw) as Record<string, unknown>
  } catch {
    return 'malformed'
  }

  const servers = doc.mcp_servers
  if (!isPlainObject(servers) || !('apiyi' in servers)) return 'absent'
  if (!looksAppSeeded(servers.apiyi)) return 'kept-user-entry'

  const { apiyi: _removed, ...restServers } = servers
  const nextDoc: Record<string, unknown> = { ...doc }
  if (Object.keys(restServers).length > 0) {
    nextDoc.mcp_servers = restServers
  } else {
    delete nextDoc.mcp_servers
  }

  await atomicWriteFile(
    input.personalConfigToml,
    iarnaToml.stringify(nextDoc as unknown as iarnaToml.JsonMap),
  )
  return 'removed'
}
