/**
 * Single source of truth for the chat's image-generation *channels* (渲染渠道).
 *
 * This mirrors `models.ts` (the language-model catalog) but for the picture
 * pipeline: the user picks a channel in the composer footer
 * (`ImageChannelPicker`) and that choice is **authoritative** — every
 * `generate_image` / `generate_images` call the agent makes renders on the
 * selected channel, exactly like the GPT model picker decides which LLM runs.
 * The agent's own `model` argument is ignored for channel selection (用户选什么
 * 渠道 chat 就用什么).
 *
 * Because the UI list AND the tool-side resolver both read from this one array,
 * adding/renaming a channel here automatically flows to both places ("跟随模型
 * 更新") without touching `AgentToolExecutor` or the picker.
 *
 * `miauOnly` marks channels that ONLY reach their model through the Miau API
 * gateway; the resolver pins those requests to the Miau site (`siteKey`) so they
 * work regardless of which site the user has selected.
 */
export interface ImageChannel {
  /** Raw model id forwarded to `ApiService.generateImage`. */
  id: string
  /** Compact label shown on the picker pill (e.g. "VIP"). */
  label: string
  /** Longer label shown in the dropdown row. */
  fullLabel: string
  /** One-line hint shown under the row. */
  description: string
  /** When true, generation is pinned to the Miau API site. */
  miauOnly: boolean
}

/**
 * Ordered exactly as requested (2026-07-20): Seedream 5.0 Pro → 腾讯 → Nano2 →
 * 万相 2.7 pro → Image2 官方 → VIP. The DEFAULT channel stays VIP — order is
 * display-only and does not change the fallback.
 */
export const IMAGE_CHANNELS: readonly ImageChannel[] = [
  {
    id: 'doubao-seedream-5-0-pro-260628',
    label: 'SD5',
    fullLabel: 'Seedream 5.0 Pro',
    description: '火山豆包 Seedream 5.0 Pro — 多图融合(≤10 参考图)，1K/2K 单图，经 Miau 代理。',
    miauOnly: true,
  },
  {
    id: 'custom-imagemodel-gt',
    label: '腾讯',
    fullLabel: '腾讯 image2',
    description: '经 Miau 代理 — 快 ~30s，网关去水印。',
    miauOnly: true,
  },
  {
    id: 'gemini-3.1-flash-image',
    label: 'Nano2',
    fullLabel: 'Nano Banana 2',
    description: 'Gemini 3.1 flash image（当前站点）— 快，多比例 4K。',
    miauOnly: false,
  },
  {
    id: 'wan2.7-image-pro',
    label: 'Wan2.7',
    fullLabel: '万相 2.7 pro',
    description: '阿里万相 2.7 pro — 超清/组图，经 Miau 代理。',
    miauOnly: true,
  },
  {
    // DashScope 同步多模态出图，经 Miau 的 OpenAI 兼容 /v1/images/generations。
    // 注意两条与别家不同的脾气（接入说明 2026-08-07 §6 / §9）：上游可能忽略或
    // 改写请求尺寸（实测请求 1328×1328 拿回约 1792×2400），所以别把 size 当承诺；
    // `negative_prompt` 不会经网关透传（AliImageParameters 里没有这个键，反序列化
    // 时直接丢弃），要压画质问题得写进正向提示词。
    id: 'qwen-image-3.0-pro',
    label: 'Qwen3',
    fullLabel: '通义千问 Image 3.0 Pro',
    description: '阿里通义千问 Image 3.0 Pro — 同步出图，一次可出 1–6 张、参考图最多 3 张；尺寸以实际返回为准。',
    miauOnly: true,
  },
  {
    id: 'gpt-image-2',
    label: 'Image2',
    fullLabel: 'GPT Image 2 官方',
    description: 'API易 OpenAI 官方旗舰 — 按 token 计费，慢但质量上限最高，4K+mask 重绘。',
    miauOnly: false,
  },
  {
    id: 'gpt-image-2-vip',
    label: 'VIP',
    fullLabel: 'VIP image2',
    description: 'OpenAI 官逆，稳定。默认渠道。',
    miauOnly: false,
  },
] as const

/** Default channel when the user hasn't picked (or the stored value is stale). */
export const DEFAULT_IMAGE_CHANNEL_ID = 'gpt-image-2-vip'

export function findImageChannel(id: string): ImageChannel | undefined {
  return IMAGE_CHANNELS.find((c) => c.id === id)
}

export function isSelectableImageChannel(id: unknown): id is string {
  return typeof id === 'string' && IMAGE_CHANNELS.some((c) => c.id === id)
}

export function isMiauOnlyChannel(id: string): boolean {
  return findImageChannel(id)?.miauOnly === true
}

/**
 * Resolve any candidate (user selection, stale storage, agent-passed value) to a
 * valid channel id, falling back to the default (VIP) so generation never breaks.
 */
export function resolveImageChannel(candidate: unknown): string {
  return isSelectableImageChannel(candidate) ? candidate : DEFAULT_IMAGE_CHANNEL_ID
}
