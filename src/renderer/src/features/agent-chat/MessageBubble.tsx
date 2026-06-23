import { memo, useCallback, useState } from 'react'
import type { Message } from '../../../../types/agent-timeline'
import { getMessageText } from '../../../../types/agent-timeline'
import { EvidenceStack } from './evidence/EvidenceStack'
import { groupTimelineItemsForChat } from './evidence/evidenceModel'
import { TimelineItemRenderer } from './TimelineItemRenderer'
import { formatRelativeTime } from './relativeTime'
import { useAgentChatStore } from './store'

// Affordance discipline (per ui-ux-pro-max):
//  - Toolbar is always mounted; idle opacity-50 keeps it discoverable
//    without competing with the message text. Card hover lifts to 100%.
//  - User messages render as a *card* (rounded panel, soft border, slight
//    bg) so they read as the user's input — assistant output stays plain
//    so reasoning / file-edit / plan cards still fill the canvas.
//  - 24×24 hit targets, SVG icons (no emojis), focus rings present.

function PencilIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <path d="M11.5 1.5l3 3L5 14H2v-3z" />
      <path d="M9.5 3.5l3 3" />
    </svg>
  )
}
// Per-message timestamp. Relative label ("5m ago") for quick scanning; the
// `title` carries the absolute local time so users can pinpoint when a turn
// (e.g. a generated image) happened. Hidden when no usable timestamp exists
// (createdAt <= 0) so we never render a bogus "1970" stamp.
function MessageTimestamp({ createdAt }: { createdAt: number }) {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return null
  return (
    <time
      dateTime={new Date(createdAt).toISOString()}
      title={new Date(createdAt).toLocaleString()}
      className="text-[10px] tabular-nums tracking-tight text-zinc-500"
    >
      {formatRelativeTime(createdAt)}
    </time>
  )
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="5" y="5" width="8" height="8" rx="1" />
      <path d="M3 11V3a1 1 0 011-1h8" />
    </svg>
  )
}
// Curved-arrow rewind glyph. Reads as "send this back / undo this round"
// — distinct from edit (pencil) and copy (overlapping squares).
function RewindIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5h7a3 3 0 010 6H8" />
      <path d="M5.5 5L3 7.5L5.5 10" />
    </svg>
  )
}

// Memoized so a streaming delta (which rebuilds ONLY the last message object)
// doesn't re-render every prior bubble. The reducer preserves referential
// identity of untouched messages (reduceThreadSlice + upsertItemInLastMessage),
// so prior bubbles get the same `message` ref and skip re-render. The store
// slices this subscribes to (isRunning / editingMessageId) only change at
// turn boundaries, not per-delta. See codex-lag investigation.
function MessageBubbleImpl({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const groups = groupTimelineItemsForChat(message.items)
  const label = isUser ? 'You' : 'Codex'
  const labelClass = isUser ? 'text-cyan-300/80' : 'text-zinc-400'

  const [copied, setCopied] = useState(false)
  const startEditMessage = useAgentChatStore((s) => s.startEditMessage)
  const rewindMessageTurn = useAgentChatStore((s) => s.rewindMessageTurn)
  const isRunning = useAgentChatStore((s) => s.isRunning)
  const editingMessageId = useAgentChatStore((s) => s.editingMessageId)

  const handleCopy = useCallback(async () => {
    const text = getMessageText(message)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard might be blocked */ }
  }, [message])

  const handleEdit = useCallback(() => {
    if (isRunning || !isUser) return
    startEditMessage(message.id)
  }, [startEditMessage, message.id, isRunning, isUser])

  const handleRewind = useCallback(() => {
    if (isRunning || !isUser) return
    rewindMessageTurn(message.id)
  }, [rewindMessageTurn, message.id, isRunning, isUser])

  const editingSomething = Boolean(editingMessageId)

  const toolbarBtn =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-all duration-150'

  // Toolbar: idle opacity-50, card hover -> 100, button hover -> accent.
  const toolbar = (
    <div className="flex items-center gap-0.5 opacity-50 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100">
      {isUser && (
        <button
          type="button"
          aria-label="Edit message (rerun from here)"
          title={editingSomething ? 'Finish current edit first' : 'Edit (rerun from here)'}
          onClick={handleEdit}
          disabled={isRunning || editingSomething}
          className={`${toolbarBtn} text-zinc-400 hover:bg-cyan-400/10 hover:text-cyan-300 focus-visible:ring-1 focus-visible:ring-cyan-300/40 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <PencilIcon className="h-3 w-3" />
        </button>
      )}
      <button
        type="button"
        aria-label={copied ? 'Copied!' : 'Copy message'}
        title={copied ? 'Copied!' : 'Copy'}
        onClick={() => void handleCopy()}
        className={`${toolbarBtn} focus-visible:ring-1 focus-visible:ring-cyan-300/40 ${
          copied
            ? 'text-green-400'
            : 'text-zinc-400 hover:bg-cyan-400/10 hover:text-cyan-300'
        }`}
      >
        <CopyIcon className="h-3 w-3" />
      </button>
      {isUser && (
        <button
          type="button"
          aria-label="Rewind this turn (stash to drawer)"
          title={editingSomething ? 'Finish current edit first' : 'Rewind this turn'}
          onClick={handleRewind}
          disabled={isRunning || editingSomething}
          className={`${toolbarBtn} text-zinc-400 hover:bg-amber-400/15 hover:text-amber-300 focus-visible:ring-1 focus-visible:ring-amber-400/40 disabled:cursor-not-allowed disabled:opacity-40`}
        >
          <RewindIcon className="h-3 w-3" />
        </button>
      )}
    </div>
  )

  // ---- User message: card style (per the user's reference image) ----
  if (isUser) {
    return (
      <article className="group/msg relative mb-4">
        <div className="rounded-lg border border-cyan-400/15 bg-zinc-800/60 px-3 py-2.5 leading-[1.55] transition-colors duration-150 hover:border-cyan-400/30">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <span
                className={
                  'text-[10px] font-medium uppercase tracking-[0.18em] ' + labelClass
                }
              >
                {label}
              </span>
              <MessageTimestamp createdAt={message.createdAt} />
            </div>
            {toolbar}
          </div>
          <div className="text-[13px] text-zinc-100">
            {groups.map((group) =>
              group.type === 'item' ? (
                <TimelineItemRenderer key={group.item.id} item={group.item} />
              ) : (
                <EvidenceStack key={group.items.map((item) => item.id).join(':')} items={group.items} />
              ),
            )}
            {message.items.length === 0 && (
              <span className="italic text-zinc-500">Empty message</span>
            )}
          </div>
        </div>
      </article>
    )
  }

  // ---- Assistant message: plain (cards inside the message do their own work) ----
  return (
    <article className="group/msg relative mb-4 px-1 leading-[1.55]">
      <div className="flex items-center gap-2">
        <div
          className={
            'mb-1 text-[10px] font-medium uppercase tracking-[0.18em] ' + labelClass
          }
        >
          {label}
        </div>
        <span className="mb-1">
          <MessageTimestamp createdAt={message.createdAt} />
        </span>
        <div className="mb-1">{toolbar}</div>
      </div>
      <div className="text-[13px] text-zinc-100">
        {groups.map((group) =>
          group.type === 'item' ? (
            <TimelineItemRenderer key={group.item.id} item={group.item} />
          ) : (
            <EvidenceStack key={group.items.map((item) => item.id).join(':')} items={group.items} />
          ),
        )}
        {message.items.length === 0 && (
          <span className="italic text-zinc-500">Empty message</span>
        )}
      </div>
    </article>
  )
}

export const MessageBubble = memo(MessageBubbleImpl)
