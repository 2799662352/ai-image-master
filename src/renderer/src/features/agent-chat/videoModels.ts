/**
 * Curated catalog of video / multi-modal understanding models exposed by the
 * bundled apiyi-mcp-server. The `id` is the raw Gemini model name forwarded
 * to apiyi-mcp via the `GEMINI_MODEL` env var, which then gets used as the
 * default `model` arg for every `generate_content` tool call.
 *
 * Tiers mirror the codex `ModelPicker` vocabulary (Fast / Medium / High /
 * Extra High) so the price/latency gradient is consistent across both
 * pickers in the chat header.
 *
 * Default = `gemini-3.1-pro-preview-thinking` (matches apiyi-mcp's own
 * `DEFAULT_CONFIG.MODEL`). When a user has never picked a model, we don't
 * write `GEMINI_MODEL` into the TOML at all and apiyi-mcp falls back to
 * its built-in default — keeping the env block minimal.
 */
export type VideoModelTier = 'Fast' | 'Medium' | 'High' | 'Extra High'

export interface VideoModelOption {
  id: string
  label: string
  tier: VideoModelTier
  description: string
}

export const VIDEO_MODELS: readonly VideoModelOption[] = [
  {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    tier: 'Fast',
    description: '最便宜 / 最快。短视频、缩略图、轻量 PDF。',
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    tier: 'Fast',
    description: '便宜的视频理解默认。1080p 短片、音频、扫描件。',
  },
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    tier: 'Medium',
    description: '长上下文、长视频、复杂 PDF / 多表格。',
  },
  {
    id: 'gemini-3.1-pro-preview-thinking',
    label: 'Gemini 3.1 Pro (Thinking)',
    tier: 'High',
    description: '默认。开启思维链，适合深度视频 / 长 PDF 分析。',
  },
  {
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    tier: 'High',
    description: 'Gemini 3.1 Pro 不带思维链。更快、更便宜。',
  },
] as const

export const DEFAULT_VIDEO_MODEL_ID = 'gemini-3.1-pro-preview-thinking'

export function findVideoModel(id: string): VideoModelOption | undefined {
  return VIDEO_MODELS.find((m) => m.id === id)
}
