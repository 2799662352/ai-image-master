/**
 * Minimal, TOLERANT mirror of the `codex exec --json` event stream.
 *
 * Grounded in codex rust `exec/src/exec_events.rs` (ThreadEvent / ThreadItem)
 * and the TS SDK `sdk/typescript/src/items.ts` (item shapes). We deliberately
 * keep these loose (extra fields allowed, most optional) so a minor codex
 * version bump that adds fields never breaks the parser — the harness only
 * relies on the handful of fields it asserts on.
 */

/** `item.completed` etc. carry one of these under `item`. */
export type ThreadItem =
  | AgentMessageItem
  | McpToolCallItem
  | CommandExecutionItem
  | GenericItem

export interface AgentMessageItem {
  id?: string
  type: 'agent_message'
  text?: string
  [k: string]: unknown
}

export type McpToolCallStatus = 'in_progress' | 'completed' | 'failed' | string

export interface McpToolCallItem {
  id?: string
  type: 'mcp_tool_call'
  /** MCP server name (our stub's name, e.g. `catimation`). */
  server?: string
  /** The tool invoked, e.g. `ask_user`. */
  tool?: string
  /** Arguments the model passed to the tool. */
  arguments?: unknown
  status?: McpToolCallStatus
  result?: unknown
  error?: { message?: string } | string
  [k: string]: unknown
}

export interface CommandExecutionItem {
  id?: string
  type: 'command_execution'
  command?: string
  aggregated_output?: string
  exit_code?: number
  status?: string
  [k: string]: unknown
}

/** Any item type we don't model explicitly (reasoning, web_search, …). */
export interface GenericItem {
  id?: string
  type: string
  [k: string]: unknown
}

/** Top-level JSONL event. `type` is the discriminator (`thread.started`, …). */
export interface ThreadEvent {
  type: string
  /** Present on `item.started` / `item.updated` / `item.completed`. */
  item?: ThreadItem
  /** Present on `error` / `turn.failed`. */
  error?: { message?: string } | string
  [k: string]: unknown
}

/** Normalized tool call extracted from the stream. */
export interface ToolCall {
  id: string
  server: string
  tool: string
  arguments: unknown
  status: McpToolCallStatus
  /** True when the call reached a terminal `item.completed`. */
  completed: boolean
  error?: string
}
