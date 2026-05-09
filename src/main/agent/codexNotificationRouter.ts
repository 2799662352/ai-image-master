import type { AgentStreamEvent, AgentTokenUsage, AgentTokenUsageDelta } from '../../types/agent'
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
    case 'dynamicToolCall':
    case 'collabToolCall': {
      const tool =
        typeof item.toolName === 'string'
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
      return { label: 'compacting context' }
    default:
      return { label: item.type }
  }
}

function statusFromItem(item: CodexItem): 'running' | 'success' | 'error' | 'cancelled' | undefined {
  const s = typeof item.status === 'string' ? item.status.toLowerCase() : null
  if (!s) return undefined
  if (s.includes('error') || s.includes('fail')) return 'error'
  if (s.includes('cancel')) return 'cancelled'
  if (s.includes('success') || s === 'completed' || s === 'done') return 'success'
  if (s === 'running' || s === 'in_progress' || s === 'pending') return 'running'
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
  const u = counter
  const inputTokens =
    readNumber(u.inputTokens) ?? readNumber(u.input_tokens) ?? readNumber(u.prompt_tokens)
  const outputTokens =
    readNumber(u.outputTokens) ?? readNumber(u.output_tokens) ?? readNumber(u.completion_tokens)
  if (inputTokens == null && outputTokens == null) return null

  const usage: AgentTokenUsage = {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
  }
  const reasoningTokens =
    readNumber(u.reasoningTokens)
    ?? readNumber(u.reasoning_tokens)
    ?? readNumber(u.reasoningOutputTokens) // codex 0.128 spelling
    ?? readNumber(u.reasoning_output_tokens)
  if (reasoningTokens != null) usage.reasoningTokens = reasoningTokens
  const cachedInputTokens =
    readNumber(u.cachedInputTokens)
    ?? readNumber(u.cached_input_tokens)
    ?? readNumber(u.cache_read_input_tokens)
  if (cachedInputTokens != null) usage.cachedInputTokens = cachedInputTokens
  const contextWindow =
    readNumber(params.contextWindow)
    ?? readNumber(params.context_window)
    ?? readNumber((params.tokenUsage as Record<string, unknown> | undefined)?.contextWindow)
  if (contextWindow != null) usage.contextWindow = contextWindow
  const contextUsage =
    readNumber(params.contextUsage)
    ?? readNumber(params.context_usage)
    ?? readNumber((params.tokenUsage as Record<string, unknown> | undefined)?.contextUsage)
  if (contextUsage != null) usage.contextUsage = contextUsage

  const last = extractLastDelta(params)
  if (last) usage.last = last
  return usage
}

/**
 * Read `tokenUsage.last` (per-turn delta). Returns `undefined` when the slice
 * is missing OR when both input/output are zero — we'd rather hide the
 * "Last turn" popover line than show "+0 / +0" noise. Mirrors the field
 * aliasing in `extractTokenUsage` so apiyi / OpenRouter snake_case still works.
 */
function extractLastDelta(params: Record<string, unknown>): AgentTokenUsageDelta | undefined {
  const tu = params.tokenUsage as Record<string, unknown> | undefined
  const last = tu?.last as Record<string, unknown> | undefined
  if (!last || typeof last !== 'object') return undefined
  const inputTokens =
    readNumber(last.inputTokens) ?? readNumber(last.input_tokens) ?? readNumber(last.prompt_tokens) ?? 0
  const outputTokens =
    readNumber(last.outputTokens) ?? readNumber(last.output_tokens) ?? readNumber(last.completion_tokens) ?? 0
  if (inputTokens === 0 && outputTokens === 0) return undefined

  const delta: AgentTokenUsageDelta = { inputTokens, outputTokens }
  const reasoningTokens =
    readNumber(last.reasoningTokens)
    ?? readNumber(last.reasoning_tokens)
    ?? readNumber(last.reasoningOutputTokens)
    ?? readNumber(last.reasoning_output_tokens)
  if (reasoningTokens != null) delta.reasoningTokens = reasoningTokens
  const cachedInputTokens =
    readNumber(last.cachedInputTokens)
    ?? readNumber(last.cached_input_tokens)
    ?? readNumber(last.cache_read_input_tokens)
  if (cachedInputTokens != null) delta.cachedInputTokens = cachedInputTokens
  return delta
}

/**
 * Walk the union of token-usage payload shapes we've seen in the wild and
 * return the first leaf object that actually carries `inputTokens` /
 * `outputTokens` (or their snake-case / Responses-API aliases). We try
 * cumulative shapes first because the meter visualizes lifetime-of-thread
 * usage, then per-turn, then a flat fallback.
 */
function pickUsageCounter(params: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: Array<Record<string, unknown> | undefined> = []
  const tu = params.tokenUsage as Record<string, unknown> | undefined
  if (tu) {
    candidates.push(tu.total as Record<string, unknown> | undefined)
    candidates.push(tu.last as Record<string, unknown> | undefined)
    candidates.push(tu) // some gateways flatten total fields onto tokenUsage itself
  }
  candidates.push(params.usage as Record<string, unknown> | undefined)
  candidates.push(params)
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    if (
      readNumber(c.inputTokens) != null
      || readNumber(c.input_tokens) != null
      || readNumber(c.prompt_tokens) != null
      || readNumber(c.outputTokens) != null
      || readNumber(c.output_tokens) != null
      || readNumber(c.completion_tokens) != null
    ) {
      return c
    }
  }
  return null
}

export class CodexNotificationRouter {
  private readonly streamedDeltaItemIds = new Set<string>()
  private readonly streamedReasoningItemIds = new Set<string>()
  private readonly fileChangeOutputByItemId = new Map<string, string>()

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
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'text',
              payload: {},
            }
          case 'reasoning':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              payload: {},
            }
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
          case 'fileChange':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              payload: {},
            }
          default: {
            // Generic activity card: covers mcpToolCall, webSearch,
            // dynamicToolCall, collabToolCall, imageView, plan,
            // contextCompaction, enteredReviewMode, exitedReviewMode, plus any
            // future Codex item.type we don't have a bespoke renderer for. The
            // pre-fix router silently dropped all of these, which is exactly
            // why the user couldn't see tool calls / MCP / file reads.
            const { label, detail } = summarizeActivity(item)
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
              },
            }
          }
        }
      }

      case 'item/agentMessage/delta': {
        const itemId = params.itemId as string | undefined
        if (typeof itemId === 'string' && itemId.length > 0) {
          this.streamedDeltaItemIds.add(itemId)
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
        if (typeof itemId === 'string' && itemId.length > 0) {
          this.streamedReasoningItemIds.add(itemId)
        }
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
        if (typeof itemId === 'string' && itemId.length > 0 && text.length > 0) {
          this.fileChangeOutputByItemId.set(itemId, `${this.fileChangeOutputByItemId.get(itemId) ?? ''}${text}`)
        }
        return null
      }

      case 'item/plan/delta': {
        // No bespoke plan card yet. Surface the latest delta on the generic
        // activity card's `detail` slot so users can at least watch the plan
        // evolve. (Eventually deserves its own card.)
        const itemId = params.itemId as string | undefined
        if (typeof itemId !== 'string' || itemId.length === 0) return null
        const text = typeof params.delta === 'string' ? params.delta : ''
        if (text.length === 0) return null
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId,
          itemType: 'activity',
          patch: { kind: 'mergeFields', fields: { detail: text } },
        }
      }

      case 'item/completed': {
        const item = params.item as CodexItem | undefined
        if (!item?.type || !item?.id) return null

        switch (item.type) {
          case 'userMessage':
            // Mirror the `item/started` drop so a late completion notification
            // can't sneak through the activity fallback.
            return null
          case 'agentMessage': {
            if (this.streamedDeltaItemIds.has(item.id)) return null
            if (typeof item.text !== 'string' || item.text.length === 0) return null
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
            const fallbackDiff = this.fileChangeOutputByItemId.get(item.id)
            this.fileChangeOutputByItemId.delete(item.id)
            const fallbackRawChanges =
              rawChanges.length === 0 && fallbackDiff ? [{ path: item.path, kind: 'edit' }] : rawChanges
            // parseChange asserts the runtime shape; the array element type is
            // intentionally loose at the wire level since gateways drift.
            const changes = (fallbackRawChanges as Parameters<typeof parseChange>[0][]).map(parseChange)
            if (fallbackDiff) {
              const emptyDiffChange = changes.find((change) => change.diff.length === 0)
              if (emptyDiffChange) {
                const { added, removed } = countDiffLines(fallbackDiff)
                emptyDiffChange.diff = fallbackDiff
                emptyDiffChange.added = added
                emptyDiffChange.removed = removed
              }
            }
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              final: { changes },
            }
          }
          case 'reasoning': {
            // Backfill: if the gateway never streamed deltas (apiyi has done
            // this in the wild) but the final payload does carry the summary
            // / content text, splice it onto the card so "Thought" isn't an
            // empty pill.
            if (!this.streamedReasoningItemIds.has(item.id)) {
              const text = extractReasoningText(item)
              if (text.length > 0) {
                return {
                  type: 'item_delta',
                  threadId: params.threadId,
                  itemId: item.id,
                  itemType: 'reasoning',
                  patch: { kind: 'appendText', field: 'content', text },
                }
              }
            }
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              final: {},
            }
          }
          default: {
            // Bookend the activity card so the spinner stops and the status
            // pill flips to success/error. Without this branch any
            // mcpToolCall / webSearch / etc. would stay perpetually running.
            const { label, detail } = summarizeActivity(item)
            const explicitError =
              typeof item.error === 'string' && item.error.length > 0 ? item.error : undefined
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

      case 'turn/completed':
        return {
          type: 'turn_completed',
          threadId: params.threadId,
          turnId: params.turn?.id,
        }

      case 'error':
        return {
          type: 'error',
          threadId: params.threadId,
          error: params.error?.message ?? 'codex error',
        }

      default:
        return null
    }
  }
}
