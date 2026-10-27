/**
 * 深度捕捉(`depth`)—— `generate_video` 的一个**变体**,把一段视频转成灰度深度视频
 * (近亮远暗,可作运动参考)。
 *
 * ## 上游是什么(读网关源码 + 腾讯官方文档 + 真实调用,不是猜的)
 *
 * Miau 网关的**腾讯云点播**渠道(new-api 渠道类型 76 `TencentVOD`,
 * `relay/channel/task/tencentvod`,new-api PR #170),调的是点播的「视频深度估计」
 * `VideoDepthEstimation`。它**取代**了 RunningHub —— RunningHub 的这几个模型官方已下线。
 * 对调用方的契约没变,所以模型名仍叫 `rh-video-depth-*`(改名会让已有计价和调用点失效):
 *   - 模型 `rh-video-depth-480p | 720p | 1080p`。**腾讯这个接口没有分辨率参数**:三档产物
 *     完全一致、同价,档位只是一个名字,选哪个都一样(默认值取中间档只是为了与别的模型一致);
 *   - 提交 `POST /v1/videos`,body `{ model, metadata: { content: [{ type: 'video_url',
 *     video_url: { url } }] } }` —— 与火山 MediaKit / DAMO 超分是**同一套任务协议**,
 *     所以直接复用 `mediaKit/client`,不再造一个平行的客户端;
 *   - 轮询 `GET /v1/videos/{id}`,结果在 `metadata.url`,失败原因在 `error.message`
 *     (网关只在有产物时才写 `metadata.url`,失败任务不会把原因塞进去);
 *   - 按次计费,网关默认单价 ¥0.5,与源视频时长、体积无关。**这是网关价目表的默认值,
 *     腾讯没有公开该接口的价格,是否覆盖成本要看腾讯账单**;
 *   - 产物是腾讯的**临时存储,7 天后过期**;任务一成功,`taskManager` 就经 `persistVideo`
 *     把它下载到本地并转存 COS(与别的视频模型同一条链),历史记录存的是转存后的地址。
 *
 * ## 上游的限制(桌面端提前拦下,别等上游回一句看不懂的话)
 *
 *   - 源视频必须是**公网 http(s) URL**:上游自己去拉,`data:` / `asset://` / 本机路径一律
 *     拉不到(网关有意不开放 `vod://` 与 `data:`),所以本地文件要先中转 COS(`relayFileToCos`)。
 *     地址超过 8182 字符网关会在入口拒掉;中转出来的 COS 地址远短于此;
 *   - **时长 / 体积上限腾讯没有公布。** 旧后端(RunningHub)的「≤3 分钟、≤100 MB」不再是上游
 *     的限制。实测(2026-10-26,经 Miau 网关):5 秒 / 0.8 MB 约 1.5 分钟;60 秒 / 720p /
 *     20 MB 与 60 秒 / 1080p / 86 MB 各约 22 分钟,都成功、输出是同尺寸同帧数的灰度深度视频;
 *     180 秒 / 60 MB 等了 34 分钟仍未出结果。**耗时随时长明显增长**,所以 taskManager 对 depth
 *     把轮询上限放宽到 50 分钟(其它模型仍 30 分钟);
 *   - 下面的 {@link DEPTH_MAX_SOURCE_BYTES} 因此是**桌面端自己设的保守上限**,不是上游的:
 *     体积在本地能直接量到,几百兆的文件先中转 COS 再被拒(或超时)不划算,**提交前**拦下并告诉
 *     调用方怎么压(ffmpeg-win)。时长在本地量不到(没有 ffprobe 助手),不拦;任务失败时网关会退款。
 */

import type { MediaKitModel } from '../mediaKit/client'
import type { CreateVideoTaskInput, SeedanceContentItem } from '../seedance/types'

/**
 * 区域表(`seedance/region.ts`)里 depth 那一行填的值。
 *
 * 那两张表是 `Record<VideoModelAlias, string>`,为保住穷尽性才登记它;**它不是能发出去的
 * 模型 id** —— 真正的 id 要带分辨率后缀,见 {@link depthUpstreamModelId}。
 */
export const DEPTH_UPSTREAM_MODEL_ID_BASE = 'rh-video-depth'

/**
 * 桌面端对本地源视频设的**保守**体积上限(字节)—— 不是上游的限制,腾讯没公布上限(见文件头)。
 * 旧后端 RunningHub 的 100 MB 沿用至今;真要放宽,先拿更大的视频实测过再改。
 */
export const DEPTH_MAX_SOURCE_BYTES = 100 * 1024 * 1024

const DEPTH_RESOLUTIONS: readonly string[] = ['480p', '720p', '1080p']

/** 内部小写口径的分辨率 → 网关模型 id。不认识的分辨率直接抛,不静默兜底成某一档(档位就是价格)。 */
export function depthUpstreamModelId(resolution: string): MediaKitModel {
  const key = resolution.trim().toLowerCase()
  if (!DEPTH_RESOLUTIONS.includes(key)) {
    throw new Error(`深度捕捉不支持分辨率 ${resolution}，可用：${DEPTH_RESOLUTIONS.join(' / ')}`)
  }
  return `rh-video-depth-${key}` as const
}

/**
 * 从最终 content[] 里取出那一段源视频的公网地址。
 *
 * content[] 里还会有一条 text(`buildContent` 一律放),深度捕捉不读它 —— 这里只认
 * `video_url`,且必须恰好一条:多于一条意味着上游会处理哪一段是不确定的,宁可提交前报错。
 */
export function pickDepthSourceUrl(content: readonly SeedanceContentItem[]): string {
  const urls: string[] = []
  for (const item of content) {
    if (item.type === 'video_url') urls.push(item.video_url.url)
  }
  if (urls.length !== 1) {
    throw new Error(`深度捕捉需要恰好一段源视频，收到 ${urls.length} 段`)
  }
  const url = urls[0]
  if (!/^https?:\/\//i.test(url)) {
    // 到这里理应已被中转成 https;不是就说明中转被绕开了(asset:// / data: 漏进来)。
    throw new Error('深度捕捉的源视频必须是公网 http(s) 地址 —— 上游自己去拉，拿不到本机文件、data: 或 asset://')
  }
  return url
}

export interface DepthInputCheckDeps {
  /** 本地文件体积;读不到(不存在 / 不是文件)返回 null,交给后面的统一报错。 */
  statSize: (filePath: string) => Promise<number | null>
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1)
}

/**
 * 提交前的输入预检,返回人话错误(空 = 放行)。
 *
 * 在**任何** COS 中转之前跑:带了图 / 音频、传了 `asset://`、本地文件超 100 MB,这些都能在
 * 本机直接判出来,没必要先把几百兆传上去再等上游拒。能力表层面的数量校验
 * (`validateSeedanceRequest`)会在 `taskManager.submit` 里再兜一次。
 */
export async function checkDepthInput(
  input: CreateVideoTaskInput,
  deps: DepthInputCheckDeps,
): Promise<string[]> {
  const errors: string[] = []

  const videos = [
    ...(input.referenceVideos ?? []),
    ...(input.referenceVideo ? [input.referenceVideo] : []),
  ].filter((v) => typeof v === 'string' && v.trim().length > 0)
  const extraMaterials =
    (input.firstFrame ? 1 : 0) +
    (input.lastFrame ? 1 : 0) +
    (input.referenceImages?.length ?? 0) +
    (input.referenceAudios?.length ?? 0) +
    (input.referenceAudio ? 1 : 0)

  if (videos.length !== 1) {
    errors.push(`深度捕捉需要恰好一段源视频（referenceVideos 传 1 个），收到 ${videos.length} 段`)
  }
  if (extraMaterials > 0) {
    errors.push('深度捕捉只接受一段源视频，不能再带图片 / 首尾帧 / 音频')
  }
  if (input.taskMode) errors.push('深度捕捉没有 taskMode（edit / extend 是 Seedance 2.5 的）')
  if (errors.length > 0) return errors

  const source = videos[0].trim()
  if (/^asset:/i.test(source)) {
    errors.push('深度捕捉的源视频不能是 asset:// 素材库引用 —— 上游要公网地址。请传本地路径或 https 链接')
    return errors
  }
  if (/^https?:/i.test(source)) return errors // 远程地址:体积 / 时长只有上游知道

  if (/^data:/i.test(source)) {
    const comma = source.indexOf(',')
    const payload = comma >= 0 ? source.length - comma - 1 : source.length
    const bytes = Math.floor((payload * 3) / 4)
    if (bytes > DEPTH_MAX_SOURCE_BYTES) errors.push(oversizeMessage(bytes))
    return errors
  }

  const size = await deps.statSize(source)
  if (size !== null && size > DEPTH_MAX_SOURCE_BYTES) errors.push(oversizeMessage(size))
  return errors
}

function oversizeMessage(bytes: number): string {
  return (
    `源视频 ${mb(bytes)} MB，超过深度捕捉的 ${mb(DEPTH_MAX_SOURCE_BYTES)} MB 保守上限` +
    '（这是桌面端为避免中转大文件后失败设的，腾讯点播没有公布上限，更大的视频也没测过）。' +
    '请先用 ffmpeg-win 压缩（如 `-vf scale=-2:720 -crf 28`）或截取需要的片段，再重新提交'
  )
}
