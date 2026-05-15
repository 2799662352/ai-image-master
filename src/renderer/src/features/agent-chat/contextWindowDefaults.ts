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
