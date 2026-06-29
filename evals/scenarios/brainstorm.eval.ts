import { describe, expect, it } from 'vitest'
import { hasEvalCreds } from '../harness/env'
import { runCodex } from '../harness/runCodex'
import { assertToolArgs, assertToolNotUsed, assertToolUsed, turnFailed } from '../harness/trajectory'
import { CATIMATION_TOOLS } from './_tools'

/**
 * L1 routing eval for brainstorm-style intent (the behavior the
 * `catimation-brainstorm` skill encodes): when the user is OPEN-ENDED and asks
 * for directions to choose from, the agent should offer a clickable `ask_user`
 * card with multiple options — and must NOT jump straight to rendering an image
 * before any direction is chosen.
 *
 * NOTE: this asserts the brainstorm DECISION at L1. Verifying the actual
 * `catimation-brainstorm` SKILL.md is loaded into context requires pointing
 * CODEX_HOME at an installed skills dir — a planned harness enhancement.
 */
describe.skipIf(!hasEvalCreds())('brainstorm routing (L1 agent loop)', () => {
  it(
    'offers a multi-option ask_user card for an open-ended creative ask, before rendering anything',
    async () => {
      const { events, stderr } = await runCodex({
        prompt: '我想做一条短片，但完全没头绪。先别画图，给我几个不同的创意方向，让我从中挑一个。',
        tools: CATIMATION_TOOLS,
      })

      expect(turnFailed(events), `turn failed; stderr tail:\n${stderr.slice(-1500)}`).toBe(false)

      assertToolUsed(events, 'ask_user')
      assertToolArgs(events, 'ask_user', (args) => {
        const options = (args as { options?: unknown[] }).options
        return Array.isArray(options) && options.length >= 2
      })
      // It was explicitly told NOT to render before a direction is picked.
      assertToolNotUsed(events, 'generate_image')
    },
    300_000,
  )
})
