import { ipcMain } from 'electron'
import path from 'node:path'
import { hasTraversalSegment, isImageMime, mimeFromExt } from './mediaPathValidation'
import { resolveMediaUrl } from '../services/seedance/mediaResolve'

/**
 * `media:resolve-ref-image` — 把一张参考图换成可提交上游的 URL。
 *
 * 为什么需要它:MCP 的 `generate_image` 收到的是**本地路径**(agent 从 prompt 里的
 * `[Attached files at these local paths: …]` 抄来的)。渲染层此前把它读成 data URL
 * 内联发送,于是万相 / seedream 这类原生吃 https 的渠道会收到几 MB 的 base64 —— 请求
 * 体白白膨胀,而上游对 url 字段约 1MB 就开始报 `400 url is too long`。
 *
 * 界面侧的参考图早就不这么干了(`utils/refImageUpload` 原图直传 COS、不压缩),这条
 * IPC 就是把同一口径补给 MCP。底层复用视频那套 `resolveMediaUrl`:本地文件从磁盘
 * 分片流式上传,整个文件不进 Node Buffer,也不进渲染进程堆。
 *
 * **为什么由渲染层调用而不是主进程自己做完**:是否需要 URL 取决于渠道 ——
 * nano/gemini 系列要 base64 `inline_data`,先传 COS 再抓回来是无意义的往返。而渠道
 * 是在渲染层 `resolveEffectiveImageChannel` 才定的(agent 未指定时取用户选的通道),
 * 主进程在 MCP 那一刻还不知道。
 *
 * **白名单**:同一套 mediaPathValidation 原语,并且额外只放行 `image/*` —— 参考图
 * 就是图片,没有理由放过 zip/pmx/mp4。
 *
 * 说清楚它防的是什么:本应用的渲染进程是 `nodeIntegration: true /
 * contextIsolation: false`(见 main/index.ts),渲染进程本来就能直接 `require('fs')`,
 * 所以这里既不是对抗恶意渲染进程的信任边界,校验 IPC sender 也没有意义 —— 那道边界
 * 是 `will-navigate` + `setWindowOpenHandler` 挡住不受信内容加载。白名单真正的作用
 * 是**拦住调用方的失误**:agent 抄错路径、或把一个非图片文件当参考图传进来时,别让
 * 它进了**公开** COS 桶。这类误传一旦发生就是不可撤销的,所以值得在这里拦一道。
 */

export type ResolveRefImageResult =
  | { ok: true; url: string }
  | { ok: false; reason: string }

export async function resolveRefImage(rawPath: string): Promise<ResolveRefImageResult> {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    return { ok: false, reason: 'empty path' }
  }
  const src = rawPath.trim()

  // 已经是 URL / data: 的不碰:调用方(渲染层)对这两类原样透传,这里只是兜底,
  // 免得白名单把一个合法的 https 参考图误杀。
  if (/^(https?:|data:|asset:)/i.test(src)) return { ok: true, url: src }

  if (hasTraversalSegment(src)) {
    return { ok: false, reason: 'path contains a traversal segment' }
  }
  const mime = mimeFromExt(src)
  if (!mime || !isImageMime(mime)) {
    return { ok: false, reason: `not a whitelisted image path: ${path.basename(src)}` }
  }

  try {
    // noCache:每一次生图都是一次全新任务,不复用上一次的 URL。见 ResolveMediaOptions
    // 里的说明 —— 同一张图在一次调用里出现两次时,复用同一个地址可能被上游按地址
    // 折叠成一个参考,把后面的编号全体前移。
    const url = await resolveMediaUrl(src, 'referenceImage', mime, {
      alwaysRelay: true,
      noCache: true,
    })
    return { ok: true, url }
  } catch (err) {
    // 绝不让异常穿过 IPC 边界:渲染层拿到 ok:false 会按策略降级回内联 data URL,
    // 而一个 rejected invoke 只会变成一句没有上下文的报错。
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

export function registerRefImageResolveIpc(): void {
  ipcMain.handle('media:resolve-ref-image', (_event, rawPath: string) => resolveRefImage(rawPath))
}
