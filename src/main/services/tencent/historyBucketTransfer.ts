// src/main/services/tencent/historyBucketTransfer.ts
//
// 把媒体桶里的处理结果(智能去字幕视频 / 分镜切图子图)转存到历史记录页
// 使用的公开读桶,换取**永久公网 URL**。
//
// 为什么需要转存:免密钥(STS)模式下,媒体桶的签名 URL 实际寿命受票据
// 限制(≤30 分钟),历史记录里的结果很快就打不开。历史桶(image-master)
// 是公开读的 —— 生成图/生成视频的历史记录就是靠它做到「永不过期」,这里
// 复用同一条链路:
//
//   媒体桶签名 URL --fetch--> 本地临时文件 --uploadStreamToBucket--> 历史桶
//
// 上传走 STS image-history 票据(uploadStreamToBucket 内部),Key 必须落在
// `image-history/*` 前缀下,否则会被 COS 拒为 AccessDenied(见 stsCredentials)。
//
// 直接服务端 copy 不可行:源桶(scope=media 票据)与目标桶(image-history
// 票据)是两张不同的 STS 票据,一次 putObjectCopy 请求无法同时携带两份签名。

import { createWriteStream, promises as fsp } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { uploadStreamToBucket } from './cosClient'

// 与 mediaRelay.ts / main/index.ts 的 image-history IPC 保持同一桶(公开读)。
const HISTORY_BUCKET = 'image-master-1345773498'
const HISTORY_REGION = 'ap-guangzhou'

// 下载整体保险丝:视频可能数百 MB;按 0.5 MB/s 的保守带宽给上限,floor 3 分钟。
const DOWNLOAD_FLOOR_MS = 3 * 60 * 1000

/**
 * 下载尝试次数。转存失败的代价是**用户永久丢结果** —— 调用方会退回媒体桶签名
 * URL,而它在 STS 模式下只活 ≤30 分钟(见文件头)。上传半程有 COS SDK 的分片重试
 * 兜着,下载半程是裸 fetch,所以在这里补一次。形状与 seedanceClient.downloadVideo
 * 一致(两次尝试、无间隔):这类失败多是连接级的,立刻再试一次通常就过了。
 */
export const DOWNLOAD_ATTEMPTS = 2

/** 带上游状态码的下载错误,用来区分「再试有用」和「再试也是同样结果」。 */
class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`download failed: HTTP ${status}`)
    this.name = 'DownloadHttpError'
  }

  /** 4xx 说明签名 URL 已过期或对象不存在,重试无益;408/425/429 与 5xx 例外。 */
  get retryable(): boolean {
    if (this.status === 408 || this.status === 425 || this.status === 429) return true
    return this.status >= 500
  }
}

export interface TransferOptions {
  /** 媒体桶的(短寿命)签名 URL,调用时必须仍然有效。 */
  sourceUrl: string
  /** 目标 Key,必须以 `image-history/` 开头(STS 票据只授权该前缀)。 */
  key: string
  contentType?: string
}

/**
 * 下载一遍 sourceUrl 到 tmpPath,返回落盘字节数。createWriteStream 默认以 'w' 打开,
 * 所以重试会截断上一轮的残留字节,不会拼出坏文件。
 */
async function downloadOnce(sourceUrl: string, tmpPath: string): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_FLOOR_MS * 10)
  try {
    const res = await fetch(sourceUrl, { signal: controller.signal })
    if (!res.ok || !res.body) {
      throw new DownloadHttpError(res.status)
    }
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmpPath))
    return (await fsp.stat(tmpPath)).size
  } finally {
    clearTimeout(timer)
  }
}

async function downloadWithRetry(sourceUrl: string, tmpPath: string): Promise<number> {
  let lastError: unknown
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce(sourceUrl, tmpPath)
    } catch (e) {
      lastError = e
      // 签名 URL 过期 / 对象不存在:再试一次仍是同样结果,别白等。
      if (e instanceof DownloadHttpError && !e.retryable) throw e
      if (attempt === DOWNLOAD_ATTEMPTS) throw e
      console.warn(
        `[historyBucketTransfer] download attempt ${attempt}/${DOWNLOAD_ATTEMPTS} failed, retrying:`,
        e instanceof Error ? e.message : e,
      )
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * 下载 sourceUrl 到临时文件,再流式上传到历史桶,返回永久公网 URL。
 * 抛错时调用方应退回原签名 URL(转存是增强,不是关键路径)。
 */
export async function transferUrlToHistoryBucket(opts: TransferOptions): Promise<string> {
  if (!opts.key.startsWith('image-history/')) {
    throw new Error(`history bucket key must start with image-history/: ${opts.key}`)
  }

  const tmpPath = path.join(os.tmpdir(), `catimation-transfer-${randomBytes(8).toString('hex')}`)

  try {
    const size = await downloadWithRetry(opts.sourceUrl, tmpPath)
    if (size === 0) throw new Error('download produced empty file')

    // 上传保险丝按体积放大(0.5 MB/s 保守估计),与 mediaRelay 同款算法。
    const hardTimeoutMs = Math.max(DOWNLOAD_FLOOR_MS, Math.ceil(size / (0.5 * 1024 * 1024)) * 1000)

    return await uploadStreamToBucket({
      bucket: HISTORY_BUCKET,
      region: HISTORY_REGION,
      key: opts.key,
      filePath: tmpPath,
      contentType: opts.contentType,
      hardTimeoutMs,
    })
  } finally {
    fsp.unlink(tmpPath).catch(() => { /* 临时文件清理失败无害 */ })
  }
}
