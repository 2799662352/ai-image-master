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

export interface TransferOptions {
  /** 媒体桶的(短寿命)签名 URL,调用时必须仍然有效。 */
  sourceUrl: string
  /** 目标 Key,必须以 `image-history/` 开头(STS 票据只授权该前缀)。 */
  key: string
  contentType?: string
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
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_FLOOR_MS * 10)
    let size = 0
    try {
      const res = await fetch(opts.sourceUrl, { signal: controller.signal })
      if (!res.ok || !res.body) {
        throw new Error(`download failed: HTTP ${res.status}`)
      }
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmpPath))
      size = (await fsp.stat(tmpPath)).size
    } finally {
      clearTimeout(timer)
    }
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
