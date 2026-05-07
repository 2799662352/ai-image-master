/**
 * Curated catalog of agent models. The `id` is the raw model name forwarded
 * to Codex (which posts to the configured provider's Responses endpoint).
 *
 * The list targets the GPT-5.x family that has full Responses-API support
 * including the native `web_search` tool — which gpt-4.1-mini on apiyi
 * rejected with `tools[i].type='web_search'` invalid_value errors.
 *
 * Tiers borrow Cursor's Fast/Medium/High/Extra High vocabulary so the picker
 * groups have an obvious price/latency gradient without leaking dollar
 * amounts into the UI. Reasoning-effort suffixes (`-low`/`-medium`/`-high`/
 * `-xhigh`) follow Codex's convention of encoding effort in the model id.
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
    id: 'gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    tier: 'Fast',
    description: 'Smallest GPT-5.4 size. Cheapest, lowest latency.',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    tier: 'Fast',
    description: 'Compact GPT-5.4. Quick edits, triage, drafting.',
  },
  {
    id: 'gpt-5.4-low',
    label: 'GPT-5.4 (Low effort)',
    tier: 'Medium',
    description: 'GPT-5.4 with low reasoning budget. Faster than default.',
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    tier: 'Medium',
    description: 'Default GPT-5.4. Balanced reasoning and latency.',
  },
  {
    id: 'gpt-5.4-medium',
    label: 'GPT-5.4 (Medium effort)',
    tier: 'Medium',
    description: 'GPT-5.4 with explicit medium reasoning effort.',
  },
  {
    id: 'gpt-5.4-2026-03-05',
    label: 'GPT-5.4 (2026-03-05 snapshot)',
    tier: 'Medium',
    description: 'Pinned GPT-5.4 snapshot. Use to lock behavior in evals.',
  },
  {
    id: 'gpt-5.4-high',
    label: 'GPT-5.4 (High effort)',
    tier: 'High',
    description: 'GPT-5.4 with high reasoning budget. Deeper thought.',
  },
  {
    id: 'gpt-5.4-xhigh',
    label: 'GPT-5.4 (Extra High)',
    tier: 'High',
    description: 'GPT-5.4 with maximum reasoning budget. Slow.',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    tier: 'High',
    description: 'Newer GPT-5.5 family at default reasoning effort.',
  },
  {
    id: 'gpt-5.5-xhigh',
    label: 'GPT-5.5 (Extra High)',
    tier: 'Extra High',
    description: 'Top tier — GPT-5.5 with maximum reasoning. Slow + costly.',
  },
] as const

export const DEFAULT_MODEL_ID = 'gpt-5.5'

export function findModel(id: string): ModelOption | undefined {
  return AGENT_MODELS.find((m) => m.id === id)
}
