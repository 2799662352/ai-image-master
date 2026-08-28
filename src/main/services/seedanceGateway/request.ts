/**
 * 「经 Miau 网关提交 Seedance」的请求组包 —— 与 vvdance 直连**平行**的第二条路。
 *
 * ## 与 vvdance 直连的差异只在信封
 *
 * 直连打 Ark 协议 `POST {base}/api/v3/contents/generations/ark/tasks`，body 是扁平的
 * （`content` / `ratio` / `resolution` / `duration` / `generate_audio` 全在顶层，
 * 且**没有顶层 `prompt`**）。网关要的是 `metadata` 包裹 + 一个与 `content[0].text`
 * 重复的顶层 `prompt`。
 *
 * `content[]` 的条目形状两边**逐字节相同**。所以这里刻意不做 `wan3/fromContent.ts`
 * 那样的拆解重组 —— 那 83 行存在的理由是万相的 `metadata.input.media[]` 与 Ark 的
 * `content[]` 结构不同；这条路没有这个问题，重组只会引入下面三条不变量的破坏机会。
 *
 * ## 三条必须活着的不变量（都属于「上游照单全收、结果却不对」）
 *
 * 1. **`role` 在 entry 顶层。** 嵌进 `image_url` 对象里 schema 照样接受，模型却忽略
 *    —— 首帧会静默降级成一张松散的参考图。
 * 2. **持 URL 的键名跟 `type` 走**（`image_url` / `video_url` / `audio_url`），
 *    不能合并成一个通用 `url`。
 * 3. **顺序即编号。** 提示词里的「图片1 / 视频1」按 `content[]` 下标解析，
 *    重排一次上游不报任何错，只是生成的东西不是用户要的。
 *
 * 三条都靠「原样透传那个数组」保住，而不是靠逐条校验 —— 不碰它就破坏不了它。
 *
 * ## 与万相相反：`asset://` 必须放行
 *
 * `wan3/request.ts` 花了一整节去拦 `asset://`（DashScope 不认人像库）。这条路正相反：
 * 平台人像库的 `asset://<id>` 引用**正是它存在的理由**，拦掉等于把整个功能拦掉。
 */

import type { SeedanceContentItem } from '../seedance/types'

export interface SeedanceGatewayCreateTaskBody {
  model: string
  /**
   * 与 `metadata.content[0].text` 重复的那一份。不是冗余：网关的 OpenAI 兼容层按顶层
   * `prompt` 做路由与日志，`content[]` 原样转给上游。缺了顶层这份会被当成空提示词。
   */
  prompt: string
  metadata: {
    content: SeedanceContentItem[]
    duration: number
    ratio: string
    resolution: string
    generate_audio: boolean
  }
}

export interface SeedanceGatewayRequestInput {
  /** 已解析好的上游模型 id（如 `doubao-seedance-2-0-260128`），这里不做任何改写。 */
  model: string
  /** `seedance/runtime.ts` 的 `buildContent()` 产物，**原样透传**。 */
  content: SeedanceContentItem[]
  duration?: number
  ratio?: string
  resolution?: string
  generateAudio?: boolean
  /** 仅在 `content[]` 里一条 text 都没有时才用。正常链路走不到。 */
  promptFallback?: string
}

/**
 * 默认值**跟随桌面端 vvdance 直连的现状**，不跟网关侧那份参考实现。
 *
 * 两边的 `ratio` 默认值不同（我们 `16:9`，参考实现 `9:16`）。跟错的后果不是报错，
 * 而是没显式选画幅的用户突然拿到竖屏 —— 同一个应用里两条路给出不同结果，
 * 而用户不知道自己切换过什么。
 */
export const SEEDANCE_GATEWAY_DEFAULTS = {
  ratio: '16:9',
  resolution: '720p',
  duration: 5,
  generateAudio: true,
} as const

/**
 * 顶层 `prompt` 从 `content[]` 里**取**而不是由调用方**另给**。
 *
 * 调用方手上那个 `input.prompt` 是归一化之前的原文（`normalizeSeedancePromptReferences`
 * 会改写 `@参考N` 这类标签）。两份各写各的就会漂移，而漂移的症状是顶层与 `content[0]`
 * 说着两句不同的话，上游按哪句走完全看它心情。
 */
function promptFrom(content: SeedanceContentItem[], fallback: string): string {
  for (const item of content) {
    if (item.type === 'text') return item.text
  }
  return fallback
}

export function buildSeedanceGatewayCreateBody(
  input: SeedanceGatewayRequestInput,
): SeedanceGatewayCreateTaskBody {
  return {
    model: input.model,
    prompt: promptFrom(input.content, input.promptFallback ?? ''),
    metadata: {
      content: input.content,
      // `-1`（智能时长）是合法值，所以判据是「有没有给」而不是「真不真」。
      duration: input.duration ?? SEEDANCE_GATEWAY_DEFAULTS.duration,
      ratio: input.ratio ?? SEEDANCE_GATEWAY_DEFAULTS.ratio,
      resolution: input.resolution ?? SEEDANCE_GATEWAY_DEFAULTS.resolution,
      generate_audio: input.generateAudio ?? SEEDANCE_GATEWAY_DEFAULTS.generateAudio,
    },
  }
}
