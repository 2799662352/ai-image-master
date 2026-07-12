import type {
  ConcreteModelReasoningEffort,
  ModelReasoningEffort,
} from '../../../../shared/modelSettings'

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
 * amounts into the UI. Every row is a real provider model slug; ordinary
 * reasoning effort is selected and persisted separately per model.
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
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    tier: 'Fast',
    description: 'Fast and affordable agentic coding model (Codex 0.144 catalog).',
  },
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
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    tier: 'Medium',
    description: 'Default GPT-5.4. Balanced reasoning and latency.',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    tier: 'Medium',
    description: 'Balanced agentic coding model for everyday work (Codex 0.144 catalog).',
  },
  {
    id: 'gpt-5.4-2026-03-05',
    label: 'GPT-5.4 (2026-03-05 snapshot)',
    tier: 'Medium',
    description: 'Pinned GPT-5.4 snapshot. Use to lock behavior in evals.',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    tier: 'High',
    description: 'Newer GPT-5.5 family at default reasoning effort.',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    tier: 'Extra High',
    description: 'Latest frontier agentic coding model (Codex 0.144 catalog).',
  },
] as const

export const DEFAULT_MODEL_ID = 'gpt-5.5'

export function findModel(id: string): ModelOption | undefined {
  return AGENT_MODELS.find((m) => m.id === id)
}

export function resolveModelSelection(
  model: string,
  effort: ModelReasoningEffort = 'auto',
): { model: string; reasoningEffort?: ConcreteModelReasoningEffort } {
  return {
    model,
    ...(effort === 'auto' ? {} : { reasoningEffort: effort }),
  }
}
