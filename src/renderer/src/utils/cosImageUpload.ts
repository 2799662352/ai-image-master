/**
 * cosImageUpload - 把一张图片(http url / data url)异步上传到腾讯云 COS,
 * 拿到一个持久化访问 URL。
 *
 * 模型直出的 URL 通常是临时签名链接(几分钟到几小时失效),
 * 把它转存到 COS 后才可以稳定展示和分享。
 *
 * 接口面向渲染进程: 走 preload 暴露的 `window.electronAPI.cos.uploadImageHistory`
 * → 主进程 `cos:upload-image-history` IPC → COS PutObject。
 *
 * 设计原则:
 * - 不依赖渲染进程的 R2 桥接(R2 走 Cloudflare 另一条链路, 不在用户要求范围)。
 * - 出错不抛异常, 全部用 result 对象返回, 调用方按需降级到模型直出 URL。
 * - 兼容浏览器预览模式(无 window.electronAPI) - 直接判定失败而不卡 promise。
 */

type CosUploadOk = { ok: true; url: string; key: string }
type CosUploadErr = { ok: false; error: string }
export type CosUploadResult = CosUploadOk | CosUploadErr

interface ElectronAPILike {
  cos?: {
    uploadImageHistory?: (
      base64: string,
      mimeType: string,
      metadata?: Record<string, unknown>,
    ) => Promise<
      | { success: true; url: string; key: string }
      | { success: false; error: string }
    >
    uploadImageFromUrl?: (
      sourceUrl: string,
      mimeType?: string,
      metadata?: Record<string, unknown>,
    ) => Promise<
      | { success: true; url: string; key: string }
      | { success: false; error: string }
    >
  }
}

function getCosBridge(): ElectronAPILike['cos'] | undefined {
  const api = (window as unknown as { electronAPI?: ElectronAPILike }).electronAPI
  return api?.cos
}

/** 把 dataURL 切成 `{ base64, mimeType }`; 非 dataURL 抛错以便上层捕获。 */
function parseDataUrl(input: string): { base64: string; mimeType: string } {
  // data:image/png;base64,iVBOR...
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(input)
  if (!match) throw new Error('not a base64 data url')
  return { mimeType: match[1] || 'image/png', base64: match[2] }
}

/** 把任意 source(blob / response body)转 base64; 大图也安全(不会一次 atob 出来)。 */
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'))
        return
      }
      // dataURL 形式: data:mime;base64,xxx — 截尾即纯 base64
      const idx = result.indexOf(',')
      resolve(idx >= 0 ? result.slice(idx + 1) : result)
    }
    reader.readAsDataURL(blob)
  })
}

/** 兜底从 url 推 mime; 主进程返回的 metadata 会以这个为准。 */
function guessMimeFromUrl(url: string, fallback = 'image/png'): string {
  const lower = url.split('?')[0]?.toLowerCase() ?? ''
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.avif')) return 'image/avif'
  return fallback
}

export interface CosUploadOptions {
  /** 透传给主进程的元数据(目前未持久化, 但保留接口形状) */
  metadata?: Record<string, unknown>
  /** 取消信号 — 调用方在生成被 cancel 时传入 */
  signal?: AbortSignal
  /** fetch 超时(ms), 默认 30s */
  timeoutMs?: number
}

// ─── 全局并发闸 ───────────────────────────────────────────────
// 为什么需要: BatchStore / GenerateStore 都是 fire-and-forget per-image,
// 没有内置任何上限。批量 30 张图同时完成时会瞬间起 30 个并发, 每个都把
// 几 MB base64 字符串 + 同尺寸的 IPC 结构化克隆副本顶在内存里, 直到
// COS PutObject 返回。一次大批量就能吃掉 1GB+ 堆内存 → OOM 闪退。
//
// 4 个并发足够把网络打满, 多了也不会更快(瓶颈在 COS 单连接带宽, 不在
// 客户端 CPU); 进队的请求只挂一个 promise resolver, 不持有任何 base64,
// 所以等待队列本身几乎不占内存。
const MAX_CONCURRENT_UPLOADS = 4
let inFlight = 0
const waiters: Array<() => void> = []

function acquireUploadSlot(): Promise<void> {
  if (inFlight < MAX_CONCURRENT_UPLOADS) {
    inFlight++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      inFlight++
      resolve()
    })
  })
}

function releaseUploadSlot(): void {
  inFlight--
  const next = waiters.shift()
  if (next) next()
}

/** Exposed for tests; do not call from production code. */
export function __resetCosUploadConcurrencyForTests(): void {
  inFlight = 0
  waiters.length = 0
}

/**
 * 把一个图片 URL 异步上传到 COS。返回 `{ ok, url }`(或 `{ ok: false, error }`)。
 *
 * 用法(fire-and-forget):
 * ```ts
 * uploadImageUrlToCos(modelUrl, { metadata: { prompt } })
 *   .then(r => r.ok && setCosUrl(itemId, r.url))
 * ```
 */
type UploadImageHistoryFn = NonNullable<NonNullable<ElectronAPILike['cos']>['uploadImageHistory']>

export async function uploadImageUrlToCos(
  source: string,
  options: CosUploadOptions = {},
): Promise<CosUploadResult> {
  const bridge = getCosBridge()
  if (!bridge?.uploadImageHistory && !bridge?.uploadImageFromUrl) {
    return { ok: false, error: 'electronAPI.cos unavailable (browser preview?)' }
  }
  if (!source || typeof source !== 'string') {
    return { ok: false, error: 'empty source url' }
  }
  if (options.signal?.aborted) {
    return { ok: false, error: 'aborted before start' }
  }

  await acquireUploadSlot()
  try {
    if (options.signal?.aborted) {
      return { ok: false, error: 'aborted while queued' }
    }

    // Fast path: main process fetches the URL directly. Renderer main
    // thread is never blocked by fetch + base64 + IPC structured-clone
    // of a multi-MB string. Only base64 sources (data: URLs) fall back
    // to the renderer-side path because the bytes already live here.
    if (bridge.uploadImageFromUrl && !source.startsWith('data:')) {
      try {
        const result = await bridge.uploadImageFromUrl(
          source,
          undefined,
          options.metadata,
        )
        if (result.success) {
          return { ok: true, url: result.url, key: result.key }
        }
        return { ok: false, error: result.error || 'unknown COS error' }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }

    if (!bridge.uploadImageHistory) {
      return { ok: false, error: 'no compatible cos upload bridge' }
    }
    return await doUpload(bridge.uploadImageHistory, source, options)
  } finally {
    releaseUploadSlot()
  }
}

async function doUpload(
  uploadFn: UploadImageHistoryFn,
  source: string,
  options: CosUploadOptions,
): Promise<CosUploadResult> {
  // 1) 拿到 base64 + mime
  let base64: string
  let mimeType: string
  try {
    if (source.startsWith('data:')) {
      const parsed = parseDataUrl(source)
      base64 = parsed.base64
      mimeType = parsed.mimeType
    } else {
      const controller = new AbortController()
      const linkAbort = () => controller.abort()
      options.signal?.addEventListener('abort', linkAbort, { once: true })
      const timeoutId = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? 30_000,
      )
      try {
        const resp = await fetch(source, { mode: 'cors', signal: controller.signal })
        if (!resp.ok) {
          return { ok: false, error: `fetch ${resp.status}` }
        }
        const blob = await resp.blob()
        mimeType = blob.type || guessMimeFromUrl(source)
        base64 = await blobToBase64(blob)
      } finally {
        clearTimeout(timeoutId)
        options.signal?.removeEventListener('abort', linkAbort)
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (options.signal?.aborted) {
    return { ok: false, error: 'aborted after fetch' }
  }
  if (!base64) {
    return { ok: false, error: 'empty image body' }
  }

  // 2) 走主进程把 buffer 推到 COS
  try {
    const result = await uploadFn(base64, mimeType, options.metadata)
    if (result.success) {
      return { ok: true, url: result.url, key: result.key }
    }
    return { ok: false, error: result.error || 'unknown COS error' }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
