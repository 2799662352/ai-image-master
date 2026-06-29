import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

/**
 * Canonical model-/renderer-facing name. The renderer (AgentToolExecutor) only
 * knows this name — every alias below routes here so a mis-spelled MCP call
 * still drives the one true option card.
 */
const ASK_USER_CANONICAL = 'ask_user'

/**
 * HARDCODED name aliases for the option-card tool — the robust fix for the
 * recurring `unsupported call: catimationaskuser` failure.
 *
 * Why config flags alone can't fix it: Codex EXACT-matches the model-emitted
 * tool name against its registry and rejects anything else UPSTREAM as
 * `unsupported call` (that string is codex-side — it never reaches our process,
 * so a bridge/server-side normalizer can't catch it). For a RARELY-typed tool
 * the model reconstructs the name from skill-doc memory and mangles it; today's
 * real-run logs show `catimationaskuser` (server namespace glued on + the
 * underscore dropped) and `askuser`. Three shipped codex-config attempts
 * (`non_prefixed_mcp_tool_names`, the no-op `namespace_tools=false`, and
 * `code_mode.direct_only_tool_namespaces`) did NOT stop it.
 *
 * The one layer we fully control is the MCP tool REGISTRY. Registering each
 * likely mis-spelling as a REAL tool puts it in codex's registry, so the call
 * dispatches to us no matter which variant the model picked — every alias
 * delegates to the canonical `ask_user` renderer handler. Dispatch is gated by
 * registry MEMBERSHIP, not visibility, so this works even when the tool is
 * deferred behind tool_search. Frequently-used tools (generate_image,
 * canvas_snapshot) don't need this — the model has their exact name memorized
 * from constant use; `ask_user` does not.
 *
 * Covers: underscore drop (`askuser`), camelCase (`askUser`), and the
 * namespace-glued forms with/without underscores (`catimationaskuser`,
 * `catimation_ask_user`, `catimationask_user`). All are plain
 * `[a-zA-Z0-9_]` names, valid per codex's tool-name validation.
 */
const ASK_USER_ALIASES = [
  'askuser',
  'askUser',
  'catimationaskuser',
  'catimation_ask_user',
  'catimationask_user',
] as const

/** Shared input schema — identical across the canonical tool and every alias. */
const askUserInputSchema = z.object({
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
})

/**
 * `ask_user` — pause and ask the user a multiple-choice (or free-text)
 * question, rendered as a clickable card in the CATIMATION chat. The tool
 * BLOCKS until the user answers (or skips), then returns their choice to the
 * agent. There is no main-process handler, so `router.call('ask_user', …)`
 * routes to the renderer (AgentToolExecutor) exactly like `generate_image`.
 *
 * This is a GENERAL, always-available system interaction tool — same tier as
 * `generate_image` / `view_image`, NOT scoped to `catimation-brainstorm`. The
 * canonical tool's description is in the model's context every turn, so it is
 * the always-on lever that makes the agent reach for a clickable card WHENEVER
 * it would otherwise hand the user a numbered text list.
 */
export function registerAskTools(server: McpServer, router: ToolRouter): void {
  // Every variant — canonical and aliases — runs the SAME handler, which always
  // delegates to the canonical renderer tool name so the renderer's switch
  // (`case 'ask_user'`) renders the card regardless of which name was called.
  const handler = async (
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
    const answer = await router.call(ASK_USER_CANONICAL, params)
    return { content: [{ type: 'text', text: JSON.stringify(answer) }] }
  }

  // Canonical tool FIRST — carries the full, model-facing description so the
  // agent prefers it; aliases are terse so they never out-compete it.
  server.registerTool(
    ASK_USER_CANONICAL,
    {
      description:
        'Interactive clickable choice card in CATIMATION chat. ALWAYS available like ' +
        'generate_image/view_image — NOT brainstorm-only. Use WHENEVER you\'d list 2+ ' +
        'options/方案/方向 or face a user decision (景别/风格/运镜/模型/下一步); prefer ' +
        'over a numbered text list. One question per card, all options in one (6–8 ok). ' +
        'BLOCKS until pick/type/skip; returns ids+labels+free text. Tool name is exactly ' +
        '"ask_user" (snake_case); common mis-spellings are also accepted.',
      inputSchema: askUserInputSchema,
    },
    handler,
  )

  for (const alias of ASK_USER_ALIASES) {
    server.registerTool(
      alias,
      {
        description: `Tolerant alias of ${ASK_USER_CANONICAL} (mis-spelling safety net). Prefer ${ASK_USER_CANONICAL}.`,
        inputSchema: askUserInputSchema,
      },
      handler,
    )
  }
}
