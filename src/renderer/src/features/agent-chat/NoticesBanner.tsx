import type { AgentNotice } from '../../../../types/agent'
import { useAgentChatStore } from './store'

/**
 * Renders the transient notice stack the chat panel surfaces from codex
 * `app-server` notifications: configWarning, deprecationNotice, model
 * rerouting, hook lifecycle, and auto-approval review pulses.
 *
 * Visual language:
 *   - `level: 'warning'` → amber, sticky until dismissed
 *   - `level: 'info'` → cyan, dismissible, fades visually but doesn't auto-remove
 *
 * Dedicated x-button per notice so the user can clear them individually.
 */
export function NoticesBanner() {
  const notices = useAgentChatStore((state) => state.notices)
  const dismiss = useAgentChatStore((state) => state.dismissNotice)
  if (notices.length === 0) return null
  return (
    <div className="mb-3 space-y-1.5" role="status" aria-live="polite">
      {notices.map((notice) => (
        <NoticeRow key={notice.id} notice={notice} onDismiss={() => dismiss(notice.id)} />
      ))}
    </div>
  )
}

function NoticeRow({
  notice,
  onDismiss,
}: {
  notice: AgentNotice
  onDismiss: () => void
}): JSX.Element {
  const isWarning = notice.level === 'warning'
  const palette = isWarning
    ? 'border-amber-400/35 bg-amber-500/10 text-amber-50'
    : 'border-cyan-400/25 bg-cyan-500/[0.07] text-cyan-100'
  const labelColor = isWarning ? 'text-amber-200/70' : 'text-cyan-200/70'
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] leading-relaxed ${palette}`}
    >
      <span className={`text-[9px] uppercase tracking-[0.2em] ${labelColor}`}>{labelFor(notice.kind)}</span>
      <span className="min-w-0 flex-1 break-words">{notice.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        className="-mr-0.5 -mt-0.5 shrink-0 rounded p-0.5 text-[11px] leading-none opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </div>
  )
}

function labelFor(kind: AgentNotice['kind']): string {
  switch (kind) {
    case 'configWarning':
      return 'config'
    case 'deprecation':
      return 'deprecated'
    case 'modelRerouted':
      return 'rerouted'
    case 'hookStarted':
      return 'hook'
    case 'hookCompleted':
      return 'hook done'
    case 'autoApprovalReview':
      return 'auto approve'
    case 'autoApprovalReviewCompleted':
      return 'auto approved'
    case 'contextHighWatermark':
      return 'context'
    case 'attachmentSkipped':
      return 'attachment'
    case 'pgliteReset':
      return 'database'
    case 'threadContextReset':
      return 'context reset'
    case 'steerFallback':
      return 'new turn'
  }
}
