export interface BaseItem {
  id: string
  startedAt: number
  endedAt?: number
}

export interface TextItem extends BaseItem {
  type: 'text'
  content: string
}

export interface ReasoningItem extends BaseItem {
  type: 'reasoning'
  content: string
}

export interface ShellItem extends BaseItem {
  type: 'shell'
  command: string
  cwd?: string
  stdout: string
  stderr: string
  exitCode?: number
}

export interface FileChange {
  path: string
  operation: 'create' | 'edit' | 'delete'
  diff: string
  added: number
  removed: number
}

export interface FileEditItem extends BaseItem {
  type: 'fileEdit'
  changes: FileChange[]
  totalAdded: number
  totalRemoved: number
}

export interface AttachmentRef {
  id: string
  kind: 'image' | 'video' | 'file'
  name: string
  mime: string
  size: number
  uri: string
  thumbnailUri?: string
}

export interface AttachmentItem extends BaseItem {
  type: 'attachment'
  attachments: AttachmentRef[]
}

export interface ArtifactItem extends BaseItem {
  type: 'artifact'
  artifacts: AttachmentRef[]
  /**
   * Lifecycle of an in-app generation (e.g. the codex `generate_image` tool).
   * - `generating`: request in flight; render a skeleton/spinner card.
   * - `done` (or undefined): artifacts are ready; render thumbnails.
   * - `error`: generation failed; render `error` text.
   * Undefined keeps backward compatibility with plain attachment artifacts.
   */
  status?: 'generating' | 'done' | 'error'
  /** Prompt that produced these artifacts (shown on the generating card). */
  prompt?: string
  /** Failure message when `status === 'error'`. */
  error?: string
}

/**
 * Catch-all card for any Codex `item/*` notification we don't have a bespoke
 * renderer for yet. Critical: if we drop unknown item types silently the user
 * sees a black hole during turns that include MCP tool calls, web searches,
 * file reads, plan updates, context compactions, etc. Pre-MVP we showed
 * absolutely none of those.
 *
 * `kind` is the raw Codex `item.type` value (e.g. `mcpToolCall`, `webSearch`,
 * `contextCompaction`) so the renderer can pick an icon + label per kind.
 * `label` and `detail` are short single-line strings extracted from the
 * notification payload (e.g. `mcp.fetch`, `query="..."`); both are optional.
 * `status` mirrors any payload-level status (`running`, `success`, `error`,
 * etc.). When the item completes without an explicit status we set it to
 * `success` if no error was attached.
 */
/**
 * Mirrors Codex's `StepStatus` enum from
 * codex-rs/protocol/src/plan_tool.rs — three states, no more.
 * Codex's invariant: at most one step is `in_progress` at any time.
 */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed'

export interface PlanStep {
  text: string
  status: PlanStepStatus
}

export interface ActivityItem extends BaseItem {
  type: 'activity'
  kind: string
  label?: string
  detail?: string
  status?: 'running' | 'success' | 'error' | 'cancelled'
  /**
   * Set when `kind === 'plan'`. The renderer swaps the generic activity pill
   * for a real to-do list with per-step status dots. We keep it on
   * `ActivityItem` (rather than introducing a new TimelineItem type) so the
   * Evidence Stack grouping logic doesn't need to know about plans.
   */
  steps?: PlanStep[]
}

export type TimelineItem =
  | TextItem
  | ReasoningItem
  | ShellItem
  | FileEditItem
  | AttachmentItem
  | ArtifactItem
  | ActivityItem

export interface Message {
  id: string
  role: 'user' | 'assistant'
  createdAt: number
  items: TimelineItem[]
}

export function getMessageText(msg: Message): string {
  return msg.items
    .filter((i): i is TextItem => i.type === 'text')
    .map((i) => i.content)
    .join('\n')
}

/**
 * Drops the trailing run of `text`/`reasoning` items — the partial streamed
 * output of a model attempt that failed mid-stream. Codex stream retries
 * (error notification with `willRetry: true`) re-stream the ENTIRE response
 * under new item ids, so keeping the failed attempt's partial paragraphs
 * duplicates them once per retry ("对话重复"). Completed tool items (shell,
 * fileEdit, …) really executed and are preserved — only the trailing
 * text/reasoning run is speculative. Returns the original array when there is
 * nothing to trim.
 */
export function trimRetriedStreamItems(items: TimelineItem[]): TimelineItem[] {
  let end = items.length
  while (end > 0) {
    const t = items[end - 1].type
    if (t !== 'text' && t !== 'reasoning') break
    end -= 1
  }
  return end === items.length ? items : items.slice(0, end)
}

/**
 * Applies {@link trimRetriedStreamItems} to the last assistant message.
 * Returns the original array when nothing changed.
 */
export function trimRetriedStreamItemsInLastMessage(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const lastMsg = messages[lastIdx]
  if (lastMsg.role !== 'assistant') return messages
  const trimmed = trimRetriedStreamItems(lastMsg.items)
  if (trimmed === lastMsg.items) return messages
  const updated = [...messages]
  updated[lastIdx] = { ...lastMsg, items: trimmed }
  return updated
}

export function upsertItemInLastMessage<T extends TimelineItem>(
  messages: Message[],
  itemId: string,
  factory: () => T,
  patch: (item: T) => T,
): Message[] {
  if (messages.length === 0) return messages

  const lastIdx = messages.length - 1
  const lastMsg = messages[lastIdx]
  if (lastMsg.role !== 'assistant') return messages

  const itemIdx = lastMsg.items.findIndex((i) => i.id === itemId)
  let newItems: TimelineItem[]

  if (itemIdx >= 0) {
    newItems = [...lastMsg.items]
    newItems[itemIdx] = patch(newItems[itemIdx] as T)
  } else {
    newItems = [...lastMsg.items, factory()]
  }

  const updated = [...messages]
  updated[lastIdx] = { ...lastMsg, items: newItems }
  return updated
}
