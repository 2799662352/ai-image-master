import type { McpToolCallItem, ThreadEvent, ToolCall } from './types'

/** Pull the `item` off an event if it's an MCP tool-call item. */
function asToolItem(evt: ThreadEvent): McpToolCallItem | null {
  const item = evt.item
  if (item && item.type === 'mcp_tool_call') return item as McpToolCallItem
  return null
}

function errorMessage(error: McpToolCallItem['error']): string | undefined {
  if (!error) return undefined
  if (typeof error === 'string') return error
  return error.message
}

/**
 * Normalize every MCP tool call in the stream into {@link ToolCall}s, in call
 * order. A call that appears as both `item.started` and `item.completed`
 * (same `item.id`) is collapsed into ONE entry, preferring the completed
 * payload (it carries final `status`/`arguments`/`error`). A call seen only as
 * `item.started` (turn died mid-call) is included with `completed: false`.
 */
export function mcpToolCalls(events: readonly ThreadEvent[]): ToolCall[] {
  const order: string[] = []
  const byId = new Map<string, ToolCall>()
  let anon = 0

  for (const evt of events) {
    if (evt.type !== 'item.started' && evt.type !== 'item.updated' && evt.type !== 'item.completed') continue
    const item = asToolItem(evt)
    if (!item) continue

    const id = item.id ?? `__anon_${anon++}`
    const completed = evt.type === 'item.completed'
    const existing = byId.get(id)

    const call: ToolCall = {
      id,
      server: item.server ?? existing?.server ?? '',
      tool: item.tool ?? existing?.tool ?? '',
      arguments: item.arguments ?? existing?.arguments,
      status: item.status ?? existing?.status ?? 'in_progress',
      completed: completed || (existing?.completed ?? false),
      error: errorMessage(item.error) ?? existing?.error,
    }

    if (!existing) order.push(id)
    // A completed event always wins; otherwise keep the first non-completed
    // snapshot unless we're upgrading to completed.
    if (!existing || completed) byId.set(id, call)
  }

  return order.map((id) => byId.get(id)!).filter(Boolean)
}

/** Tool names in call order (duplicates preserved). */
export function toolNames(events: readonly ThreadEvent[]): string[] {
  return mcpToolCalls(events).map((c) => c.tool)
}

/** Throw unless `name` was called at least once. */
export function assertToolUsed(events: readonly ThreadEvent[], name: string): void {
  const names = toolNames(events)
  if (!names.includes(name)) {
    throw new Error(`Expected tool "${name}" to be called, but trajectory was: [${names.join(', ') || '<no tool calls>'}]`)
  }
}

/** Throw if `name` was called at all (use to assert the agent did NOT misroute). */
export function assertToolNotUsed(events: readonly ThreadEvent[], name: string): void {
  const names = toolNames(events)
  if (names.includes(name)) {
    throw new Error(`Expected tool "${name}" to NOT be called, but trajectory was: [${names.join(', ')}]`)
  }
}

/**
 * Throw unless `expected` appears as an (in-order, gaps-allowed) SUBSEQUENCE of
 * the actual tool-call order.
 */
export function assertToolOrder(events: readonly ThreadEvent[], expected: readonly string[]): void {
  const actual = toolNames(events)
  let cursor = 0
  for (const name of actual) {
    if (cursor < expected.length && name === expected[cursor]) cursor++
  }
  if (cursor < expected.length) {
    throw new Error(`Expected tool order subsequence [${expected.join(' -> ')}] but got [${actual.join(' -> ') || '<no tool calls>'}]`)
  }
}

/**
 * Throw unless at least one call to `name` has arguments satisfying
 * `predicate`. Also throws (distinctly) if `name` was never called.
 */
export function assertToolArgs(
  events: readonly ThreadEvent[],
  name: string,
  predicate: (args: unknown) => boolean,
): void {
  const calls = mcpToolCalls(events).filter((c) => c.tool === name)
  if (calls.length === 0) {
    throw new Error(`Expected tool "${name}" to be called, but it never was.`)
  }
  if (!calls.some((c) => predicate(c.arguments))) {
    throw new Error(
      `Tool "${name}" was called ${calls.length}x but no call's arguments matched the predicate. ` +
        `Args seen: ${calls.map((c) => JSON.stringify(c.arguments)).join(' | ')}`,
    )
  }
}

/** All `agent_message` texts in order. */
export function agentMessages(events: readonly ThreadEvent[]): string[] {
  const out: string[] = []
  for (const evt of events) {
    if (evt.type !== 'item.completed') continue
    const item = evt.item
    if (item && item.type === 'agent_message' && typeof item.text === 'string') out.push(item.text)
  }
  return out
}

/** The last `agent_message` text, or `undefined` if the agent never spoke. */
export function finalMessage(events: readonly ThreadEvent[]): string | undefined {
  const all = agentMessages(events)
  return all.length > 0 ? all[all.length - 1] : undefined
}

/** True if any `turn.failed` or top-level `error` event is present. */
export function turnFailed(events: readonly ThreadEvent[]): boolean {
  return events.some((e) => e.type === 'turn.failed' || e.type === 'error')
}

/** Error messages from `turn.failed` / `error` events. */
export function errors(events: readonly ThreadEvent[]): string[] {
  const out: string[] = []
  for (const evt of events) {
    if (evt.type !== 'turn.failed' && evt.type !== 'error') continue
    const error = evt.error
    if (typeof error === 'string') out.push(error)
    else if (error && typeof error.message === 'string') out.push(error.message)
  }
  return out
}
