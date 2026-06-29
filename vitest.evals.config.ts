import { defineConfig } from 'vitest/config'

/**
 * SEPARATE vitest project for the agent eval harness (evals/). Kept apart from
 * the app's `vitest.config.ts` so `npm test` stays fast, offline, and jsdom —
 * while evals run in a plain Node env with a long timeout for live agent turns.
 *
 *   *.test.ts  — deterministic harness unit tests (always run; no API key)
 *   *.eval.ts  — live agent-loop scenarios (self-skip without CODEX_EVAL_API_KEY)
 *
 * Scripts:
 *   npm run test:evals:unit  -> only *.test.ts (CI-safe, free)
 *   npm run test:evals       -> everything (live scenarios run iff creds present)
 */
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // Long enough for a real agent turn through a custom gateway.
    testTimeout: 300_000,
    hookTimeout: 60_000,
    include: ['evals/**/*.test.ts', 'evals/**/*.eval.ts'],
  },
})
