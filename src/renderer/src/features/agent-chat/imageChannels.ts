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
 * Ordered exactly as requested: VIP (default) → 腾讯 → Nano Banana 2 → 万相 2.7 pro.
 */
export const IMAGE_CHANNELS: readonly ImageChannel[] = [
  {
    id: 'gpt-image-2-vip',
    label: 'VIP',
    fullLabel: 'VIP image2',
    description: 'OpenAI 官逆，稳定。默认渠道。',
    miauOnly: false,
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
