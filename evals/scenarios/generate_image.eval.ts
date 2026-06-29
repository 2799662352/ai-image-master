import { describe, expect, it } from 'vitest'
import { hasEvalCreds } from '../harness/env'
import { runCodex } from '../harness/runCodex'
import { assertToolArgs, assertToolNotUsed, assertToolUsed, mcpToolCalls, turnFailed } from '../harness/trajectory'
import { CATIMATION_TOOLS } from './_tools'

/**
 * L1 routing eval: a CONCRETE "draw me X" request must route to `generate_image`
 * — not to `ask_user` (no decision to make) and not to `canvas_snapshot`. This
 * guards against the agent confabulating its own built-in image tool or
 * second-guessing a clear render request.
 */
describe.skipIf(!hasEvalCreds())('generate_image routing (L1 agent loop)', () => {
  it(
    'renders directly for a concrete draw request, without asking the user first',
    async () => {
      const { events, stderr } = await runCodex({
        prompt: '帮我画一张赛博朋克风格的猫，霓虹灯背景，2K，竖构图。直接生成就行。',
        tools: CATIMATION_TOOLS,
      })

      expect(turnFailed(events), `turn failed; stderr tail:\n${stderr.slice(-1500)}`).toBe(false)

      assertToolUsed(events, 'generate_image')
      // A concrete render request shouldn't pop a decision card.
      assertToolNotUsed(events, 'ask_user')
      // The prompt arg should carry a non-trivial description.
      assertToolArgs(events, 'generate_image', (args) => {
        const prompt = (args as { prompt?: unknown }).prompt
        return typeof prompt === 'string' && prompt.trim().length >= 4
      })

      expect(mcpToolCalls(events).filter((c) => c.tool === 'generate_image').length).toBeGreaterThanOrEqual(1)
    },
    300_000,
  )
})
