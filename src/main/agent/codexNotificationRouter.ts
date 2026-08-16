import type {
  AgentStreamEvent,
  AgentTokenUsage,
  AgentTokenUsageDelta,
  CodexReconcileTextElement,
  CodexUserMessageReconcile,
} from '../../types/agent'
import type { ThreadGoal } from '../../types/codexGoals'
import { MIN_SNAPSHOT_PREFIX_LEN } from '../../types/agent-timeline'
import type { DelegatedAgent, DelegationSnapshot } from '../../types/agent-timeline'
import { countDiffLines, parseChange } from '../../shared/diffUtils'

/**
 * Loose shape for the `item` payload Codex sends inside `item/started` and
 * `item/completed`. We intentionally type each field as optional `unknown` so
 * the router can defensively read from gateways (apiyi etc.) that drop or
 * rename fields without crashing the renderer.
 */
type CodexItem = {
  type?: string
  id?: string
  command?: string
  cwd?: string
  exitCode?: number
  changes?: unknown[]
  text?: string
  summary?: unknown[]
  content?: unknown[]
  status?: string
  serverName?: string
  toolName?: string
  name?: string
  arguments?: unknown
  query?: string
  path?: string
  error?: string
  [k: string]: unknown
}

/**
 * Extract the canonical rollout view from a completed `userMessage` item
 * (`{id, clientId, content}`, app-server v2). Defensive on purpose: gateways
 * drift between camelCase and snake_case for both the content-entry type tags
 * (`localImage` vs `local_image`) and the element field names (`text_elements`
 * vs `textElements`, `byteRange` vs `byte_range`), so probe both spellings and
 * silently drop anything malformed — reconcile data is an enhancement, never
 * worth crashing the stream over.
 */
function parseUserMessageReconcile(item: CodexItem, turnIdRaw: unknown): CodexUserMessageReconcile {
  const clientIdRaw = item.clientId ?? item.client_id
  const clientId = typeof clientIdRaw === 'string' && clientIdRaw.length > 0 ? clientIdRaw : undefined
  // Turn scope of the echo — persisted so edit-and-resend can later resolve
  // "fork through the PREVIOUS turn" (`thread/fork.lastTurnId`). Spread-omit:
  // an absent turn (old binary / gateway strip) must not write `turnId: undefined`.
  const turnId = typeof turnIdRaw === 'string' && turnIdRaw.length > 0 ? turnIdRaw : undefined

  const localImages: string[] = []
  const textElements: CodexReconcileTextElement[] = []
  const content = Array.isArray(item.content) ? item.content : []
  for (const entry of content) {
    if (!entry || typeof entry !== 'object') continue
    const rec = entry as Record<string, unknown>
    if (rec.type === 'localImage' || rec.type === 'local_image') {
      if (typeof rec.path === 'string' && rec.path.length > 0) localImages.push(rec.path)
      continue
    }
    if (rec.type !== 'text') continue
    const rawElements = rec.text_elements ?? rec.textElements
    if (!Array.isArray(rawElements)) continue
    for (const el of rawElements) {
      if (!el || typeof el !== 'object') continue
      const elRec = el as Record<string, unknown>
      const range = (elRec.byteRange ?? elRec.byte_range) as Record<string, unknown> | undefined
      if (!range || typeof range !== 'object') continue
      if (typeof range.start !== 'number' || typeof range.end !== 'number') continue
      textElements.push({
        byteRange: { start: range.start, end: range.end },
        placeholder: typeof elRec.placeholder === 'string' ? elRec.placeholder : null,
      })
    }
  }
  return {
    codexItemId: String(item.id),
    ...(clientId ? { clientId } : {}),
    ...(turnId ? { turnId } : {}),
    localImages,
    textElements,
  }
}

/**
 * Build the `{ label, detail }` pair shown on the generic `ActivityItem`
 * card for any Codex `item.type` we don't have a bespoke renderer for. The
 * goal is not pretty formatting; the goal is "the user sees evidence that
 * a tool/MCP/web-search/file-read actually ran instead of an empty bubble".
 */
function summarizeActivity(item: CodexItem): { label?: string; detail?: string } {
  const truncate = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
  const argsDetail = (val: unknown): string | undefined => {
    if (typeof val === 'string') return truncate(val)
    if (val && typeof val === 'object') {
      try {
        return truncate(JSON.stringify(val))
      } catch {
        return undefined
      }
    }
    return undefined
  }

  switch (item.type) {
    case 'mcpToolCall': {
      const server = typeof item.serverName === 'string' ? item.serverName : null
      const tool =
        typeof item.toolName === 'string'
          ? item.toolName
          : typeof item.name === 'string'
            ? item.name
            : null
      const label = server && tool ? `mcp:${server}/${tool}` : tool ?? 'mcp tool'
      return { label, detail: argsDetail(item.arguments) }
    }
    case 'webSearch':
      return {
        label: 'web search',
        detail: typeof item.query === 'string' ? truncate(item.query) : undefined,
      }
    case 'collabAgentToolCall': {
      // Name the ACTION, not the item type: the wire `tool` is camelCase
      // (`spawnAgent`, `followupTask`), which reads badly in a chip.
      const tool = typeof item.tool === 'string' ? item.tool : 'agent'
      const label = tool
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
      const targets = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.length : 0
      const detail = typeof item.prompt === 'string' && item.prompt.length > 0
        ? truncate(item.prompt)
        : targets > 0
          ? `${targets} agent${targets > 1 ? 's' : ''}`
          : undefined
      return { label, ...(detail != null ? { detail } : {}) }
    }
    case 'dynamicToolCall':
    case 'collabToolCall': {
      // Codex 0.130.0 v2 schema (codex-rs/app-server-protocol/src/protocol/v2.rs):
      //   `ThreadItem::DynamicToolCall { id, namespace, tool: String, arguments, ... }`
      // The canonical wire field is `tool` (single-word, no rename_all
      // transformation). Older builds / some gateways still send
      // `toolName`, and MCP-shaped payloads use `name`. Probe all three in
      // canonical-first order so the generic chip surfaces the actual
      // tool name instead of the `'tool'` literal fallback.
      const tool =
        typeof item.tool === 'string'
          ? item.tool
          : typeof item.toolName === 'string'
            ? item.toolName
            : typeof item.name === 'string'
              ? item.name
              : 'tool'
      return { label: tool, detail: argsDetail(item.arguments) }
    }
    case 'imageView':
      return {
        label: 'view image',
        detail: typeof item.path === 'string' ? truncate(item.path) : undefined,
      }
    case 'plan':
      return { label: 'plan' }
    case 'enteredReviewMode':
      return { label: 'review mode: enter' }
    case 'exitedReviewMode':
      return { label: 'review mode: exit' }
    case 'contextCompaction':
      return { label: '压缩上下文', detail: '总结并丢弃旧历史,释放上下文窗口' }
    default:
      return { label: item.type }
  }
}

/**
 * Mirrors the plan / todo payloads Codex 0.130.0 actually emits on the
 * wire — **with the critical detail that the two channels use different
 * serde casing conventions**:
 *
 *   1. `turn/plan/updated` notification → `TurnPlanStepStatus` in
 *      `codex-rs/app-server-protocol/src/protocol/v2.rs` is declared with
 *      `#[serde(rename_all = "camelCase")]`, so the wire value is
 *      `"inProgress"` (camelCase).
 *
 *   2. `dynamicToolCall.arguments.plan[].status` → `StepStatus` in
 *      `codex-rs/protocol/src/plan_tool.rs` is declared with
 *      `#[serde(rename_all = "snake_case")]`, so the wire value is
 *      `"in_progress"` (snake_case).
 *
 * Both channels reach us with arbitrary case from gateway rewrites in the
 * wild too. We normalise to snake_case internally so every renderer-side
 * consumer (PlanCard, tests, etc.) stays on a single contract. Also
 * tolerates the legacy `text` spelling for the step body that some
 * experimental gateways use.
 *
 * Codex invariant: at most one step is `in_progress` at any time.
 */
function extractPlanSteps(
  rawPlan: unknown,
): { text: string; status: 'pending' | 'in_progress' | 'completed' }[] | undefined {
  const raw = Array.isArray(rawPlan) ? rawPlan : null
  if (!raw) return undefined
  const out: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const text =
      typeof o.step === 'string' ? o.step : typeof o.text === 'string' ? o.text : null
    if (!text) continue
    out.push({ text, status: normalisePlanStepStatus(o.status) })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Accept every variant of plan-step status Codex has shipped on the wire:
 *   - snake_case `"in_progress"` (tool arguments, plan_tool.rs)
 *   - camelCase `"inProgress"` (v2 app-server notification, v2.rs)
 *   - kebab-case `"in-progress"` (some gateways normalise this way)
 *   - PascalCase `"InProgress"` (Rust enum variant name if a gateway
 *     forwards it without serde processing)
 *   - any case-insensitive permutation of the above
 * Anything unrecognised falls back to `pending` so the step is still
 * displayed (we'd rather show a known step as pending than swallow it).
 */
function normalisePlanStepStatus(
  raw: unknown,
): 'pending' | 'in_progress' | 'completed' {
  if (typeof raw !== 'string') return 'pending'
  // Strip case + separators so `inProgress`, `in_progress`, `in-progress`,
  // `InProgress`, `IN PROGRESS` all collapse to `inprogress`.
  const key = raw.toLowerCase().replace(/[\s_-]/g, '')
  if (key === 'completed' || key === 'done' || key === 'complete') return 'completed'
  if (key === 'inprogress' || key === 'running' || key === 'active') return 'in_progress'
  return 'pending'
}

/**
 * Resolve a tool name across the wire shapes Codex / gateways have used.
 * Order matters — probe **canonical-first**:
 *   1. `tool` — v2 ThreadItem schema (Codex 0.130.0,
 *      codex-rs/app-server-protocol/src/protocol/v2.rs `DynamicToolCall.tool`)
 *   2. `toolName` — older Codex builds and several Chinese gateways that
 *      rename for "legacy client" compatibility
 *   3. `name` — MCP-shaped payloads (some MCP servers forward tool calls
 *      with `name` instead of `tool`)
 * We probe all three so the plan routing doesn't accidentally fall
 * through to the generic dynamicToolCall chip just because of a casing /
 * naming drift on a custom gateway.
 */
function readToolName(item: CodexItem): string | undefined {
  const candidates: Array<unknown> = [
    (item as Record<string, unknown>).tool,
    (item as Record<string, unknown>).toolName,
    (item as Record<string, unknown>).name,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c
  }
  return undefined
}

/**
 * Recognises the Codex plan/todo tool by name across all known aliases:
 *   - `update_plan` (legacy primary name from `plan_tool.rs::PlanHandler`)
 *   - `todo_write` (current primary after PR openai/codex#10124)
 *   - `plan` (short alias observed on the wire from Codex 0.130.0 +
 *     some upstream gateways)
 * Case-insensitive: gateways sometimes upper-case tool names.
 */
function isPlanToolName(name: string | undefined): boolean {
  if (!name) return false
  const lc = name.toLowerCase()
  return lc === 'plan' || lc === 'update_plan' || lc === 'todo_write'
}

/**
 * Codex sometimes sends tool `arguments` as a JSON string (Responses-API
 * function-call shape) and sometimes as a parsed object (v2 protocol /
 * dynamic tool dispatch). Try both before giving up so the plan extractor
 * can find `arguments.plan`.
 */
function parseToolArguments(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  if (typeof value === 'string' && value.length > 0) {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Build the `mergeFields` payload for the synthetic plan ActivityItem. Used
 * by all three plan code paths (`turn/plan/updated`, plan-tool-call started,
 * plan-tool-call completed) so the PlanCard render shape stays identical
 * regardless of which channel Codex actually used.
 */
function buildPlanMergeFields(
  steps: { text: string; status: 'pending' | 'in_progress' | 'completed' }[],
  explanation: string | undefined,
  forceSuccess: boolean,
): Record<string, unknown> {
  // Empty-steps placeholder: the plan tool fired but we don't have any
  // extractable steps yet (or ever — depends on gateway). Keep status
  // `running` so the PlanCard pulses; never claim "success" without
  // evidence of completion.
  const allCompleted = steps.length > 0 && steps.every((s) => s.status === 'completed')
  return {
    kind: 'plan',
    label: 'plan',
    steps,
    status: forceSuccess && allCompleted ? 'success' : allCompleted ? 'success' : 'running',
    ...(explanation != null ? { detail: explanation } : {}),
  }
}

/**
 * When Codex routes `update_plan` / `todo_write` as a `dynamicToolCall` (or
 * `collabToolCall`) instead of emitting a dedicated `turn/plan/updated`
 * notification, the structured plan rides inside `item.arguments.plan`.
 * Detect that case and route it through the same synthetic-itemId
 * (`plan:${turnId}`) channel as `turn/plan/updated` — same store-side upsert
 * path, same PlanCard render. Returning `null` from here means "not a plan
 * tool call, let the generic dynamicToolCall chip handle it instead."
 */
/**
 * Diagnostic logger for plan-tool routing. Fires only when a plan-like tool
 * call comes in (so it doesn't spam the console), but logs enough context
 * for "PlanCard didn't render" investigations:
 *   - success: tool name + step count + statuses
 *   - failure: tool name + raw arguments shape (truncated) so we can see
 *     whether Codex actually shipped structured data
 *
 * Kept as console.log/warn so it shows up in the `npm run dev` terminal
 * AND in production main-process stdout (which electron's --enable-logging
 * or our agent log stream can capture). Truncates args to 800 chars to
 * avoid leaking massive payloads if the model dumped a huge plan.
 */
function logPlanToolDiagnostic(
  phase: 'started' | 'completed',
  toolName: string | undefined,
  status: 'routed' | 'no-args' | 'no-steps',
  details: Record<string, unknown>,
): void {
  const prefix = `[plan-tool/${phase}]`
  if (status === 'routed') {
    console.log(prefix, 'routed', { tool: toolName, ...details })
  } else {
    console.warn(prefix, status, { tool: toolName, ...details })
  }
}

function safeStringify(value: unknown, max = 800): string {
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value)
    return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s
  } catch {
    return '[unstringifiable]'
  }
}

/**
 * Last-resort plan extractor for when a gateway / model sends the plan as
 * markdown prose instead of a structured `plan: [...]` array. We see this
 * a lot in the wild — many Chinese gateways front of OpenAI-compatible
 * APIs do not forward the function-call argument schema strictly, and
 * smaller / older models often "describe" the plan as numbered text in
 * `args.explanation` or the raw `arguments` string itself.
 *
 * Heuristics (intentionally conservative to avoid surfacing chips that
 * aren't actually plans):
 *   - Recognise bullets / ordered list markers:
 *     `1.` `1)` `1、`  `- `  `* `  `• `  `· `  `①` … `⑩`
 *   - Require **at least 2 list lines** before claiming we found a plan
 *     (single bullets are usually titles, not plan items).
 *   - Strip leading status markers the model might already have written:
 *     `✓` `[x]` `[ ]` `(done)` `(in progress)`
 *   - Look for an "in progress" hint in the **surrounding** text and
 *     mark that step accordingly:
 *       "第 2 项是进行中"   "currently on step 2"   "now: step 2"
 *   - Look for "已完成" / "completed: 1, 2" style hints likewise.
 */
function extractStepsFromFreeformString(
  text: string,
): { text: string; status: 'pending' | 'in_progress' | 'completed' }[] | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8000) return undefined
  // Bullet / ordered list marker. We capture the body after the marker so
  // we can also detect inline status hints prefixed to the body.
  const listMarker = /^\s*(?:(?:\d+|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])[.)、]\s*|[-*•·]\s+)(.+)$/
  const steps: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const m = rawLine.match(listMarker)
    if (!m) continue
    let body = m[1].trim()
    if (body.length === 0 || body.length > 240) continue
    // Strip a leading checkbox / status prefix and capture intent.
    let inlineStatus: 'pending' | 'in_progress' | 'completed' | null = null
    const checkbox = body.match(/^\[\s*([x✓vV]|\s|-)\s*\]\s*(.*)$/)
    if (checkbox) {
      const mark = checkbox[1]
      inlineStatus = mark.trim() === '' ? 'pending' : mark === '-' ? 'in_progress' : 'completed'
      body = checkbox[2].trim()
    } else {
      const prefix = body.match(
        /^(?:✓|✔|☑|☒|☐|→|▶|►|\(\s*done\s*\)|\(\s*completed\s*\)|\(\s*in[ _-]?progress\s*\)|\(\s*pending\s*\)|\(\s*todo\s*\))\s+(.*)$/i,
      )
      if (prefix) {
        const head = body.slice(0, body.length - prefix[1].length).toLowerCase()
        if (/[✓✔☑]|done|completed/.test(head)) inlineStatus = 'completed'
        else if (/[→▶►]|in[ _-]?progress/.test(head)) inlineStatus = 'in_progress'
        else if (/[☐]|todo|pending/.test(head)) inlineStatus = 'pending'
        body = prefix[1].trim()
      }
    }
    if (body.length === 0) continue
    steps.push({ text: body, status: inlineStatus ?? 'pending' })
  }
  if (steps.length < 2) return undefined

  // Surrounding-text status hints. Only apply when individual lines didn't
  // already carry an explicit status marker — explicit beats inferred.
  const hasExplicit = steps.some((s) => s.status !== 'pending')
  if (!hasExplicit) {
    const inProgressMatch =
      text.match(/第\s*(\d+)\s*[项步条][^。]*(?:进行中|在做|正在|in[ _-]?progress|active|current)/i) ||
      text.match(/(?:current|currently|now|目前|当前)[^。\n]{0,30}?(?:step|第)\s*(\d+)/i)
    if (inProgressMatch) {
      const idx = parseInt(inProgressMatch[1], 10) - 1
      if (idx >= 0 && idx < steps.length) steps[idx].status = 'in_progress'
    }
    // "已完成第 1 / 2 项" / "completed: 1, 2"
    const completedRange = text.match(
      /(?:已完成|completed|done)[^\n]{0,40}?(?:第\s*)?([\d\s,，、和与and]+)/i,
    )
    if (completedRange) {
      const nums = completedRange[1].match(/\d+/g)
      if (nums) {
        for (const n of nums) {
          const idx = parseInt(n, 10) - 1
          if (idx >= 0 && idx < steps.length && steps[idx].status === 'pending') {
            steps[idx].status = 'completed'
          }
        }
      }
    }
  }
  return steps
}

/**
 * The heart of "PlanCard always renders when plan tool fires." We try
 * extraction in priority order:
 *
 *   1. Structured arrays: `args.plan` / `args.todo` (PR #10124) /
 *      `args.todos` (legacy plural) / `args.steps` / `args.items` /
 *      `args` itself if it's an array
 *   2. Freeform-string fallback on `args.explanation` / `args.text` /
 *      `args.content` — for gateways that pack the plan into a single
 *      string field
 *   3. Freeform-string fallback on the raw `item.arguments` string —
 *      for gateways that pass the entire plan as a non-JSON string
 *
 * If nothing extractable is found we still emit a placeholder PlanCard
 * with `steps: []` and `explanation` as label — the renderer shows a
 * "creating plan..." state. This is far better UX than the generic
 * "TOOL plan running" chip because the user gets a stable, recognisable
 * card slot in the timeline that fills in once the data arrives.
 */
function extractStepsFromAnywhere(
  args: Record<string, unknown> | undefined,
  rawArguments: unknown,
): { text: string; status: 'pending' | 'in_progress' | 'completed' }[] | undefined {
  if (args) {
    const structured =
      extractPlanSteps(args.plan) ??
      extractPlanSteps(args.todo) ??
      extractPlanSteps(args.todos) ??
      extractPlanSteps(args.steps) ??
      extractPlanSteps(args.items) ??
      extractPlanSteps(args)
    if (structured) return structured
    for (const field of ['explanation', 'text', 'content', 'plan', 'todo'] as const) {
      const v = args[field]
      if (typeof v === 'string') {
        const fromProse = extractStepsFromFreeformString(v)
        if (fromProse) return fromProse
      }
    }
  }
  if (typeof rawArguments === 'string') {
    const fromProse = extractStepsFromFreeformString(rawArguments)
    if (fromProse) return fromProse
  }
  return undefined
}

function maybeRoutePlanToolCall(
  item: CodexItem,
  threadId: unknown,
  turnId: unknown,
  forceSuccess: boolean,
): AgentStreamEvent | null {
  if (item.type !== 'dynamicToolCall' && item.type !== 'collabToolCall') return null
  const toolName = readToolName(item)
  if (!isPlanToolName(toolName)) return null
  if (typeof threadId !== 'string' || threadId.length === 0) return null
  if (typeof turnId !== 'string' || turnId.length === 0) return null
  const phase = forceSuccess ? 'completed' : 'started'
  const args = parseToolArguments(item.arguments)
  const steps = extractStepsFromAnywhere(args, item.arguments) ?? []
  const explanation =
    args && typeof args.explanation === 'string' && args.explanation.length > 0
      ? args.explanation
      : typeof item.arguments === 'string' && steps.length === 0
        ? item.arguments
        : undefined

  if (steps.length === 0) {
    // Plan tool fired but we couldn't find any structured / list-like
    // shape. Log the payload silhouette so the user can diff it against
    // expected shapes from the Codex source. We *still* emit a plan
    // event so the renderer shows a "creating plan" placeholder card
    // instead of a generic chip — same slot reservation pattern
    // Cursor / Codex CLI use.
    logPlanToolDiagnostic(phase, toolName, args ? 'no-steps' : 'no-args', {
      rawArgumentsType: typeof item.arguments,
      argKeys: args ? Object.keys(args) : null,
      argShapePreview: safeStringify(args ?? item.arguments),
    })
  } else {
    logPlanToolDiagnostic(phase, toolName, 'routed', {
      stepCount: steps.length,
      statuses: steps.map((s) => s.status),
    })
  }

  return {
    type: 'item_delta',
    threadId,
    turnId,
    itemId: `plan:${turnId}`,
    itemType: 'activity',
    patch: {
      kind: 'mergeFields',
      fields: buildPlanMergeFields(steps, explanation, forceSuccess),
    },
  }
}

/**
 * Reads the delegation record off a `collabAgentToolCall` item.
 *
 * Returns `undefined` for every other item type, which is what keeps the
 * generic activity path unchanged for ordinary tool calls.
 *
 * Blank scalars are dropped rather than forwarded: upstream sends `model: ""`
 * while a spawn is in flight and fills in the real slug only on completion, so
 * passing the empty string through would render an empty model chip.
 */
function parseDelegation(item: CodexItem): DelegationSnapshot | undefined {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined

  // Multi-agent V2 announces a spawn through its own item type and leaves the
  // tool call's `receiverThreadIds`/`agentsStates` empty — measured with
  // `scripts/smoke-subagents.ts --v2`. Reading only the V1 shape would show an
  // empty card on V2, so both feed the same snapshot.
  if (item.type === 'subAgentActivity') {
    const threadId = text(item.agentThreadId)
    if (!threadId) return undefined
    const name = text(item.agentPath)
    return {
      tool: text(item.kind) ?? 'started',
      agents: [{ threadId, ...(name ? { name } : {}) }],
    }
  }

  if (item.type !== 'collabAgentToolCall') return undefined

  const states = item.agentsStates
  const agents: DelegatedAgent[] = []
  if (states && typeof states === 'object' && !Array.isArray(states)) {
    for (const [threadId, raw] of Object.entries(states as Record<string, unknown>)) {
      const state = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      agents.push({
        threadId,
        ...(text(state.status) ? { status: text(state.status) } : {}),
        ...(text(state.message) ? { message: text(state.message) } : {}),
      })
    }
  }
  // `receiverThreadIds` names the children even before any state exists, so a
  // spawn that has not reported back still lists who it is waiting on.
  if (Array.isArray(item.receiverThreadIds)) {
    for (const id of item.receiverThreadIds) {
      if (typeof id === 'string' && !agents.some((agent) => agent.threadId === id)) {
        agents.push({ threadId: id })
      }
    }
  }

  return {
    tool: text(item.tool) ?? 'agent',
    ...(text(item.prompt) ? { prompt: text(item.prompt) } : {}),
    ...(text(item.model) ? { model: text(item.model) } : {}),
    ...(text(item.reasoningEffort) ? { reasoningEffort: text(item.reasoningEffort) } : {}),
    agents,
  }
}

function statusFromItem(item: CodexItem): 'running' | 'success' | 'error' | 'cancelled' | undefined {
  const s = typeof item.status === 'string' ? item.status.toLowerCase() : null
  if (!s) return undefined
  if (s.includes('error') || s.includes('fail')) return 'error'
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('success') || s === 'completed' || s === 'done') return 'success'
  // `inprogress` is what upstream's camelCase `inProgress` lowercases to — the
  // wire value of `CollabAgentToolCallStatus::InProgress`. Missing it made an
  // `item/completed` that is still in progress fall through to this function's
  // caller, which defaults a completion to success.
  if (s === 'running' || s === 'in_progress' || s === 'inprogress' || s === 'pending') {
    return 'running'
  }
  return undefined
}

/**
 * Walk a reasoning item's `content[]` and `summary[]` arrays (per the Codex
 * protocol shape) and concatenate any plain text we find. Used as a fallback
 * for gateways that strip live reasoning deltas — without this, the "Thought"
 * card stays empty even when the final payload has the full chain-of-thought.
 */
function extractReasoningText(item: CodexItem): string {
  const parts: string[] = []
  for (const arr of [item.content, item.summary]) {
    if (!Array.isArray(arr)) continue
    for (const block of arr) {
      if (typeof block === 'string') {
        parts.push(block)
        continue
      }
      if (!block || typeof block !== 'object') continue
      const o = block as Record<string, unknown>
      if (typeof o.text === 'string') {
        parts.push(o.text)
        continue
      }
      if (typeof o.content === 'string') {
        parts.push(o.content)
        continue
      }
      if (Array.isArray(o.parts)) {
        for (const p of o.parts) {
          if (typeof p === 'string') parts.push(p)
          else if (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string') {
            parts.push((p as { text: string }).text)
          }
        }
      }
    }
  }
  return parts.join('\n').trim()
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function parseThreadSettingsUpdated(
  params: Record<string, unknown>,
): Extract<AgentStreamEvent, { type: 'thread_settings_updated' }> | null {
  const threadId = params.threadId
  if (typeof threadId !== 'string' || threadId.trim().length === 0) return null

  const rawThreadSettings = params.threadSettings
  if (!rawThreadSettings || typeof rawThreadSettings !== 'object' || Array.isArray(rawThreadSettings)) {
    return null
  }
  const threadSettings = rawThreadSettings as Record<string, unknown>

  const rawCollaborationMode = threadSettings.collaborationMode
  if (!rawCollaborationMode || typeof rawCollaborationMode !== 'object' || Array.isArray(rawCollaborationMode)) {
    return null
  }
  const collaborationMode = rawCollaborationMode as Record<string, unknown>
  const mode = collaborationMode.mode
  if (mode !== 'default' && mode !== 'plan') return null

  const model = threadSettings.model
  if (typeof model !== 'string' || model.trim().length === 0) return null

  return {
    type: 'thread_settings_updated',
    threadId,
    mode,
    model,
    effort: typeof threadSettings.effort === 'string' ? threadSettings.effort : null,
  }
}

function lacksStringUnifiedDiff(change: unknown): boolean {
  if (!change || typeof change !== 'object') return false
  const unifiedDiff = (change as { unifiedDiff?: unknown }).unifiedDiff
  return typeof unifiedDiff !== 'string'
}

function itemStateKey(threadId: unknown, itemId: unknown): string | null {
  return typeof threadId === 'string' && threadId.length > 0
    && typeof itemId === 'string' && itemId.length > 0
    ? `${threadId}\u0000${itemId}`
    : null
}

/**
 * Coerce the various shapes Codex / OpenAI Responses API gateways use for
 * token-usage payloads into our normalized `AgentTokenUsage` shape. Returns
 * `null` when the payload doesn't carry any usable counter — we'd rather
 * keep the previous reading than overwrite it with zeros.
 *
 * Codex 0.128 emits a NESTED shape:
 *   { tokenUsage: { total: {inputTokens, outputTokens, reasoningOutputTokens,
 *                           cachedInputTokens, totalTokens},
 *                   last:  { ...same fields, current turn only } } }
 * We prefer `total` (cumulative, which is what the donut visualizes) and
 * fall back to `last`. We also keep the legacy flat `usage: {...}` path
 * because that's what older gateways and our own tests use.
 */
function extractTokenUsage(params: Record<string, unknown>): AgentTokenUsage | null {
  const counter = pickUsageCounter(params)
  if (!counter) return null

  const usage: AgentTokenUsage = {
    inputTokens: counter.inputTokens ?? 0,
    outputTokens: counter.outputTokens ?? 0,
  }
  if (counter.reasoningTokens != null) usage.reasoningTokens = counter.reasoningTokens
  if (counter.cachedInputTokens != null) usage.cachedInputTokens = counter.cachedInputTokens
  const contextWindow = readContextField(params, 'contextWindow', 'context_window')
  if (contextWindow != null) usage.contextWindow = contextWindow
  const contextUsage = readContextField(params, 'contextUsage', 'context_usage')
  if (contextUsage != null) usage.contextUsage = contextUsage

  const last = extractLastDelta(params)
  if (last) usage.last = last

  // Context-window occupancy = the LAST request's absolute tokens (codex
  // `last_token_usage`, whose input = the full current prompt), NOT the
  // cumulative `total`. codex-core's `total_token_usage` SUMS every request's
  // prompt across the whole thread, so it grows unbounded and, divided by the
  // context window, makes the meter falsely pin at 100% on any long thread —
  // which also masks when real usage nears the 90% auto-compact trigger. Mirror
  // codex's own TUI, which derives "context left" from last_token_usage. Only
  // synthesize when the gateway didn't already send an explicit contextUsage.
  if (usage.contextUsage == null && last) {
    usage.contextUsage = last.inputTokens + last.outputTokens
  }
  return usage
}

/**
 * Read `tokenUsage.last` (per-turn delta). Returns `undefined` when the slice
 * is missing OR when both input/output are zero — we'd rather hide the
 * "Last turn" popover line than show "+0 / +0" noise.
 */
function extractLastDelta(params: Record<string, unknown>): AgentTokenUsageDelta | undefined {
  const tu = params.tokenUsage as Record<string, unknown> | undefined
  const counter = readTokenCounter(tu?.last)
  if (!counter) return undefined
  const inputTokens = counter.inputTokens ?? 0
  const outputTokens = counter.outputTokens ?? 0
  if (inputTokens === 0 && outputTokens === 0) return undefined

  const delta: AgentTokenUsageDelta = { inputTokens, outputTokens }
  if (counter.reasoningTokens != null) delta.reasoningTokens = counter.reasoningTokens
  if (counter.cachedInputTokens != null) delta.cachedInputTokens = counter.cachedInputTokens
  return delta
}

/** One candidate object's token fields, already de-aliased. */
interface TokenCounter {
  inputTokens: number | undefined
  outputTokens: number | undefined
  reasoningTokens: number | undefined
  cachedInputTokens: number | undefined
}

/**
 * Read one object's token fields across every spelling we've seen in the wild:
 * codex camelCase, codex 0.128's `reasoningOutputTokens`, snake_case from
 * apiyi / OpenRouter relays, and Responses-API names (`prompt_tokens`,
 * `cache_read_input_tokens`). Returns `null` when neither input nor output is
 * present — which is also how `pickUsageCounter` decides a candidate object
 * isn't the counter, so "is this the counter" and "read the counter" can't
 * drift apart into two different alias lists.
 */
function readTokenCounter(source: unknown): TokenCounter | null {
  if (!source || typeof source !== 'object') return null
  const u = source as Record<string, unknown>
  const inputTokens =
    readNumber(u.inputTokens) ?? readNumber(u.input_tokens) ?? readNumber(u.prompt_tokens)
  const outputTokens =
    readNumber(u.outputTokens) ?? readNumber(u.output_tokens) ?? readNumber(u.completion_tokens)
  if (inputTokens == null && outputTokens == null) return null
  return {
    inputTokens,
    outputTokens,
    reasoningTokens:
      readNumber(u.reasoningTokens)
      ?? readNumber(u.reasoning_tokens)
      ?? readNumber(u.reasoningOutputTokens) // codex 0.128 spelling
      ?? readNumber(u.reasoning_output_tokens),
    cachedInputTokens:
      readNumber(u.cachedInputTokens)
      ?? readNumber(u.cached_input_tokens)
      ?? readNumber(u.cache_read_input_tokens),
  }
}

/**
 * Context-window fields arrive either on the notification params or nested in
 * `tokenUsage`, and in either casing. Nesting is only ever camelCase in the
 * traces we have, so we don't guess at a nested snake_case spelling.
 */
function readContextField(
  params: Record<string, unknown>,
  camel: string,
  snake: string,
): number | undefined {
  const tu = params.tokenUsage as Record<string, unknown> | undefined
  return readNumber(params[camel]) ?? readNumber(params[snake]) ?? readNumber(tu?.[camel])
}

/**
 * Walk the union of token-usage payload shapes we've seen in the wild and
 * return the first one that actually carries a counter. We try cumulative
 * shapes first because the meter visualizes lifetime-of-thread usage, then
 * per-turn, then a flat fallback.
 */
function pickUsageCounter(params: Record<string, unknown>): TokenCounter | null {
  const tu = params.tokenUsage as Record<string, unknown> | undefined
  const candidates: unknown[] = []
  if (tu) {
    candidates.push(tu.total, tu.last)
    candidates.push(tu) // some gateways flatten total fields onto tokenUsage itself
  }
  candidates.push(params.usage, params)
  for (const candidate of candidates) {
    const counter = readTokenCounter(candidate)
    if (counter) return counter
  }
  return null
}

/**
 * 判断一段文本是不是 unified diff 的开头。只看第一条非空行 —— diff 一定以
 * 文件头或 hunk 头起手,而 apply_patch 的工具返回是自然语言
 * (`Success. Updated the following files:` / `M src/a.ts`),不会撞上。
 */
function looksLikeUnifiedDiff(text: string): boolean {
  // 只取第一条非空行,不要 split 整个字符串:这个函数是按增量调用的,而传进来
  // 的是**累积后的全文** —— split 一次就分配一整个行数组,几百个增量下来就是
  // O(n²) 的主进程开销,而结果只用得上第一行。
  let cursor = 0
  while (cursor < text.length) {
    const newline = text.indexOf('\n', cursor)
    const end = newline === -1 ? text.length : newline
    const line = text.slice(cursor, end)
    if (line.trim().length > 0) {
      return (
        line.startsWith('@@') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('diff --git') ||
        line.startsWith('Index: ')
      )
    }
    if (newline === -1) break
    cursor = newline + 1
  }
  return false
}

export class CodexNotificationRouter {
  private readonly streamedDeltaItemIds = new Set<string>()
  private readonly streamedReasoningItemIds = new Set<string>()
  private readonly fileChangeOutputByItemId = new Map<string, string>()
  /**
   * 已经从某条**快照**通道拿到过完整 changes 的 item —— `item/started` 或
   * `item/fileChange/patchUpdated` 都算。
   *
   * 一旦有快照,裸文本的 outputDelta 就不再往渲染层递:「整体替换 changes」和
   * 「往 changes[0] 追加文本」会互相覆盖让卡片来回跳,更糟的是同一份 diff 会
   * 被拼两遍、+N/−N 直接翻倍。
   */
  private readonly authoritativeChangesItemIds = new Set<string>()
  /** 已经递给渲染层的字节数,按 item 记。见 outputDelta 分支的守卫。 */
  private readonly emittedDiffLenByItemId = new Map<string, number>()
  /**
   * Canonical agentMessage tracking for cumulative-snapshot gateways
   * ("对话重复" source fix). Some Responses-API relays (apiyi, live
   * 2026-06-10) never stream `item/agentMessage/delta`; instead every SSE
   * chunk arrives as a brand-new agentMessage item (fresh `msg_*` id) whose
   * completed `text` is the FULL reply accumulated so far. One real reply
   * produced 130 such items. We track the last text item per thread and,
   * when a new item's full text extends it, rewrite the event onto the
   * canonical id with only the suffix — downstream (store, persistence)
   * then sees ONE growing item, exactly like a compliant delta stream.
   * The store/AgentManager-level dedup helpers remain as a fallback.
   */
  private readonly lastAgentTextByThread = new Map<string, { id: string; content: string }>()

  private clearThreadState(threadId: unknown): void {
    if (typeof threadId !== 'string' || threadId.length === 0) return
    const prefix = `${threadId}\u0000`
    for (const key of this.streamedDeltaItemIds) {
      if (key.startsWith(prefix)) this.streamedDeltaItemIds.delete(key)
    }
    for (const key of this.streamedReasoningItemIds) {
      if (key.startsWith(prefix)) this.streamedReasoningItemIds.delete(key)
    }
    for (const key of this.fileChangeOutputByItemId.keys()) {
      if (key.startsWith(prefix)) this.fileChangeOutputByItemId.delete(key)
    }
    for (const key of this.authoritativeChangesItemIds) {
      if (key.startsWith(prefix)) this.authoritativeChangesItemIds.delete(key)
    }
    for (const key of this.emittedDiffLenByItemId.keys()) {
      if (key.startsWith(prefix)) this.emittedDiffLenByItemId.delete(key)
    }
    this.lastAgentTextByThread.delete(threadId)
  }

  private trackAgentText(threadId: unknown, itemId: string, appended: string): void {
    if (typeof threadId !== 'string' || threadId.length === 0) return
    const tracked = this.lastAgentTextByThread.get(threadId)
    if (tracked && tracked.id === itemId) {
      tracked.content += appended
    } else {
      this.lastAgentTextByThread.set(threadId, { id: itemId, content: appended })
    }
  }

  route(method: string, params: Record<string, any>): AgentStreamEvent | null {
    switch (method) {
      case 'item/started': {
        const item = params.item as CodexItem | undefined
        if (!item?.type || !item?.id) return null
        switch (item.type) {
          case 'userMessage':
            // Codex echoes the user's prompt back as a canonical thread item
            // so it appears in `turn.items[]`. Our store already rendered a
            // local user bubble inside `store.send()`, so surfacing the echo
            // would duplicate the message (a tiny "ACT userMessage" pill
            // appears under the real bubble). Drop it.
            return null
          case 'agentMessage':
          case 'reasoning':
            // Suppressed: both consumers (renderer store + AgentManager
            // persistence) create-if-missing on item_delta/item_completed,
            // so `started` carries no information for text/reasoning. In the
            // cumulative-snapshot pattern (see lastAgentTextByThread) every
            // chunk opens a fresh id — emitting started would materialize an
            // empty text item / empty "Thought" pill per chunk that the
            // canonicalized delta then never touches.
            return null
          case 'commandExecution':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'shell',
              payload: {
                ...(item.command != null ? { command: item.command } : {}),
                ...(item.cwd != null ? { cwd: item.cwd } : {}),
              },
            }
          case 'fileChange': {
            // 上游 README 的审批时序第 1 步:「item/started emits a fileChange
            // item with `changes` (diff chunk summaries) … Show the proposed
            // edits and paths to the user」。完整的提议改动在这一刻就有了 ——
            // 无条件、不看 feature flag、也不依赖 gateway 转发哪条增量通知。
            // 此前这里只取 path 把 changes 扔了,于是明明手上有 diff,卡片还是
            // 空着一路等到 item/completed。
            const startedRaw = Array.isArray(item.changes) ? item.changes : []
            const startedChanges = (startedRaw as Parameters<typeof parseChange>[0][]).map(parseChange)
            if (startedChanges.length > 0) {
              // 这也是一份权威快照,后续裸文本不能再往上追加。
              const startedKey = itemStateKey(params.threadId, item.id)
              if (startedKey) this.authoritativeChangesItemIds.add(startedKey)
            }
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              // 退化路径:没给 changes 时至少把 path 带上,让卡片能显示文件名
              // 而不是「正在写入」。两个都没有就留空,不编一个路径出来。
              payload:
                startedChanges.length > 0
                  ? { changes: startedChanges }
                  : typeof item.path === 'string' && item.path.length > 0
                    ? { path: item.path }
                    : {},
            }
          }
          case 'plan':
            // `plan` ThreadItems carry only a pre-rendered text blob in v2
            // (`{ type: 'plan', id, text }` per the v2 ThreadItem schema). The
            // structured `[{ step, status }]` list — which is what the
            // PlanCard renders — arrives on the separate `turn/plan/updated`
            // notification (PR openai/codex#7329). Surfacing this item-level
            // event would just create a generic activity pill alongside the
            // real PlanCard built from `turn/plan/updated`, so we drop it.
            return null
          default: {
            // Plan-tool dispatch comes through here when Codex routes
            // `update_plan` / `todo_write` as a `dynamicToolCall` instead of
            // emitting the dedicated `turn/plan/updated` notification (which
            // is what Codex 0.130.0 does in practice with non-Responses-API
            // gateways). Intercept it and render as a real PlanCard;
            // returning here also suppresses the generic "TOOL plan" chip so
            // there's no double card.
            const planEvent = maybeRoutePlanToolCall(item, params.threadId, params.turnId, false)
            if (planEvent) return planEvent

            // Generic activity card: covers mcpToolCall, webSearch,
            // dynamicToolCall, collabToolCall, imageView,
            // contextCompaction, enteredReviewMode, exitedReviewMode, plus any
            // future Codex item.type we don't have a bespoke renderer for. The
            // pre-fix router silently dropped all of these, which is exactly
            // why the user couldn't see tool calls / MCP / file reads.
            const { label, detail } = summarizeActivity(item)
            const delegation = parseDelegation(item)
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'activity',
              payload: {
                kind: item.type,
                ...(label != null ? { label } : {}),
                ...(detail != null ? { detail } : {}),
                status: statusFromItem(item) ?? 'running',
                ...(delegation ? { delegation } : {}),
              },
            }
          }
        }
      }

      case 'item/agentMessage/delta': {
        const itemId = params.itemId as string | undefined
        const key = itemStateKey(params.threadId, itemId)
        if (key) this.streamedDeltaItemIds.add(key)
        if (typeof itemId === 'string' && itemId.length > 0) {
          this.trackAgentText(params.threadId, itemId, String(params.delta ?? ''))
        }
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: itemId ?? '',
          itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: params.delta ?? '' },
        }
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta': {
        const itemId = params.itemId as string | undefined
        const key = itemStateKey(params.threadId, itemId)
        if (key) this.streamedReasoningItemIds.add(key)
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: itemId ?? '',
          itemType: 'reasoning',
          patch: { kind: 'appendText', field: 'content', text: params.delta ?? '' },
        }
      }

      case 'item/reasoning/summaryPartAdded': {
        // Section break between summary parts. Insert a blank line so
        // consecutive summary chunks don't visually run together; whitespace
        // at the start gets trimmed by the ReasoningCard render path.
        const itemId = params.itemId as string | undefined
        if (typeof itemId !== 'string' || itemId.length === 0) return null
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId,
          itemType: 'reasoning',
          patch: { kind: 'appendText', field: 'content', text: '\n\n' },
        }
      }

      case 'item/commandExecution/output':
      case 'item/commandExecution/outputDelta': {
        // Codex protocol uses `outputDelta`; we previously listened to the
        // wrong method name (`output`) so stdout/stderr never streamed in our
        // app. Keep the legacy spelling in case older Codex versions still
        // emit it on the wire.
        const field = params.stream === 'stderr' ? 'stderr' : 'stdout'
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: params.itemId ?? '',
          itemType: 'shell',
          patch: { kind: 'appendText', field, text: params.data ?? '' },
        }
      }

      case 'item/fileChange/outputDelta': {
        const itemId = params.itemId as string | undefined
        const text =
          typeof params.delta === 'string'
            ? params.delta
            : typeof params.data === 'string'
              ? params.data
              : ''
        if (typeof itemId !== 'string' || itemId.length === 0 || text.length === 0) return null
        const key = itemStateKey(params.threadId, itemId)
        // 继续攒:completed 时 gateway 若没给 unifiedDiff,要靠这份兜底。
        const buffered = key
          ? `${this.fileChangeOutputByItemId.get(key) ?? ''}${text}`
          : text
        if (key) this.fileChangeOutputByItemId.set(key, buffered)
        // 结构化通道已经在喂这张卡了,裸文本只留兜底,不再往渲染层递。
        if (key && this.authoritativeChangesItemIds.has(key)) return null
        // 守卫:上游 README 明确写着这条通道装的是 **apply_patch 的工具返回**
        // (「contains the tool call response of the underlying apply_patch tool
        // call」),不是正在写的 diff —— 和 commandExecution 那条「streams
        // stdout/stderr」的措辞是有意区分的。合规 Codex 在这里发的是
        // 「Success. Updated the following files: M src/a.ts」之类,直接当 diff
        // 渲染就是往卡片里灌工具日志。
        //
        // 但兜底路径又确实是为「某些中继网关把 diff 塞在这里」建的(那批用例还
        // 在)。所以两边都留:攒照旧无条件攒,只有拼出来的内容**真的长得像
        // unified diff** 才往渲染层递。
        // 判定要看拼接后的全文:增量会切在半行上,第一段可能只有 '@',单看它
        // 判不出来。所以按「已递出多少字节」补发差额,而不是发本段。
        const emitted = key ? (this.emittedDiffLenByItemId.get(key) ?? 0) : 0
        // 已经开始递了就说明早判定过是 diff,别再对着越来越长的全文重判。
        if (emitted === 0 && !looksLikeUnifiedDiff(buffered)) return null
        const pending = buffered.slice(emitted)
        if (pending.length === 0) return null
        if (key) this.emittedDiffLenByItemId.set(key, buffered.length)
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId,
          itemType: 'fileEdit',
          patch: { kind: 'appendText', field: 'diff', text: pending },
        }
      }

      case 'item/fileChange/patchUpdated': {
        // 与 outputDelta 并列注册的通知,带的是**累积的 changes 数组**,形状
        // 和 item/completed 的一样:有真实路径、支持多文件、是真 unified diff。
        // 因此这里整体合并而不是追加 —— 每条通知都是当前完整状态。
        const itemId = params.itemId as string | undefined
        const raw = Array.isArray(params.changes) ? params.changes : null
        if (typeof itemId !== 'string' || itemId.length === 0 || !raw) return null
        const key = itemStateKey(params.threadId, itemId)
        if (key) this.authoritativeChangesItemIds.add(key)
        const changes = (raw as Parameters<typeof parseChange>[0][]).map(parseChange)
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId,
          itemType: 'fileEdit',
          patch: {
            kind: 'mergeFields',
            fields: {
              changes,
              totalAdded: changes.reduce((sum, c) => sum + c.added, 0),
              totalRemoved: changes.reduce((sum, c) => sum + c.removed, 0),
            },
          },
        }
      }

      case 'item/plan/delta':
        // `PlanDeltaNotification` streams raw `text`-field deltas for the
        // plan ThreadItem (which itself is dropped above). The schema header
        // says: "Clients should not assume concatenated deltas match the
        // completed plan item content." The structured PlanCard updates flow
        // through `turn/plan/updated` instead, so this channel is dropped.
        return null

      case 'turn/plan/updated': {
        // PR openai/codex#7329: `EventMsg::PlanUpdate(UpdatePlanArgs)` is
        // serialized as a turn-level notification with the full structured
        // plan in `params.plan: [{ step, status }]`. This is the *only* event
        // that carries the data PlanCard needs.
        //
        // Codex re-emits this notification every time the model calls
        // `update_plan` / `todo_write` (typically once at task start, then
        // again each time a step transitions). We always have a complete
        // snapshot, so we synthesize a single ActivityItem keyed by
        // `plan:${turnId}` and let the store's existing `item_delta`
        // mergeFields upsert path create-or-update it idempotently.
        const threadId = params.threadId
        const turnId = typeof params.turnId === 'string' ? params.turnId : undefined
        if (typeof threadId !== 'string' || threadId.length === 0 || !turnId) return null
        const steps = extractPlanSteps(params.plan)
        if (!steps) return null
        const explanation =
          typeof params.explanation === 'string' && params.explanation.length > 0
            ? params.explanation
            : undefined
        return {
          type: 'item_delta',
          threadId,
          turnId,
          itemId: `plan:${turnId}`,
          itemType: 'activity',
          patch: {
            kind: 'mergeFields',
            fields: buildPlanMergeFields(steps, explanation, false),
          },
        }
      }

      case 'item/completed': {
        const item = params.item as CodexItem | undefined
        if (!item?.type || !item?.id) return null

        switch (item.type) {
          case 'userMessage':
            // Never rendered (the local user bubble already exists — see the
            // `item/started` drop), but the completed echo carries the
            // canonical rollout view of the message: `clientId` (our
            // clientUserMessageId = persisted row id), localImage paths and
            // text_elements. Surface it as an internal reconcile event so
            // AgentManager can fold that data back onto our DB row.
            return {
              type: 'user_message_reconciled',
              threadId: params.threadId,
              turnId: params.turnId,
              reconcile: parseUserMessageReconcile(item, params.turnId ?? params.turn_id),
            }
          case 'agentMessage': {
            const key = itemStateKey(params.threadId, item.id)
            if (key && this.streamedDeltaItemIds.has(key)) {
              this.streamedDeltaItemIds.delete(key)
              return null
            }
            if (typeof item.text !== 'string' || item.text.length === 0) return null
            // Cumulative-snapshot canonicalization: when this "new" item's
            // full text merely extends the thread's previous text item, the
            // gateway is re-sending the whole reply per chunk. Fold it onto
            // the canonical id and emit only the suffix. Raw startsWith only
            // — anything fuzzier (trailing-whitespace drift etc.) is left to
            // the downstream dedup fallback.
            const threadId = typeof params.threadId === 'string' ? params.threadId : ''
            const tracked = threadId ? this.lastAgentTextByThread.get(threadId) : undefined
            if (
              tracked
              && tracked.id !== item.id
              && tracked.content.trimEnd().length >= MIN_SNAPSHOT_PREFIX_LEN
              && item.text.startsWith(tracked.content)
            ) {
              const suffix = item.text.slice(tracked.content.length)
              tracked.content = item.text
              return {
                type: 'item_delta',
                threadId: params.threadId,
                itemId: tracked.id,
                itemType: 'text',
                patch: { kind: 'appendText', field: 'content', text: suffix },
              }
            }
            if (threadId) {
              this.lastAgentTextByThread.set(threadId, { id: item.id, content: item.text })
            }
            return {
              type: 'item_delta',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'text',
              patch: { kind: 'appendText', field: 'content', text: item.text },
            }
          }
          case 'commandExecution':
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'shell',
              final: { exitCode: item.exitCode },
            }
          case 'fileChange': {
            const rawChanges = Array.isArray(item.changes) ? item.changes : []
            const key = itemStateKey(params.threadId, item.id)
            const fallbackDiff = key ? this.fileChangeOutputByItemId.get(key) : undefined
            if (key) {
              this.fileChangeOutputByItemId.delete(key)
              this.authoritativeChangesItemIds.delete(key)
              this.emittedDiffLenByItemId.delete(key)
            }
            const fallbackRawChanges =
              rawChanges.length === 0 && fallbackDiff && typeof item.path === 'string' && item.path.length > 0
                ? [{ path: item.path, kind: 'edit' }]
                : rawChanges
            // parseChange asserts the runtime shape; the array element type is
            // intentionally loose at the wire level since gateways drift.
            const changes = (fallbackRawChanges as Parameters<typeof parseChange>[0][]).map(parseChange)
            const canUseFallbackDiff =
              fallbackRawChanges.length === 1 && lacksStringUnifiedDiff(fallbackRawChanges[0])
            if (fallbackDiff && canUseFallbackDiff && changes.length === 1 && changes[0].diff.length === 0) {
              const { added, removed } = countDiffLines(fallbackDiff)
              changes[0].diff = fallbackDiff
              changes[0].added = added
              changes[0].removed = removed
            }
            const totalAdded = changes.reduce((sum, change) => sum + change.added, 0)
            const totalRemoved = changes.reduce((sum, change) => sum + change.removed, 0)
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              final: { changes, totalAdded, totalRemoved },
            }
          }
          case 'reasoning': {
            // Backfill: if the gateway never streamed deltas (apiyi has done
            // this in the wild) but the final payload does carry the summary
            // / content text, splice it onto the card so "Thought" isn't an
            // empty pill.
            const key = itemStateKey(params.threadId, item.id)
            const hasStreamedReasoning = key ? this.streamedReasoningItemIds.has(key) : false
            if (!hasStreamedReasoning) {
              const text = extractReasoningText(item)
              if (text.length > 0) {
                return {
                  type: 'item_completed',
                  threadId: params.threadId,
                  itemId: item.id,
                  itemType: 'reasoning',
                  final: { content: text },
                }
              }
              // Never streamed AND no text: an empty reasoning item carries
              // zero information. Snapshot gateways emit one of these per
              // SSE chunk (130 per reply in the live repro) — forwarding the
              // completion would materialize an empty "Thought" pill each
              // time, since consumers create-if-missing on item_completed.
              return null
            }
            if (key) this.streamedReasoningItemIds.delete(key)
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              final: {},
            }
          }
          case 'plan':
            // Symmetric with the `item/started` plan drop above. The PlanCard
            // is driven entirely by `turn/plan/updated`; the plan ThreadItem's
            // `text` blob would just be a duplicate (and a misleading one,
            // since the text is auto-rendered from the structured plan).
            return null
          default: {
            // Symmetric with the `item/started` plan-tool intercept above.
            // Crucially we DON'T forceSuccess on completion: Codex calls
            // `update_plan` repeatedly throughout a single turn (once per
            // step transition per the tool prompt), and each individual call
            // starts + completes in milliseconds. If we hard-coded
            // `status: 'success'` on every tool-call completion the
            // PlanCard would flash emerald (success theme) between calls
            // and only briefly flip back to cyan when the next call starts,
            // making the agent look like it keeps "finishing" the plan over
            // and over. Instead let `buildPlanMergeFields` derive status
            // from the snapshot itself (`allCompleted` → success, else
            // running), so the card stays cyan throughout execution and
            // turns green exactly once — when the final `update_plan` call
            // arrives with every step marked completed.
            const planEvent = maybeRoutePlanToolCall(item, params.threadId, params.turnId, false)
            if (planEvent) return planEvent

            // Bookend the activity card so the spinner stops and the status
            // pill flips to success/error. Without this branch any
            // mcpToolCall / webSearch / etc. would stay perpetually running.
            const { label, detail } = summarizeActivity(item)
            const explicitError =
              typeof item.error === 'string' && item.error.length > 0 ? item.error : undefined
            const delegation = parseDelegation(item)
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'activity',
              final: {
                kind: item.type,
                ...(label != null ? { label } : {}),
                ...(detail != null ? { detail } : {}),
                status: statusFromItem(item) ?? (explicitError ? 'error' : 'success'),
                ...(explicitError ? { error: explicitError } : {}),
                ...(delegation ? { delegation } : {}),
              },
            }
          }
        }
      }

      case 'thread/tokenUsage/updated': {
        const usage = extractTokenUsage(params)
        if (!usage) return null
        return {
          type: 'token_usage_updated',
          threadId: params.threadId,
          turnId: params.turnId,
          usage,
        }
      }

      case 'thread/settings/updated':
        return parseThreadSettingsUpdated(params)

      case 'turn/completed':
        this.clearThreadState(params.threadId)
        return {
          type: 'turn_completed',
          threadId: params.threadId,
          turnId: params.turn?.id,
        }

      case 'error':
        // codex-rs sends willRetry:true for transient stream errors
        // (EventMsg::StreamError) right before re-streaming the same request
        // with new item ids. Forward the flag so downstream consumers can
        // drop the failed attempt's partial output instead of duplicating it.
        return {
          type: 'error',
          threadId: params.threadId,
          error: params.error?.message ?? 'codex error',
          willRetry: params.willRetry === true,
        }

      case 'mcpServer/startupStatus/updated':
        return {
          type: 'mcp_status_updated' as const,
          name: params.name as string,
          status: params.status as string,
          error: (params.error as string) ?? null,
        }

      case 'mcpServer/oauthLogin/completed':
        return {
          type: 'mcp_oauth_completed' as const,
          name: params.name as string,
          success: params.success as boolean,
          error: (params.error as string) ?? null,
        }

      // Native `/goal` lifecycle. `thread/goal/updated` carries the full goal
      // object (objective/status/token+time usage); `thread/goal/cleared` just
      // the threadId. Both are turn-independent, so the client forwards them via
      // the goal side channel rather than the per-turn queue.
      case 'thread/goal/updated': {
        const goal = params.goal
        if (!goal || typeof goal !== 'object') return null
        return {
          type: 'goal_updated' as const,
          threadId: params.threadId as string,
          goal: goal as ThreadGoal,
        }
      }

      case 'thread/goal/cleared':
        return {
          type: 'goal_cleared' as const,
          threadId: params.threadId as string,
        }

      // Skill catalog drift on disk (user added/removed a SKILL.md). Renderer
      // should refetch its `availableSkills` cache so the `$` popup picks up
      // changes without a panel reload.
      case 'skills/changed':
        return { type: 'skills_changed' }

      // Codex global config warning — surface as a banner so the user knows
      // their `~/.codex/config.toml` has invalid keys, etc.
      case 'configWarning': {
        const message = typeof params?.message === 'string' ? params.message : 'Codex config warning'
        return {
          type: 'notice',
          notice: {
            id: `configWarning:${message.slice(0, 64)}:${Date.now()}`,
            kind: 'configWarning',
            level: 'warning',
            message,
          },
        }
      }

      // A removed/renamed RPC or feature was used. Codex sends this once per
      // session — we render it as a warning banner.
      case 'deprecationNotice': {
        const message = typeof params?.message === 'string' ? params.message : 'Codex deprecation notice'
        return {
          type: 'notice',
          notice: {
            id: `deprecation:${message.slice(0, 64)}:${Date.now()}`,
            kind: 'deprecation',
            level: 'warning',
            message,
          },
        }
      }

      // Codex re-routed the requested model (e.g. quota / rate limit / unsupported
      // tool). Banner-level info — the user paid for X, got Y, they need to know.
      case 'model/rerouted': {
        // 上游载荷是 fromModel / toModel（app-server README + AGENTS.md 的
        // `rename_all = "camelCase"` 约定）；短名是早期形状，一并吃下。只读短名时
        // 两个值都会落到下面的占位符，通知照弹却不说换了哪个模型 —— 占位符会把这个
        // 失配掩盖成「看起来正常」，所以别把它简化掉。
        const fromRaw = params?.fromModel ?? params?.from
        const toRaw = params?.toModel ?? params?.to
        const from = typeof fromRaw === 'string' ? fromRaw : 'requested model'
        const to = typeof toRaw === 'string' ? toRaw : 'fallback model'
        const reason = typeof params?.reason === 'string' ? params.reason : null
        const message = reason
          ? `Routed from ${from} to ${to} (${reason}).`
          : `Routed from ${from} to ${to}.`
        return {
          type: 'notice',
          notice: {
            id: `modelRerouted:${from}->${to}:${Date.now()}`,
            kind: 'modelRerouted',
            level: 'info',
            message,
            details: { from, to, ...(reason ? { reason } : {}) },
          },
        }
      }

      case 'hook/started': {
        const hookName = typeof params?.hookName === 'string' ? params.hookName : 'hook'
        return {
          type: 'notice',
          notice: {
            id: `hookStarted:${hookName}:${Date.now()}`,
            kind: 'hookStarted',
            level: 'info',
            message: `Running hook: ${hookName}`,
            threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
            details: { hookName },
          },
        }
      }

      case 'hook/completed': {
        const hookName = typeof params?.hookName === 'string' ? params.hookName : 'hook'
        const success = params?.success === true
        return {
          type: 'notice',
          notice: {
            id: `hookCompleted:${hookName}:${Date.now()}`,
            kind: 'hookCompleted',
            level: 'info',
            message: success ? `Hook done: ${hookName}` : `Hook failed: ${hookName}`,
            threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
            details: { hookName, success },
          },
        }
      }

      // The auto-approver is silently inspecting a request before deciding.
      // Visible as a tiny info pill so the user understands why a 1-2 second
      // pause appears between an action and its execution.
      case 'item/autoApprovalReview/started': {
        const itemId = typeof params?.itemId === 'string' ? params.itemId : 'item'
        return {
          type: 'notice',
          notice: {
            id: `autoApprovalReview:${itemId}:${Date.now()}`,
            kind: 'autoApprovalReview',
            level: 'info',
            message: `Auto-approval review started${itemId ? ` for ${itemId}` : ''}`,
            threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
            details: { itemId },
          },
        }
      }

      case 'item/autoApprovalReview/completed': {
        const itemId = typeof params?.itemId === 'string' ? params.itemId : 'item'
        const approved = params?.approved === true
        return {
          type: 'notice',
          notice: {
            id: `autoApprovalReviewCompleted:${itemId}:${Date.now()}`,
            kind: 'autoApprovalReviewCompleted',
            level: 'info',
            message: approved
              ? `Auto-approved${itemId ? ` ${itemId}` : ''}`
              : `Auto-approval rejected${itemId ? ` for ${itemId}` : ''}`,
            threadId: typeof params?.threadId === 'string' ? params.threadId : undefined,
            details: { itemId, approved },
          },
        }
      }

      default:
        return null
    }
  }
}
