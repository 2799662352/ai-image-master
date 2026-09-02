/**
 * 火山 MediaKit 工具(视频高清 / 去字幕 Pro)经 Miau 网关的客户端。
 *
 * ## 契约(读的是网关源码,不是猜的)
 *
 * new-api `relay/channel/task/volcmediakit`:
 *  - 提交:`POST /v1/videos`,body `{ model, metadata: { content: [{ type: 'video_url',
 *    video_url: { url } }], ...工具参数 } }`。适配器只从 `metadata.content` 里抽
 *    `video_url`,别的放法一律 `extract video_url failed`。
 *  - 轮询:`GET /v1/videos/{id}`,回 OpenAI video 对象:`status` 为
 *    `queued | in_progress | completed | failed`,结果在 `metadata.url`,错误在 `error`。
 *  - 高清可调:`tool_version`(默认 professional)、`scene`(aigc)、`resolution`(2k)、
 *    `fps`(30)。去字幕 Pro 没有可调参数。
 *
 * ## 为什么不直接复用 wan3/client
 *
 * 形状不同:万相的 body 是 `prompt + metadata.input.media[]`,结果在 `output.video_url`;
 * 这里是 `metadata.content[]`,结果在 `metadata.url`。硬塞进万相的类型只会让两边
 * 都多一层 `as`。但**纪律**是同一套,逐条照搬:
 *  - 整份鉴权头而不是一枚 key —— 平台模式下少了归属头,钱扣对了但流水查不到;
 *  - `baseUrl` 由调用方按 `resolveGatewayOrigin()` 注入 —— 写死生产地址在测试服
 *    模式下会把测试签发的 token 发到生产网关(2026-08-31 万相踩过);
 *  - `onBilledExchange` 只在提交成功与终态时报 —— 中间轮询不动钱。
 *
 * ## 上游只收 URL
 *
 * 火山侧要自己去拉视频。`data:` 塞进去拉不到,所以这条路上**没有** base64 兜底 ——
 * 不是策略,是物理上做不到。调用方必须先把文件中转成公网 URL(`relayFileToCos`)。
 */

import { retrySubmit, type RetrySubmitOptions } from '../seedance/submitRetry'

export const MEDIAKIT_REQUEST_TIMEOUT_MS = 30_000

/**
 * 网关上走同一套任务协议的视频处理模型:
 *  - 火山 MediaKit:`volc-enhance-video` / `volc-erase-subtitle-pro`;
 *  - 阿里 DAMO 超分:`damo-aisr-{standard|pro}-{720p…8k}-{30|60|120}fps`,30 个 SKU。
 *
 * DAMO 的适配器(new-api `relay/channel/task/aisr`)接受**同一个** `metadata.content`
 * 形状,算法档与目标分辨率从模型名推导、不读 metadata —— 所以一个客户端服务两家,
 * 差别只在 `model` 字串。
 */
export type MediaKitModel =
  | 'volc-enhance-video'
  | 'volc-erase-subtitle-pro'
  | `damo-aisr-${string}`

export interface EnhanceOptions {
  toolVersion?: 'professional' | 'standard'
  scene?: string
  resolution?: '1080p' | '2k' | '4k'
  fps?: number
}

export type MediaKitAuthHeaders = Readonly<Record<string, string>>

export type MediaKitTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface MediaKitTaskResult {
  id: string
  status: MediaKitTaskStatus
  /** 0–100;上游给多少就是多少(实测长期停在 50,别把它当进度条的承诺)。 */
  progress?: number
  videoUrl?: string
  error?: { code?: string; message?: string }
}

export interface MediaKitClient {
  submit: (
    model: MediaKitModel,
    videoUrl: string,
    options: EnhanceOptions,
    auth: MediaKitAuthHeaders,
  ) => Promise<{ id: string }>
  query: (taskId: string, auth: MediaKitAuthHeaders) => Promise<MediaKitTaskResult>
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface MediaKitClientOptions {
  fetchImpl: FetchLike
  /** 形如 `https://host/v1`。**必填**,不给默认值 —— 理由见文件头「纪律」第二条。 */
  baseUrl: string
  onBilledExchange?: () => void
  retryOptions?: RetrySubmitOptions
}

export class MediaKitApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'MediaKitApiError'
  }
}

const TERMINAL: ReadonlySet<MediaKitTaskStatus> = new Set(['succeeded', 'failed', 'cancelled'])

/** 网关的 OpenAI video 状态 → 内部状态。认不出的一律当 running,让轮询继续而不是误判失败。 */
const STATUS_MAP: Readonly<Record<string, MediaKitTaskStatus>> = Object.freeze({
  queued: 'queued',
  in_progress: 'running',
  processing: 'running',
  running: 'running',
  completed: 'succeeded',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
})

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** 兜底守卫:只挡「头都组错了」这种编程错误;凭据缺席的人话归调用方说。 */
function requireAuth(auth: MediaKitAuthHeaders): MediaKitAuthHeaders {
  const value = Object.entries(auth).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  const token = (value ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!token) throw new Error('MediaKit 请求缺少 Authorization —— 调用方没组鉴权头')
  return auth
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text()
  if (!text) return {}
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return { message: text.slice(0, 300) }
  }
}

function extractError(json: Record<string, unknown>): { code?: string; message?: string } {
  const err = asRecord(json.error)
  return {
    code: asString(err.code) ?? asString(json.code),
    message: asString(err.message) ?? asString(json.message),
  }
}

async function request(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  auth: MediaKitAuthHeaders,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), MEDIAKIT_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...auth },
    })
  } finally {
    clearTimeout(timer)
  }
  const json = await readJson(res)
  if (!res.ok) {
    const { code, message } = extractError(json)
    const detail = [code, message].filter(Boolean).join(': ')
    // 401/403 要带上「哪种钱 → 打给谁」:同一句 Invalid token 至少对应两个成因
    // (用错钱包 / 发错收件人),少了这两个字段只能去查凭据,而凭据往往是对的。
    const where =
      res.status === 401 || res.status === 403
        ? `（${'X-Platform-User-Id' in auth ? '平台余额' : '自填 Key'} → ${safeHost(url)}）`
        : ''
    throw new MediaKitApiError(`MediaKit API ${res.status}${detail ? `: ${detail}` : ''}${where}`, res.status, code)
  }
  return json
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function parseMediaKitTaskResult(raw: unknown): MediaKitTaskResult {
  const body = asRecord(raw)
  const statusText = asString(body.status) ?? ''
  const status = STATUS_MAP[statusText.toLowerCase()] ?? 'running'
  const metadata = asRecord(body.metadata)
  const progressRaw = Number(body.progress)
  const err = asRecord(body.error)
  return {
    id: asString(body.id) ?? asString(body.task_id) ?? '',
    status,
    ...(Number.isFinite(progressRaw) ? { progress: Math.max(0, Math.min(100, Math.round(progressRaw))) } : {}),
    ...(asString(metadata.url) ? { videoUrl: asString(metadata.url) } : {}),
    ...(asString(err.code) || asString(err.message)
      ? { error: { code: asString(err.code), message: asString(err.message) } }
      : {}),
  }
}

export function buildMediaKitSubmitBody(
  model: MediaKitModel,
  videoUrl: string,
  options: EnhanceOptions,
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    content: [{ type: 'video_url', video_url: { url: videoUrl } }],
  }
  // DAMO 不进这个分支:它的档位全在模型名里,metadata 里塞 resolution 会被忽略
  // (适配器只读 content),写了只会让人误以为有效。
  if (model === 'volc-enhance-video') {
    // 只写用户给了的键:适配器对缺省键有自己的默认(professional / aigc / 2k / 30),
    // 这里再写一遍默认值等于把网关的默认硬编码进客户端,两边一改就分叉。
    if (options.toolVersion) metadata.tool_version = options.toolVersion
    if (options.scene) metadata.scene = options.scene
    if (options.resolution) metadata.resolution = options.resolution
    if (typeof options.fps === 'number' && options.fps > 0) metadata.fps = options.fps
  }
  return { model, metadata }
}

export function createMediaKitClient(options: MediaKitClientOptions): MediaKitClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const { fetchImpl } = options
  const noteBilled = options.onBilledExchange ?? ((): void => {})

  return {
    async submit(model, videoUrl, opts, auth) {
      const headers = requireAuth(auth)
      const submitUrl = `${baseUrl}/videos`
      const body = buildMediaKitSubmitBody(model, videoUrl, opts)
      console.info('[mediaKit] submit', {
        model,
        host: safeHost(submitUrl),
        billing: 'X-Platform-User-Id' in headers ? 'platform' : 'own-key',
        // 只记 host:签名 URL 的查询串里有凭据。
        sourceHost: safeHost(videoUrl),
      })
      return retrySubmit(async () => {
        const json = await request(fetchImpl, submitUrl, { method: 'POST', body: JSON.stringify(body) }, headers)
        const id = asString(json.id) ?? asString(json.task_id)
        if (!id) throw new Error('MediaKit 返回里没有任务号,无法跟踪这次处理')
        // 提交成功 = 上游已按次预扣(这两个工具都是 per-call 定价)。
        noteBilled()
        return { id }
      }, options.retryOptions)
    },

    async query(taskId, auth) {
      const headers = requireAuth(auth)
      const json = await request(
        fetchImpl,
        `${baseUrl}/videos/${encodeURIComponent(taskId)}`,
        { method: 'GET' },
        headers,
      )
      const result = parseMediaKitTaskResult(json)
      if (TERMINAL.has(result.status)) noteBilled()
      return result
    },
  }
}
