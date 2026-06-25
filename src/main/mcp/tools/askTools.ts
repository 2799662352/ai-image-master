import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

/**
 * `ask_user` — pause and ask the user a multiple-choice (or free-text)
 * question, rendered as a clickable card in the CATIMATION chat. The tool
 * BLOCKS until the user answers (or skips), then returns their choice to the
 * agent. There is no main-process handler for this tool, so `router.call`
 * routes it to the renderer (AgentToolExecutor) exactly like `generate_image`.
 *
 * This is a GENERAL, always-available system interaction tool — same tier as
 * `generate_image` / `view_image`, NOT scoped to `catimation-brainstorm`. The
 * tool description below is in the model's context every turn (independent of
 * which skill is loaded), so it is the always-on lever that makes the agent
 * reach for a clickable card WHENEVER it would otherwise hand the user a
 * numbered text list — any options/方案/选项/方向, or any decision that is the
 * user's to make (景别 / 风格 / 运镜 / 模型 / 下一步…). The returned JSON carries
 * the chosen option ids AND labels plus any free text, so the agent can act on
 * the answer without re-asking.
 */
export function registerAskTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'ask_user',
    {
      description:
        'Interactive clickable choice card in CATIMATION chat. ALWAYS available like ' +
        'generate_image/view_image — NOT brainstorm-only. Use WHENEVER you\'d list 2+ ' +
        'options/方案/方向 or face a user decision (景别/风格/运镜/模型/下一步); prefer ' +
        'over a numbered text list. One question per card, all options in one (6–8 ok). ' +
        'BLOCKS until pick/type/skip; returns ids+labels+free text. Exact name ' +
        '"ask_user" (underscore); on "unsupported call" do NOT retry variants — fall ' +
        'back to a numbered text list.',
      inputSchema: z.object({
        question: z.string().min(1),
        options: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string().min(1),
              description: z.string().optional(),
            }),
          )
          .default([]),
        mode: z.enum(['single', 'multi']).default('single'),
        allowFreeText: z.boolean().default(true),
        allowSkip: z.boolean().default(true),
      }),
    },
    async (params) => {
      const answer = await router.call('ask_user', params)
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
    },
  )
}
