/**
 * 把一张远端图的字节抓回来,抖动了就再试。
 *
 * 为什么值得重试:这一步的产物要先落本地盘再推 COS,而本地副本是在抓取成功
 * 之后才写的。所以这一次失败就是双重失败 —— 本地和 COS 都没有,history 只能
 * 退回模型直出那条几小时后过期的预签名 URL,用户第二天回来看到的是裂图。
 *
 * 但只重试可能自愈的失败:403(签名过期)、404 这类确定性错误再试也是一样的
 * 结果,只会让调用方多等几十秒。
 */

import { createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PART_SUFFIX, renameWithRetry } from './atomicFile'

export type FetchImageBytesResult =
  | { ok: true; body: Buffer; contentType?: string }
  | { ok: false; error: string }

export interface FetchImageBytesOptions {
  /** 总尝试次数(含首次)。 */
  attempts?: number
  /** 单次尝试的超时。 */
  timeoutMs?: number
  /** 首次重试前的等待,其后翻倍。 */
  delayMs?: number
  fetchImpl?: typeof fetch
}

/** 可能自愈的 HTTP 状态:限流、网关抖动、上游还没把对象写完。 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()

export async function fetchImageBytes(
  url: string,
  options: FetchImageBytesOptions = {},
): Promise<FetchImageBytesResult> {
  const {
    attempts = 3,
    timeoutMs = 30_000,
    delayMs = 1_000,
    fetchImpl = fetch,
  } = options

  let lastError = 'fetch failed'

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs * 2 ** (attempt - 1))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) {
        lastError = `fetch ${response.status}`
        // 确定性失败:立刻交还结果,别让调用方白等两轮退避。
        if (!isRetryableStatus(response.status)) return { ok: false, error: lastError }
        continue
      }

      const body = Buffer.from(await response.arrayBuffer())
      if (body.byteLength === 0) {
        lastError = 'empty body after fetch'
        continue
      }

      const contentType = response.headers.get('content-type') ?? undefined
      return { ok: true, body, ...(contentType ? { contentType } : {}) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, error: lastError }
}

export type FetchImageToFileResult =
  | { ok: true; path: string; bytes: number; contentType?: string }
  | { ok: false; error: string }

/**
 * `fetchImageBytes` 的流式版本:边收边写盘,内存占用与图片大小无关。
 *
 * 为什么需要它:`index.ts` 里记着一次 P0 闪退 ——「N 份 30MB+ buffer 同时驻留
 * 主进程堆 → OOM」。当时靠并发闸门止血,这里才是根治。
 *
 * 重试与错误分类**完全沿用** fetchImageBytes 的口径(403/404 立刻放弃、
 * 408/429/5xx 才重试、空响应体判失败),只把「攒 Buffer」换成「写文件」。判据在
 * 响应头阶段就完成,与 body 如何消费解耦,所以两者不会漂移。
 *
 * 用 `pipeline` 而非裸 `pipe`:前者尊重背压,内存被钉在 highWaterMark;手动
 * `.on('data')` + `.write()` 不管背压的话,队列会无限涨,那时流式比全量 buffer 更糟。
 */
export async function fetchImageToFile(
  url: string,
  destPath: string,
  options: FetchImageBytesOptions = {},
): Promise<FetchImageToFileResult> {
  const { attempts = 3, timeoutMs = 30_000, delayMs = 1_000, fetchImpl = fetch } = options
  const partPath = `${destPath}${PART_SUFFIX}`
  let lastError = 'fetch failed'

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs * 2 ** (attempt - 1))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) {
        lastError = `fetch ${response.status}`
        // 确定性失败:立刻交还结果,别让调用方白等两轮退避。
        if (!isRetryableStatus(response.status)) return { ok: false, error: lastError }
        continue
      }
      if (!response.body) {
        lastError = 'response has no body'
        continue
      }

      let received = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.byteLength
          cb(null, chunk)
        },
      })
      try {
        await pipeline(
          Readable.fromWeb(response.body as never),
          counter,
          createWriteStream(partPath),
        )
      } catch (e) {
        await fsp.unlink(partPath).catch(() => undefined)
        lastError = e instanceof Error ? e.message : String(e)
        continue
      }

      if (received === 0) {
        await fsp.unlink(partPath).catch(() => undefined)
        lastError = 'empty body after fetch'
        continue
      }

      await renameWithRetry(partPath, destPath)
      const contentType = response.headers.get('content-type') ?? undefined
      return { ok: true, path: destPath, bytes: received, ...(contentType ? { contentType } : {}) }
    } catch (error) {
      await fsp.unlink(partPath).catch(() => undefined)
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, error: lastError }
}
