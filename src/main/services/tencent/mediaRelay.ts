// mediaRelay - 把本地字节(data: URL / Buffer)中转到 COS 历史图片桶,换取一个
// 可公网访问的 https URL。
//
// 为什么需要:Seedance 素材库 / 视频任务接口对 data: URL 有长度上限
// (实测 ~2.8MB 原图就触发 `API 400: url is too long`),而我们的 COS
// 历史图片上传链路(`cos:upload-image-history` 同款)稳定且快。所以
// 统一策略:大于阈值的本地素材 → 先传 COS → 用 https URL 提交上游。
//
// 桶/Key 规则与 src/main/index.ts 的 image-history IPC 完全一致,
// 视频/音频也落同一个桶(仅扩展名不同),便于排查与生命周期管理。
//
// ⚠️ Key 必须落在 `image-history/` 前缀下:生产环境走 STS 临时凭证
// (uploadBufferToBucket → getStsCosInstance),该 token 只授权
// `image-history/*` 的 PutObject(见 stsCredentials.ts)。换任何别的前缀
// (如曾用的 `media-relay/`)都会被 COS 拒为 `AccessDenied`。

import { randomBytes } from 'node:crypto'
import { uploadBufferToBucket, uploadStreamToBucket } from './cosClient'
import { describeCosError, isRetryableCosError } from './cosErrors'

const MEDIA_RELAY_BUCKET = 'image-master-1345773498'
const MEDIA_RELAY_REGION = 'ap-guangzhou'

/**
 * 中转是「用户按了生成」这条链路上的前置步骤,一次网络抖动就废掉整张卡片,
 * 代价远高于多等几秒。所以瞬时失败(5xx / DNS / TLS / 超时)重试,鉴权与请求
 * 错误(4xx)立即放弃 —— 那类重试只会把失败推迟。
 */
const RELAY_ATTEMPTS = 3
const RELAY_RETRY_BASE_DELAY_MS = 800

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
}

function relayKey(mimeType: string): string {
  const ext = EXT_BY_MIME[mimeType] ?? 'bin'
  const now = new Date()
  const yyyy = String(now.getFullYear())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const id = randomBytes(8).toString('hex')
  // 必须 `image-history/` 前缀 —— STS 临时凭证仅授权此前缀(见文件头注释)。
  return `image-history/media-relay/${yyyy}/${mm}/${dd}/${id}.${ext}`
}

/**
 * 带重试地跑一次中转上传,并把失败统一收敛成**真 Error**。
 *
 * 为什么必须收敛:COS SDK 的失败是裸对象而非 Error,原样冒泡时调用方那句
 * `e instanceof Error ? e.message : String(e)` 会渲成 `[object Object]`——
 * 用户看到的报错里没有任何可诊断信息(见 describeCosError 的注释)。
 *
 * 每次重试都重新生成 Key,避免上一次失败留下的分片状态干扰下一次。
 */
async function relayWithRetry(op: string, run: () => Promise<string>): Promise<string> {
  let lastError: unknown
  for (let attempt = 1; attempt <= RELAY_ATTEMPTS; attempt++) {
    try {
      return await run()
    } catch (e) {
      lastError = e
      if (attempt === RELAY_ATTEMPTS || !isRetryableCosError(e)) break
      console.warn(
        `[mediaRelay] ${op} 第 ${attempt}/${RELAY_ATTEMPTS} 次失败,重试:${describeCosError(e)}`,
      )
      await new Promise((resolve) => setTimeout(resolve, RELAY_RETRY_BASE_DELAY_MS * attempt))
    }
  }
  throw new Error(describeCosError(lastError))
}

/** 上传 Buffer 到中转桶,返回公网 https URL。 */
export async function relayBufferToCos(body: Buffer, mimeType: string): Promise<string> {
  if (body.byteLength === 0) throw new Error('media relay: empty buffer')
  return relayWithRetry('relayBufferToCos', () =>
    uploadBufferToBucket({
      bucket: MEDIA_RELAY_BUCKET,
      region: MEDIA_RELAY_REGION,
      key: relayKey(mimeType),
      body,
      contentType: mimeType,
    }),
  )
}

/**
 * 把一个**本机文件**流式分片上传到中转桶,返回公网 https URL。
 *
 * 与 relayBufferToCos 的区别:不把整文件读进 Buffer —— 用 COS sliceUploadFile
 * 从磁盘流式上传(STS 鉴权,生产可用)。这样视频理解能支持到上游的客观上限
 * (qwen3.7 系列 2GB / 2 小时),而不再被「整文件读进内存」逼出的 200MB 闸门卡住。
 *
 * `fileSize` 仅用于给总时长保险丝定一个随体积放大的保底值(慢网下 2GB 也不会被
 * 提前掐断);不传则用 cosClient 的默认 10 分钟。
 */
export async function relayFileToCos(
  filePath: string,
  mimeType: string,
  opts?: { fileSize?: number },
): Promise<string> {
  // 保底 15 分钟;按 0.5MB/s 的悲观下行估算放大(2GB ≈ 68 分钟),取两者较大值。
  const FLOOR_MS = 15 * 60 * 1000
  const sizeBasedMs =
    opts?.fileSize && opts.fileSize > 0
      ? Math.ceil(opts.fileSize / (0.5 * 1024 * 1024)) * 1000
      : 0
  const hardTimeoutMs = Math.max(FLOOR_MS, sizeBasedMs)

  return relayWithRetry('relayFileToCos', () =>
    uploadStreamToBucket({
      bucket: MEDIA_RELAY_BUCKET,
      region: MEDIA_RELAY_REGION,
      key: relayKey(mimeType),
      filePath,
      contentType: mimeType,
      hardTimeoutMs,
    }),
  )
}

/** 解析 base64 data: URL 为 { buffer, mimeType };非 data: URL 返回 null。 */
export function parseDataUrl(input: string): { buffer: Buffer; mimeType: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(input)
  if (!m) return null
  return { buffer: Buffer.from(m[2], 'base64'), mimeType: m[1] || 'application/octet-stream' }
}

/** data: URL → COS https URL。非 data: URL 原样返回。 */
export async function relayDataUrlToCos(url: string): Promise<string> {
  const parsed = parseDataUrl(url)
  if (!parsed) return url
  return relayBufferToCos(parsed.buffer, parsed.mimeType)
}
