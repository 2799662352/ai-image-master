/**
 * 可灵 4.0 / 4.0 Omni 的请求组包 —— 经 Miau 网关(new-api #183)。
 *
 * ## 为什么不另造一套信封
 *
 * 网关对可灵收的 `metadata` 与「平台余额下的 Seedance」是同一个形状:`content[]` 里
 * `{ type: 'image_url' | 'video_url', role, <type>: { url } }`,外加 `duration` / `ratio` /
 * `resolution` / `generate_audio`。所以信封直接复用 `seedanceGateway/request.ts` 的
 * `buildSeedanceGatewayCreateBody`,**`content[]` 原样透传**(顺序即编号:提示词里的
 * 「图片N / 视频N」按下标解析,网关再把它改写成可灵要的 `@image_N / @video_N`)。
 *
 * 这个模块只做一件事:**把网关一定会拒的组合在本地先拦下来**,并且说人话。网关的拒绝信息是
 * 英文原文(`kling-v4-vod accepts at most …`),而且要走完「COS 中转 → 提交」一整趟才看到;
 * 桌面端的素材要先上传 COS,等到那时才被拒,用户已经白等了一轮上传。
 *
 * ## 与 Seedance 网关那条路的差异(都是网关契约,new-api #183)
 *
 * - **没有智能时长**:`duration` 必须是 3–30 的整数,`-1` 被拒;
 * - **画幅**只认 `21:9 / 16:9 / 9:16 / 1:1 / adaptive`,没有 4:3 / 3:4;
 * - **分辨率** `720p / 1080p / 2k / 4k`(网关大小写不敏感,内部口径统一小写);
 * - **素材只收公网 http(s) 直链**,≤ 8182 字符;`asset://`(人像库)与 `vod://` 一律拒;
 * - **没有音频参考**;
 * - **4.0 只有首帧 / 尾帧**,参考图 / 参考视频要 Omni(网关:`need kling-v4-omni-vod`);
 *   Omni 参考图 ≤ 10、参考视频 ≤ 5、**所有文件(含首尾帧)合计 ≤ 15**;
 * - 没有 seed、联网搜索、样片 —— 这几项不会出现在请求里。
 */

import {
  buildSeedanceGatewayCreateBody,
  type SeedanceGatewayGenerateBody,
} from '../seedanceGateway/request'
import { klingUpstreamModelId, type KlingAlias } from './model'
import type { SeedanceContentItem } from '../seedance/types'
import { normalizeSeedancePromptReferences } from '../seedance/promptReferences'
import {
  joinKlingShotPrompts,
  validateKlingMultiShot,
  type KlingMultiShot,
} from '../../../types/klingMultiShot'

/** 网关对素材 URL 的长度上限(字符)。超了上游拉不到,而且错误里看不出是长度问题。 */
export const KLING_MAX_MEDIA_URL_LENGTH = 8182

const KLING_MIN_DURATION = 3
const KLING_MAX_DURATION = 30
const KLING_RATIOS: readonly string[] = ['21:9', '16:9', '9:16', '1:1', 'adaptive']
const KLING_RESOLUTIONS: readonly string[] = ['720p', '1080p', '2k', '4k']
const KLING_OMNI_MAX_REF_IMAGES = 10
const KLING_OMNI_MAX_REF_VIDEOS = 5
const KLING_OMNI_MAX_FILES = 15

/** 组包期的已知拒绝。消息是给用户看的人话,提交失败卡片会原样显示。 */
export class KlingRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KlingRequestError'
  }
}

/**
 * 分镜在网关请求里的样子(new-api #184):`multi_shot` 是开关,`shot_type` 选模式,
 * 自定义分镜再带 `multi_prompt`(逐镜头的描述 + 整数秒)。三个键只在开分镜时出现。
 */
export interface KlingMultiShotMetadata {
  multi_shot: true
  shot_type: 'intelligence' | 'customize'
  multi_prompt?: Array<{ prompt: string; duration: number }>
}

export type KlingGatewayGenerateBody = Omit<SeedanceGatewayGenerateBody, 'metadata'> & {
  metadata: SeedanceGatewayGenerateBody['metadata'] & Partial<KlingMultiShotMetadata>
}

export interface KlingRequestInput {
  model: KlingAlias
  /** `seedance/runtime.ts` 的 `buildContent()` 产物,**原样透传**。 */
  content: SeedanceContentItem[]
  ratio: string
  resolution: string
  duration: number
  generateAudio?: boolean
  /** 仅在 `content[]` 里一条 text 都没有时才用。正常链路走不到。 */
  promptFallback?: string
  /** 分镜。缺省 / null = 单镜头(请求里一个分镜字段都不出现)。 */
  multiShot?: KlingMultiShot | null
}

function mediaUrlOf(item: SeedanceContentItem): string | undefined {
  switch (item.type) {
    case 'image_url':
      return item.image_url.url
    case 'video_url':
      return item.video_url.url
    case 'audio_url':
      return item.audio_url.url
    default:
      return undefined
  }
}

function requirePublicUrl(raw: string, label: string): void {
  const url = raw.trim()
  // `asset://` 单独说一句人话:它是 Seedance 素材库 / 人像库的引用形态,用户是从素材选择器里
  // 挑出来的,看到「必须是 http(s) 地址」只会一头雾水。
  if (url.startsWith('asset://')) {
    throw new KlingRequestError(`可灵不支持人像库素材（${label}），请改用本地文件或图片链接`)
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new KlingRequestError(`${label}必须是公网 http(s) 地址（可灵不收本地路径、base64 或 vod:// 地址）`)
  }
  if (url.length > KLING_MAX_MEDIA_URL_LENGTH) {
    throw new KlingRequestError(`${label}的地址过长（${url.length} 字符，可灵上限 ${KLING_MAX_MEDIA_URL_LENGTH}）`)
  }
}

function textOf(content: SeedanceContentItem[], fallback: string): string {
  for (const item of content) if (item.type === 'text') return item.text
  return fallback
}

/**
 * 自定义分镜下总提示词留空 → 顶层提示词用各镜头描述拼一份(网关自己也会拼,这里拼是让
 * 提交的和任务详情里看到的是同一份)。只动第一条 text,其余 content 项与顺序原样保留。
 */
function withShotPrompt(
  content: SeedanceContentItem[],
  multiShot: Extract<KlingMultiShot, { type: 'customize' }>,
): SeedanceContentItem[] {
  const joined: SeedanceContentItem = { type: 'text', text: joinKlingShotPrompts(multiShot.shots) }
  const at = content.findIndex((item) => item.type === 'text')
  if (at === -1) return [joined, ...content]
  return content.map((item, i) => (i === at ? joined : item))
}

function multiShotMetadata(multiShot: KlingMultiShot): KlingMultiShotMetadata {
  if (multiShot.type === 'intelligence') return { multi_shot: true, shot_type: 'intelligence' }
  return {
    multi_shot: true,
    shot_type: 'customize',
    multi_prompt: multiShot.shots.map((shot) => ({
      // 与顶层提示词同口径:工作台 chip 的 `【@图片1】` 外壳解成 `@图片1`(网关两种写法都认,这里先收敛)。
      prompt: normalizeSeedancePromptReferences(shot.prompt.trim()),
      duration: shot.duration,
    })),
  }
}

export function buildKlingCreateBody(input: KlingRequestInput): KlingGatewayGenerateBody {
  const { model } = input
  let content = input.content
  const omni = model === 'kling4-omni'

  if (!Number.isInteger(input.duration) || input.duration < KLING_MIN_DURATION || input.duration > KLING_MAX_DURATION) {
    throw new KlingRequestError(
      `可灵的时长支持 ${KLING_MIN_DURATION}-${KLING_MAX_DURATION} 秒的整数（没有智能时长），收到 ${input.duration}`,
    )
  }
  const resolution = input.resolution.trim().toLowerCase()
  if (!KLING_RESOLUTIONS.includes(resolution)) {
    throw new KlingRequestError(
      `可灵不支持分辨率 ${input.resolution}，可用：${KLING_RESOLUTIONS.join(' / ')}`,
    )
  }
  if (!KLING_RATIOS.includes(input.ratio)) {
    throw new KlingRequestError(`可灵不支持画幅 ${input.ratio}，可用：${KLING_RATIOS.join(' / ')}`)
  }

  let firstFrames = 0
  let lastFrames = 0
  let refImages = 0
  let refVideos = 0
  let files = 0
  for (const item of content) {
    if (item.type === 'text') continue
    if (item.type === 'audio_url') {
      throw new KlingRequestError('可灵不接受参考音频，请移除音频素材')
    }
    const role = item.role
    const label =
      role === 'first_frame' ? '首帧' : role === 'last_frame' ? '尾帧' : item.type === 'video_url' ? '参考视频' : '参考图'
    const url = mediaUrlOf(item)
    requirePublicUrl(url ?? '', label)
    files += 1
    if (role === 'first_frame') firstFrames += 1
    else if (role === 'last_frame') lastFrames += 1
    else if (item.type === 'video_url') refVideos += 1
    else refImages += 1
  }

  if (firstFrames > 1) throw new KlingRequestError('可灵只接受一张首帧')
  if (lastFrames > 1) throw new KlingRequestError('可灵只接受一张尾帧')
  if (lastFrames > 0 && firstFrames === 0) throw new KlingRequestError('可灵的尾帧必须配首帧一起使用')

  if (!omni && (refImages > 0 || refVideos > 0)) {
    throw new KlingRequestError(
      '可灵 4.0 不支持参考图与参考视频（只有首帧 / 尾帧），需要改用「可灵 4.0 Omni」',
    )
  }
  if (omni) {
    if (refImages > KLING_OMNI_MAX_REF_IMAGES) {
      throw new KlingRequestError(`可灵 4.0 Omni 的参考图最多 ${KLING_OMNI_MAX_REF_IMAGES} 张，收到 ${refImages}`)
    }
    if (refVideos > KLING_OMNI_MAX_REF_VIDEOS) {
      throw new KlingRequestError(`可灵 4.0 Omni 的参考视频最多 ${KLING_OMNI_MAX_REF_VIDEOS} 段，收到 ${refVideos}`)
    }
    if (files > KLING_OMNI_MAX_FILES) {
      throw new KlingRequestError(
        `可灵 4.0 Omni 的图片 + 视频（含首帧 / 尾帧）合计最多 ${KLING_OMNI_MAX_FILES} 个，收到 ${files}`,
      )
    }
  }

  const multiShot = input.multiShot ?? null
  if (multiShot) {
    const topLevel = textOf(content, input.promptFallback ?? '')
    const invalid = validateKlingMultiShot(multiShot, input.duration, topLevel)
    if (invalid) throw new KlingRequestError(invalid)
    if (multiShot.type === 'customize' && !topLevel.trim()) content = withShotPrompt(content, multiShot)
  }

  // 网关:没有任何文件时提示词必填;有文件时可以只靠素材。
  const prompt = textOf(content, input.promptFallback ?? '')
  if (files === 0 && !prompt.trim()) {
    throw new KlingRequestError('可灵的文生视频需要提示词')
  }

  const body = buildSeedanceGatewayCreateBody({
    model: klingUpstreamModelId(model),
    // 直通。三条不变量(role 在顶层 / URL 键名跟 type 走 / 顺序即编号)靠「不碰它」保住。
    content,
    ratio: input.ratio,
    resolution,
    duration: input.duration,
    generateAudio: input.generateAudio,
    ...(input.promptFallback !== undefined ? { promptFallback: input.promptFallback } : {}),
  })
  if (!multiShot) return body
  return { ...body, metadata: { ...body.metadata, ...multiShotMetadata(multiShot) } }
}
