import { describe, expect, it } from 'vitest'
import { hasEvalCreds } from '../harness/env'
import { runCodex } from '../harness/runCodex'
import { assertToolArgs, assertToolUsed, mcpToolCalls, turnFailed } from '../harness/trajectory'

/**
 * L1 agent-loop eval for the `ask_user` option-card tool.
 *
 * This is the regression that protects the fix we shipped in v4.3.64: when the
 * user asks the agent to DECIDE between 2+ options, the agent must reach for the
 * clickable `ask_user` card — not hand back a numbered text list (and not mangle
 * the tool name into `catimationaskuser`, which used to fail upstream).
 *
 * Skips automatically without creds. To run:
 *   $env:CODEX_EVAL_API_KEY = "sk-..."   # + optional CODEX_EVAL_BASE_URL / CODEX_EVAL_MODEL
 *   npm run test:evals
 */
describe.skipIf(!hasEvalCreds())('ask_user option card (L1 agent loop)', () => {
  it(
    'surfaces a clickable ask_user card with 3 options when asked to decide a shot size',
    async () => {
      const { events, stderr } = await runCodex({
        prompt:
          '我在拍一条短片，这个镜头的景别还没定。请帮我在 近景 / 中景 / 远景 三个里做个决定，' +
          '用可点击的选项卡让我选，不要只给我一段文字列表。',
        tools: [
          {
            name: 'ask_user',
            description:
              'Interactive clickable choice card in CATIMATION chat. Use whenever you would list 2+ options for the user to pick.',
            inputSchema: {
              type: 'object',
              required: ['question', 'options'],
              properties: {
                question: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['id', 'label'],
                    properties: { id: { type: 'string' }, label: { type: 'string' } },
                  },
                },
              },
            },
            // Canned "user picked 中景" so the turn completes deterministically.
            cannedResult: { selected: [{ id: 'mid', label: '中景' }], freeText: '' },
          },
        ],
      })

      expect(turnFailed(events), `turn failed; stderr tail:\n${stderr.slice(-1500)}`).toBe(false)

      // HARD trajectory gate: the agent actually called the card tool…
      assertToolUsed(events, 'ask_user')
      // …and presented at least 3 options (the three shot sizes).
      assertToolArgs(events, 'ask_user', (args) => {
        const options = (args as { options?: unknown[] }).options
        return Array.isArray(options) && options.length >= 3
      })

      // Sanity: exactly one decision card, not a spammy loop.
      const askCalls = mcpToolCalls(events).filter((c) => c.tool === 'ask_user')
      expect(askCalls.length).toBeGreaterThanOrEqual(1)
    },
    300_000,
  )
})
