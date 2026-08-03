// 素材来源 → 可提交上游的 URL。
//
// 从 runtime.ts 抽出来的原因有两个:一是它不该被 electron 依赖挡在单测之外
// (runtime.ts 一 import 就把 ipcMain 拖进来);二是「中转失败之后怎么办」这条
// 策略必须**只有一份** —— 曾经本地路径入口直接抛错、data: URL 入口悄悄降级回
// 内联,同一张图从两个入口进来是两种命运,而用户根本不知道自己走的是哪个入口。

import fs from 'node:fs/promises'
import path from 'node:path'
import { describeCosError } from '../tencent/cosErrors'
import { relayDataUrlToCos, relayFileToCos } from '../tencent/mediaRelay'

/**
 * 内联 data: URL 的常规上限。上游对 url 字段有长度限制(实测 ~1MB 原始字节
 * 就可能触发 `400 url is too long`),所以只有小文件才内联;更大的文件走 COS
 * 中转(历史图片上传链路)换 https URL 再提交,既绕开限制又更快。
 */
export const MAX_INLINE_FILE_BYTES = 512 * 1024

/**
 * 上游 url 字段实际能吃下的内联体积。只用于一件事:中转挂掉之后,判断「降级回
 * 内联」还有没有希望 —— 512KB~1MB 这个窗口里内联仍在上游限内,值得一试。
 */
export const MAX_UPSTREAM_INLINE_BYTES = 1024 * 1024

export const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
}

/** base64 每 4 个字符携带 3 字节;头部(`data:image/png;base64,`)忽略不计。 */
export function estimateDataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length
  return Math.floor((payload * 3) / 4)
}

/**
 * 一份素材的两条出路。中转与内联都做成惰性的:走得通哪条就只付哪条的代价
 * (内联要读整个文件,不该在中转成功时白读一遍)。
 */
interface MediaSource {
  /** 原始字节数:决定要不要内联,也给流式上传的超时保险丝定值。 */
  bytes: number
  relay: () => Promise<string>
  inline: () => Promise<string>
}

/**
 * 中转失败的用户可读说明。关键是**带上真实原因** —— COS SDK 抛的是裸对象,
 * 早先这里用 `String(e)` 渲出来就是一句 `[object Object]`,既看不出是票据问题
 * 还是网断了,也没法据此做任何事(mediaRelay 已把它收敛成真 Error,这里再兜
 * 一层,防止别的调用路径漏进来)。
 */
function relayFailureHint(e: unknown): string {
  const reason = e instanceof Error ? e.message : describeCosError(e)
  return `上传到中转服务器失败(${reason})。已自动重试仍未成功,请检查网络后重新生成;若持续失败,可改用 https 链接或人像库素材(asset://)。`
}

/**
 * 先中转,失败则在**上游还吃得下的前提下**降级内联。
 *
 * 降级不是纵容:COS 不可达而模型接口可达是真实场景(公司网络只放行部分域名),
 * 这时内联是唯一能把活干成的路。但超过上游 url 长度限制就必须报错 —— 硬塞进去
 * 只会换来一句莫名其妙的 `url is too long`,把一个可解释的网络问题变成谜题。
 */
async function relayOrInline(src: MediaSource, label: string): Promise<string> {
  try {
    return await src.relay()
  } catch (e) {
    if (src.bytes <= MAX_UPSTREAM_INLINE_BYTES) {
      console.warn(`[seedance] ${label}: COS 中转失败,降级为内联提交:`, e)
      return src.inline()
    }
    const mb = (src.bytes / 1024 / 1024).toFixed(1)
    throw new Error(`${label}: ${mb}MB 素材 ${relayFailureHint(e)}`)
  }
}

/**
 * 本地路径 / data: URL / http(s) / asset: → 可提交上游的 URL。
 *
 * **不设体积闸门。** 本地文件走 `relayFileToCos` 从磁盘分片流式上传,整个文件
 * 不进 Node Buffer,所以「多大算太大」不该由我们猜:上游自己会对超限素材返回
 * 明确的 400,那个错误比我们编一个数字准。历史上这里卡了一道 50MB,结果是用户
 * 被我们挡下,却看不到上游到底允许多少。
 */
export interface ResolveMediaOptions {
  /**
   * 跳过 ≤512KB 的内联捷径,一律走 COS 换 URL。
   *
   * 给**图片生成的参考图**用:那边要与 UI 侧 `refImageUpload` 同口径(「原图直传
   * 云端、不压缩」,没有体积下限),这样同一张参考图无论从界面还是 MCP 进来都是
   * URL,请求体不会随图片大小膨胀。视频路径不传这个开关,保留内联线 —— 小素材
   * 多走一次往返不划算。
   *
   * 只影响「要不要中转」,不影响「中转挂了怎么办」:失败后仍按原策略降级内联。
   */
  alwaysRelay?: boolean
}

/**
 * **刻意不缓存中转结果 —— 每一次生成都是一次全新任务。**
 *
 * 本轮加过一版又撤掉了:以「路径 + 体积 + mtime」为键复用已中转的 COS URL,让
 * 工作台一板卡片共用的角色锚点只传一次(10 卡 × 6 图从 60 次降到 6 次)。撤掉是
 * 因为它和**素材位置即编号**这条硬约束冲突。
 *
 * 上游按下标解析素材编号(Seedance OpenAPI §2.3:「@参考N 要与 content[] 里的
 * 素材顺序一一对应」)。同一个文件在一次调用里出现两次时(「图1 与 图3 是同一个
 * 人」),复用同一个 URL 会让两个下标指向同一个地址,上游有可能据此折叠成一个
 * 参考 —— 后面的编号全体前移,而画面看着「像那么回事」,不报任何错。
 *
 * 省下的上传次数不值这个风险:并发压力已经由 `mediaRelay` 的 4 槽闸兜住,缓存
 * 再省的只是带宽;而位置错了是一个静默的错误答案。要重开这条路,先想清楚怎么
 * 保证「同一次调用内的重复项拿到不同 URL」。
 */
export async function resolveMediaUrl(
  src: string,
  label: string,
  /**
   * 调用方已知的 MIME(如渲染端从 File.type 拿到的),仅当扩展名查不到时启用。
   * 扩展名是文件在磁盘上的事实,优先级更高;浏览器那个只是补充覆盖面。
   */
  mimeHint?: string,
  options?: ResolveMediaOptions,
): Promise<string> {
  const alwaysRelay = options?.alwaysRelay === true
  const trimmed = src.trim()
  if (/^(https?:|asset:)/i.test(trimmed)) return trimmed

  if (/^data:/i.test(trimmed)) {
    const bytes = estimateDataUrlBytes(trimmed)
    if (!alwaysRelay && bytes <= MAX_INLINE_FILE_BYTES) return trimmed
    return relayOrInline(
      { bytes, relay: () => relayDataUrlToCos(trimmed), inline: async () => trimmed },
      label,
    )
  }

  let bytes: number
  try {
    // stat 而非 readFile:大文件走流式上传,这里只需要体积。
    const stat = await fs.stat(trimmed)
    if (!stat.isFile()) throw new Error('not a regular file')
    bytes = stat.size
  } catch {
    throw new Error(
      `${label}: cannot read local file "${trimmed}" — pass an existing path, data: URL, or https URL.`,
    )
  }
  const hinted = /^[a-z]+\/[a-z0-9.+-]+$/i.test(mimeHint?.split(';')[0]?.trim() ?? '')
    ? mimeHint!.split(';')[0].trim()
    : undefined
  const mime =
    MIME_BY_EXT[path.extname(trimmed).toLowerCase()] ?? hinted ?? 'application/octet-stream'
  const inline = async (): Promise<string> =>
    `data:${mime};base64,${(await fs.readFile(trimmed)).toString('base64')}`
  if (!alwaysRelay && bytes <= MAX_INLINE_FILE_BYTES) return inline()
  return relayOrInline(
    { bytes, relay: () => relayFileToCos(trimmed, mime, { fileSize: bytes }), inline },
    label,
  )
}
