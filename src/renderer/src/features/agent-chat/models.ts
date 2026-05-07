/**
 * Curated catalog of agent models served by API易 (apiyi). The `id` is the
 * raw model name we forward to Codex — apiyi proxies straight to OpenAI's
 * Responses API so these names follow OpenAI's official model IDs.
 *
 * Sources:
 *   - https://docs.apiyi.com/api-capabilities/openai-responses
 *   - https://docs.apiyi.com/api-manual
 *
 * Tiers borrow Cursor's Fast/Medium/High/Extra High vocabulary so the picker
 * groups have an obvious price/latency gradient without leaking dollar
 * amounts into the UI.
 */
export type ModelTier = 'Fast' | 'Medium' | 'High' | 'Extra High'

export interface ModelOption {
  id: string
  label: string
  tier: ModelTier
  description: string
}

export const AGENT_MODELS: readonly ModelOption[] = [
  {
    id: 'gpt-4.1-mini',
    label: 'GPT-4.1 Mini',
    tier: 'Fast',
    description: 'Cheap, low-latency. Default for quick edits and triage.',
  },
  {
    id: 'gpt-4.1',
    label: 'GPT-4.1',
    tier: 'Medium',
    description: 'Balanced general-purpose model.',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    tier: 'Medium',
    description: 'Multimodal, strong on image+text reasoning.',
  },
  {
    id: 'o4-mini',
    label: 'o4-mini',
    tier: 'High',
    description: 'Reasoning model, fast tier. Good for code and math.',
  },
  {
    id: 'o3',
    label: 'o3',
    tier: 'High',
    description: 'Reasoning model, deeper thought, slower.',
  },
  {
    id: 'o3-pro',
    label: 'o3 Pro',
    tier: 'Extra High',
    description: 'Most capable reasoning tier. Slow and expensive.',
  },
] as const

export const DEFAULT_MODEL_ID = 'gpt-4.1-mini'

export function findModel(id: string): ModelOption | undefined {
  return AGENT_MODELS.find((m) => m.id === id)
}
