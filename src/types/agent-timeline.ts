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

/**
 * Post-generation save/bookkeeping state for a generated artifact, rendered as
 * a standalone status banner under the thumbnails. Success of the GENERATION
 * is decided by the render alone; this only narrates where the files went.
 * - `pending`: history/file save still running in the background.
 * - `saved`: files persisted; `dir`/`paths` point at the local copies.
 * - `failed`: generation succeeded but local save did not (images still live
 *   in chat + history).
 */
export interface ArtifactSaveInfo {
  status: 'pending' | 'saved' | 'failed'
  dir?: string
  paths?: string[]
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
  /** Save-status banner (codex `generate_image` tool); absent for plain attachments. */
  save?: ArtifactSaveInfo
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

/**
 * Minimum prefix length before a text/reasoning item can be considered a
 * superseded snapshot of a later one. Short openings ("好的。") legitimately
 * repeat across paragraphs and must survive.
 */
export const MIN_SNAPSHOT_PREFIX_LEN = 8

/**
 * Some Responses-API relay gateways (observed live with apiyi, 2026-06-10)
 * stream an assistant message as cumulative SNAPSHOTS: every SSE chunk
 * arrives as a brand-new `agentMessage` item (fresh `msg_*` id) whose content
 * is the FULL text accumulated so far, each preceded by a fresh EMPTY
 * `reasoning` item (fresh `rs_*` id). One real reply produced 130 such pairs
 * in 105s. Treating each snapshot as a separate timeline item stacks the same
 * growing paragraph once per chunk ("对话重复") — no error/willRetry is
 * involved, so the stream-retry trim never fires.
 *
 * Collapses that pattern after `touchedItemId` received content:
 *   1. Any EARLIER same-type text/reasoning item whose content is a full
 *      prefix (≥ {@link MIN_SNAPSHOT_PREFIX_LEN} chars, trailing-whitespace
 *      insensitive) of the touched item's content is a superseded snapshot →
 *      dropped.
 *   2. Empty reasoning items immediately followed by another reasoning item
 *      carry no information (the snapshot pattern emits one per chunk) →
 *      dropped.
 *
 * Returns the original array when nothing changed.
 */
export function dropSupersededStreamItems(
  items: TimelineItem[],
  touchedItemId: string,
): TimelineItem[] {
  let result = items

  const idx = items.findIndex((i) => i.id === touchedItemId)
  if (idx > 0) {
    const target = items[idx]
    if (target.type === 'text' || target.type === 'reasoning') {
      const targetContent = target.content.trimEnd()
      if (targetContent.length >= MIN_SNAPSHOT_PREFIX_LEN) {
        const filtered = items.filter((it, i) => {
          if (i >= idx || it.type !== target.type) return true
          const c = (it as TextItem | ReasoningItem).content.trimEnd()
          return c.length < MIN_SNAPSHOT_PREFIX_LEN || !targetContent.startsWith(c)
        })
        if (filtered.length !== items.length) result = filtered
      }
    }
  }

  const collapsed = result.filter((it, i) => {
    if (it.type !== 'reasoning' || it.content.trim() !== '') return true
    const next = result[i + 1]
    return !(next && next.type === 'reasoning')
  })
  if (collapsed.length !== result.length) result = collapsed

  return result
}

/**
 * Applies {@link dropSupersededStreamItems} to the last assistant message.
 * Returns the original array when nothing changed.
 */
export function dropSupersededStreamItemsInLastMessage(
  messages: Message[],
  touchedItemId: string,
): Message[] {
  if (messages.length === 0) return messages
  const lastIdx = messages.length - 1
  const lastMsg = messages[lastIdx]
  if (lastMsg.role !== 'assistant') return messages
  const next = dropSupersededStreamItems(lastMsg.items, touchedItemId)
  if (next === lastMsg.items) return messages
  const updated = [...messages]
  updated[lastIdx] = { ...lastMsg, items: next }
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
