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
 * Use it for the `catimation-brainstorm` flow and any time a real decision is
 * the user's to make (景别 / 风格 / 运镜 / 方向…). The returned JSON carries the
 * chosen option ids AND labels plus any free text, so the agent can act on the
 * answer without re-asking.
 */
export function registerAskTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the user a question with clickable options, rendered as an ' +
        'interactive card in the chat. BLOCKS until the user picks an option, ' +
        'types free text, or skips. Use for brainstorming / co-directing and ' +
        'whenever a decision is genuinely the user\'s to make. Returns the ' +
        'chosen option ids + labels and any free text. Prefer ONE focused ' +
        'question at a time over a long survey.',
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
