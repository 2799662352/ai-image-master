// 上游生成视频的落盘。
//
// 这条路径的失败后果不可逆:落盘失败意味着本地和 COS 都没有副本,只剩上游那条
// 一天后过期的地址,而且没有第二轮补救。所以它比一般的下载多做三件事 —— 写临时
// 文件、校验字节数、原子落位。
//
// 为什么不用 Electron 的 DownloadItem:业界五个对标项目(VS Code、Signal、
// Joplin、Logseq、electron-updater)无一使用,且它会在应用退出时删掉半成品文件、
// 缺 lastModified 时静默从 0 重下。完整理由见
// docs/superpowers/specs/2026-07-31-electron-43-upgrade-and-streaming-downloads-design.md

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { net as electronNet } from 'electron'
import { PART_SUFFIX, renameWithRetry } from '../../utils/atomicFile'

// 视频侧的既有调用方还在用这两个名字,原样透出,避免无谓的调用点改动。
export { cleanupOrphanParts, renameWithRetry } from '../../utils/atomicFile'
export type { RenameWithRetryOptions } from '../../utils/atomicFile'

/**
 * 空闲超时:**60 秒没有收到任何新字节**才判超时。
 *
 * 刻意不设整体超时。对标的五个项目无一对下载设整体超时 —— GB 级文件在慢网下会被
 * 整体超时误杀,而这种失败在测试环境(小文件、快网)永远复现不出来。Joplin 的
 * 注释说得最直白:「60s is per-socket-idle, not total」。
 */
const IDLE_TIMEOUT_MS = 60_000

/** net.request 的最小契约 —— 只用到这三样,便于单测注入。 */
interface MinimalRequest {
  on: (event: string, listener: (arg?: unknown) => void) => unknown
  end: () => void
  abort: () => void
}

export interface DownloadToFileOptions {
  idleTimeoutMs?: number
  /** 测试注入点;生产走 Electron 的 net。 */
  net?: { request: (url: string) => unknown }
}

export interface DownloadToFileResult {
  path: string
  bytes: number
  /** 上游声明的字节数;上游没给就是 undefined。 */
  declaredBytes?: number
}

/** Electron 的 IncomingMessage.headers 取值可能是数组,统一取第一个。 */
function headerValue(headers: unknown, name: string): string | undefined {
  const raw = (headers as Record<string, string | string[]> | undefined)?.[name]
  if (Array.isArray(raw)) return raw[0]
  return typeof raw === 'string' ? raw : undefined
}

/**
 * 流式下载到 `<destPath>.part`。成功返回 `.part` 的路径与字节数;失败清理残留。
 *
 * ⚠️ 必须用 net.request 而非 net.fetch:上游视频代理会在响应头里塞 prompt 派生的
 * 中文文件名(如 `Content-Disposition: filename="做自然回归…mp4"`),net.fetch 走
 * undici 的 Headers(Web 标准,要求 Latin1 ByteString)重建响应头,遇到 >255 的
 * 中文字节直接抛 TypeError;该异常发生在 Electron 内部的 response 回调里 → 变
 * uncaughtException 被全局吞掉,而 fetch 的 Promise 永不 settle。见
 * electron/electron#42244(官方已确认 status/confirmed,至今 open,43 未修)。
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadToFileOptions = {},
): Promise<DownloadToFileResult> {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const netImpl = options.net ?? electronNet
  const partPath = `${destPath}${PART_SUFFIX}`

  const request = netImpl.request(url) as MinimalRequest

  const response = await new Promise<
    NodeJS.ReadableStream & { statusCode?: number; headers?: unknown; resume?: () => void }
  >((resolve, reject) => {
    request.on('response', (res) => resolve(res as never))
    request.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    request.end()
  })

  const status = response.statusCode ?? 0
  if (status < 200 || status >= 300) {
    response.resume?.()
    throw new Error(`video download failed: HTTP ${status}`)
  }

  let received = 0
  let idleTimer: NodeJS.Timeout | undefined
  let stalled = false

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      stalled = true
      try {
        request.abort()
      } catch {
        /* SDK 内部可能已清理 */
      }
    }, idleTimeoutMs)
    idleTimer.unref?.()
  }

  // 用 Transform 喂看门狗,而不是 response.on('data') —— 挂 'data' 监听会把流切到
  // flowing 模式,和 pipeline 抢数据。
  const watchdog = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.byteLength
      armIdle()
      cb(null, chunk)
    },
  })

  armIdle()
  try {
    await pipeline(response, watchdog, createWriteStream(partPath))
  } catch (e) {
    await fs.unlink(partPath).catch(() => undefined)
    // abort() 走 Electron 的 `_die()` → `this._response.destroy(err)`,而 abort
    // **不传 err**,所以流是"无错销毁",pipeline 抛的是 ERR_STREAM_PREMATURE_CLOSE
    // 而不是我们的超时原因。靠 stalled 标志把它翻译回人话。
    if (stalled) {
      throw new Error(`video download stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`)
    }
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }

  const declared = Number(headerValue(response.headers, 'content-length'))
  return {
    path: partPath,
    bytes: received,
    ...(Number.isFinite(declared) && declared > 0 ? { declaredBytes: declared } : {}),
  }
}

/**
 * 下载 → 校验 → 原子落位。返回最终路径。
 *
 * 校验只比对 Content-Length,不做 checksum。业界的分界线是「下载物会不会被
 * 执行/安装」:会的全都校验(electron-updater sha512、Signal sha512+Ed25519、
 * VS Code 更新包 sha256),纯内容数据普遍不做。我们下的是视频内容,属于后者;
 * 而且上游未必给 hash,字节数比对不依赖上游配合,成本几乎为零,能抓住绝大多数
 * 截断场景。
 */
export async function downloadVideoToDisk(
  url: string,
  destPath: string,
  options: DownloadToFileOptions = {},
): Promise<string> {
  const { path: partPath, bytes, declaredBytes } = await downloadToFile(url, destPath, options)

  const fail = async (message: string): Promise<never> => {
    await fs.unlink(partPath).catch(() => undefined)
    throw new Error(message)
  }

  if (bytes === 0) await fail('video download produced an empty file')
  if (declaredBytes != null && declaredBytes !== bytes) {
    await fail(`video download incomplete: got ${bytes} bytes, expected ${declaredBytes}`)
  }

  await renameWithRetry(partPath, destPath)
  return destPath
}

