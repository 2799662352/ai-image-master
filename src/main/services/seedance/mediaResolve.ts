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
  /**
   * 跳过中转结果缓存,每次都真传一份新的。
   *
   * 给**图片生成的参考图**用:每一次生图都是一次全新任务,同一张图在两次生成里
   * 应各自拿到独立的 URL。复用同一个 URL 有个具体的坏处 —— 同一张图在一次调用里
   * 出现两次(「图1 与 图3 是同一个人」)时,两个下标指向同一个地址,上游有可能按
   * 地址折叠成一个参考,后面的编号就全体前移了。
   *
   * 视频那边不传这个:工作台一板卡片共用同一套角色锚点是常态,缓存正是为那个
   * 场景加的。
   */
  noCache?: boolean
}

/**
 * 已中转过的本地文件 → COS URL。进程内,不持久化。
 *
 * 解决的是这个:同一张角色参考图挂在工作台的 10 张卡上,今天会被上传 10 次拿到
 * 10 个不同的 URL —— `relayKey` 每次调用都 `randomBytes` 生成新 key,上游素材接口
 * 那边的内容去重(重复导入直接返回已有记录)救不了已经花掉的上传。
 *
 * **键为什么是「路径 + 体积 + mtime」**:内容哈希要把整个文件读一遍,对 2GB 视频
 * 而言比上传本身还贵。体积 + mtime 是文件系统现成的,组合起来足以判定「还是不是
 * 上次那份」。理论盲区是「同一毫秒内改成同样大小」,用户手动换参考图碰不到。
 *
 * **只缓存中转结果,不缓存内联结果**:内联结果就是整个文件的 base64,缓存它等于
 * 把文件常驻内存。中转结果只是一个 URL 字符串。
 *
 * **不持久化**:COS 对象若被生命周期规则清掉,上游取素材会返回 502
 * (「远程素材 URL 已失效」)。进程内缓存的存活窗口短到不用担心这件事;跨会话复用
 * 需要先把桶的生命周期配置确认清楚,那是另一件事。
 */
const relayedUrlCache = new Map<string, string>()
/** 同一个键正在中转中的调用共享同一个 promise,避免并发时各传一份。 */
const relayInFlight = new Map<string, Promise<string>>()

function relayCacheKey(
  absolutePath: string,
  bytes: number,
  mtimeMs: number,
  alwaysRelay: boolean,
): string {
  // Windows 路径大小写不敏感,`C:\Refs\a.png` 与 `c:/refs/a.png` 是同一个文件。
  const normalized =
    process.platform === 'win32'
      ? absolutePath.replaceAll('\\', '/').toLowerCase()
      : absolutePath
  // alwaysRelay 必须进键:同一个小文件,开关不同时返回形态就不同(内联 vs COS URL)。
  return `${alwaysRelay ? 'relay' : 'auto'}|${normalized}|${bytes}|${mtimeMs}`
}

/** Exposed for tests; do not call from production code. */
export function __resetMediaResolveCacheForTests(): void {
  relayedUrlCache.clear()
  relayInFlight.clear()
}

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
  let mtimeMs: number
  try {
    // stat 而非 readFile:大文件走流式上传,这里只需要体积(顺带拿去重用的 mtime)。
    const stat = await fs.stat(trimmed)
    if (!stat.isFile()) throw new Error('not a regular file')
    bytes = stat.size
    mtimeMs = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : 0
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

  if (options?.noCache === true) {
    return relayOrInline(
      { bytes, relay: () => relayFileToCos(trimmed, mime, { fileSize: bytes }), inline },
      label,
    )
  }

  const key = relayCacheKey(path.resolve(trimmed), bytes, mtimeMs, alwaysRelay)
  const cached = relayedUrlCache.get(key)
  if (cached) return cached
  const inFlight = relayInFlight.get(key)
  if (inFlight) return inFlight

  // 只把**中转成功**的结果留在缓存里。降级内联的返回值是整个文件的 base64,
  // 缓存它等于把文件常驻内存;而且下一次中转可能已经恢复,不该被上次的失败钉死。
  const pending = (async () => {
    const relayed = await relayFileToCos(trimmed, mime, { fileSize: bytes })
    relayedUrlCache.set(key, relayed)
    return relayed
  })()
    .catch(async (e) => relayOrInline({ bytes, relay: () => Promise.reject(e), inline }, label))
    .finally(() => {
      relayInFlight.delete(key)
    })

  relayInFlight.set(key, pending)
  return pending
}
