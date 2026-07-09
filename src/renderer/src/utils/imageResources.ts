/**
 * imageResources — 模型直出 base64 的「物化」工具。
 *
 * 背景 (P0 闪退修复, 2026-07-09): nano2 等 gemini-native 模型的 4K 图以
 * base64 内联在 JSON 里返回, 一张 ≈ 10-40MB 字符串。此前这串 base64 会:
 *   ① 存进 zustand store (`resultUrl`) 直到 COS 上传完成才释放;
 *   ② 原样经 IPC 结构化克隆传给主进程转存 COS(两个进程各持一份);
 *   ③ COS 失败时被写进 history, 之后每次全量保存都随整个数组反复
 *      IPC + JSON.stringify。
 * 三处叠加 × 并发 6 → 渲染/主进程 V8 堆 OOM → 整个应用闪退, 且崩溃常发生
 * 在 history 写盘途中 → 文件截断 → 重启后记录全丢。
 *
 * 修复策略(对齐 Chromium/Electron 社区共识, 参见 cherry-studio #13578):
 * base64 一到手就转成 Blob(堆外二进制) + blob: URL(几十字节的字符串),
 * V8 堆里不再长期保留任何 base64:
 *   - 显示: `<img src="blob:...">` 直接可用(useDisplaySrc 对非 data: 透传);
 *   - 上传: 从 Blob 取 ArrayBuffer 走字节版 IPC(cos:enqueue-upload-bytes),
 *     二进制结构化克隆比 base64 字符串小 25% 且不占 V8 堆;
 *   - 释放: blob: URL 被 cosUrl 热切 / item 被删除时 revokeObjectURL。
 */

export interface MaterializedImage {
  /** 存 store + 展示用的轻量 URL: blob:(data: 输入)或原样透传(http 等)。 */
  displayUrl: string
  /** 仅 data: 输入才有 — 供字节版 COS 上传用, 入队后即可丢弃引用。 */
  blob?: Blob
  mimeType?: string
}

/**
 * revoke 延迟时间。热切 cosUrl / 删除 item 时, 旧 blob: URL 可能仍被
 * `<img>` 或 lightbox 引用, 立刻 revoke 会闪 ERR_FILE_NOT_FOUND。
 * 10s 后 React 早已用新 src 完成重渲染, 可以安全释放底层 Blob。
 */
const BLOB_REVOKE_DELAY_MS = 10_000

export function isBlobUrl(u: string | undefined | null): u is string {
  return typeof u === 'string' && u.startsWith('blob:')
}

/** history 能否长期保存这个 URL(跨重启仍可用)。blob:/data:/pending: 都不行。 */
export function isPersistableUrl(u: string | undefined | null): u is string {
  if (typeof u !== 'string' || !u) return false
  return !u.startsWith('blob:') && !u.startsWith('data:') && !u.startsWith('pending:')
}

/**
 * 延迟 revoke 一个 blob: URL(非 blob: 输入 no-op)。
 * 幂等: 对同一 URL 重复调用 / URL 已 revoke 都安全。
 */
export function revokeLater(url: string | undefined | null): void {
  if (!isBlobUrl(url)) return
  if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') return
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url)
    } catch {
      /* already revoked */
    }
  }, BLOB_REVOKE_DELAY_MS)
}

function canMaterialize(): boolean {
  return (
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof fetch === 'function'
  )
}

/**
 * 把一个可能是 data: 的图片 URL 物化成 blob: URL + Blob。
 * 非 data: 输入(http/blob/file)原样透传; 环境不支持(测试 jsdom)或转换
 * 失败时回退为原字符串 —— 行为退化成修复前, 不会黑图。
 *
 * 用 `fetch(dataURL).blob()` 而不是手动 atob: 浏览器原生解码不经过 V8
 * 字符串堆, 且是异步的, 不卡主线程。
 */
export async function materializeImageUrl(url: string): Promise<MaterializedImage> {
  if (typeof url !== 'string' || !url.startsWith('data:') || !canMaterialize()) {
    return { displayUrl: url }
  }
  try {
    const blob = await (await fetch(url)).blob()
    return {
      displayUrl: URL.createObjectURL(blob),
      blob,
      mimeType: blob.type || undefined,
    }
  } catch {
    return { displayUrl: url }
  }
}

export async function materializeImageUrls(urls: string[]): Promise<MaterializedImage[]> {
  return Promise.all(urls.map(materializeImageUrl))
}

// ============ history 参考图缩图 ============

/** 缩图目标: 最长边 640px JPEG。够重编辑回灌当参考图用, 单张 ≈ 30-120KB。 */
const REF_THUMB_MAX_EDGE = 640
const REF_THUMB_QUALITY = 0.82
/** 环境不支持缩图时, 小于该体积的 data: 原样保留, 更大的直接丢标记。 */
const REF_KEEP_RAW_MAX_CHARS = 512 * 1024

/** 同一批 N 张图共享同一个 refs 数组(浅引用), 按数组身份缓存缩图结果, 整批只压一次。 */
const refThumbCache = new WeakMap<string[], Promise<string[]>>()

function canThumbnail(): boolean {
  return (
    typeof createImageBitmap === 'function' &&
    typeof OffscreenCanvas === 'function' &&
    typeof fetch === 'function' &&
    typeof FileReader === 'function'
  )
}

async function thumbnailOneRef(ref: string): Promise<string> {
  // http(s)/cos URL 本身轻量且可持久化, 原样保留。
  if (!ref.startsWith('data:')) return ref
  if (!canThumbnail()) {
    return ref.length <= REF_KEEP_RAW_MAX_CHARS ? ref : '[ref-image-removed]'
  }
  try {
    const blob = await (await fetch(ref)).blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, REF_THUMB_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(bitmap, 0, 0, w, h)
    bitmap.close()
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: REF_THUMB_QUALITY })
    return await new Promise<string>((resolve, reject) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result as string)
      fr.onerror = reject
      fr.readAsDataURL(out)
    })
  } catch {
    return ref.length <= REF_KEEP_RAW_MAX_CHARS ? ref : '[ref-image-removed]'
  }
}

/**
 * 把参考图数组压成 history 可长期保存的轻量形态:
 *   - http(s) URL 原样保留;
 *   - data: 大图缩到 640px JPEG dataURL(重编辑回灌够用);
 *   - 不支持缩图的环境: ≤512KB 原样保留, 超过则以标记替换。
 *
 * 修复前: 每条 batch history item 都逐字复制全部原始参考图 base64
 * (16 张 × 数 MB × N 条 item), 是 history 文件膨胀 + 主进程
 * JSON.stringify OOM 的主要来源之一。
 */
export function thumbnailRefsForHistory(refs: string[]): Promise<string[]> {
  const cached = refThumbCache.get(refs)
  if (cached) return cached
  const p = Promise.all(refs.map(thumbnailOneRef))
  refThumbCache.set(refs, p)
  return p
}
