/**
 * Renderer-side fallback for the model's hard context window in tokens.
 *
 * Codex normally reports this via `tokenUsage.contextWindow` once the
 * `-c model_context_window=…` flag is in effect (see codexLaunch.ts).
 * Some legacy gateways and very early turns may still arrive without
 * the field — we use this constant so the donut/percent UI can keep
 * functioning instead of falling back to the raw token label.
 *
 * Keep in sync with the `model_context_window` value in
 * `src/main/agent/codexLaunch.ts` (currently 200_000).
 */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000

/**
 * Fixed floor Codex reserves for the always-resident system prompt + tool
 * overhead. Mirrors `BASELINE_TOKENS` in codex-rs/tui/src/token_usage.rs.
 * Subtracted from BOTH the used tokens and the window when computing the
 * "context used" percentage, so 0% means "only the baseline is loaded" and
 * 100% means "full". Keep in sync with upstream (currently 12_000).
 */
export const CONTEXT_BASELINE_TOKENS = 12_000

/**
 * Codex-aligned "context window used" percentage (0–100). Mirrors
 * `TokenUsage::percent_of_context_window_remaining` in
 * codex-rs/tui/src/token_usage.rs, inverted to "used" (= 100 − remaining):
 *
 *   effective = window − BASELINE
 *   used      = max(0, tokens − BASELINE)
 *   pct       = clamp(used / effective × 100, 0, 100)
 *
 * `tokens` MUST be the CURRENT context occupancy (codex `last_token_usage`,
 * i.e. `AgentTokenUsage.contextUsage`), never the cumulative session total —
 * see openai/codex#9601 / #10858. Returns `null` when the window is unusable
 * (≤ baseline), so callers can fall back to a token-count label.
 */
export function contextUsedPercent(tokens: number, window: number): number | null {
  if (!(window > CONTEXT_BASELINE_TOKENS)) return null
  const effective = window - CONTEXT_BASELINE_TOKENS
  const used = Math.max(0, tokens - CONTEXT_BASELINE_TOKENS)
  const pct = (used / effective) * 100
  return Math.min(100, Math.max(0, pct))
}
