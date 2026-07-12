import type {
  CanonicalModelTier,
  ConcreteModelReasoningEffort,
  ModelReasoningEffort,
} from '../../../../shared/modelSettings'
import { CANONICAL_MODEL_SETTINGS_ROWS } from '../../../../shared/modelSettings'

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
export type ModelTier = CanonicalModelTier

export interface ModelOption {
  id: string
  label: string
  tier: ModelTier
  description: string
}

export const AGENT_MODELS: readonly ModelOption[] =
  CANONICAL_MODEL_SETTINGS_ROWS.map((row) => ({
    id: row.id,
    label: row.displayName,
    tier: row.tier,
    description: row.description,
  }))

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
