import type { AgentStreamEvent } from '../../types/agent'

export interface TurnNotification {
  title: string
  body: string
  threadId?: string
  outcome: 'completed' | 'failed'
}

export interface TurnNotifierDeps {
  /** Session-config gate (`notifyOnTurnComplete`); read per event so panel toggles apply live. */
  isEnabled: () => boolean
  /** Focused windows suppress the toast — same rule as the official Codex desktop app. */
  isWindowFocused: () => boolean
  notify: (notification: TurnNotification) => void
}

/** Body text is capped so a long provider error doesn't overflow the toast. */
const MAX_BODY_LENGTH = 120

/**
 * Turn-terminal system notifications (batch 3-A,
 * docs/plans/2026-07-19-turn-notifications-and-send-status.md).
 *
 * Mirrors the official Codex desktop app's approach (openai/codex#13019):
 * the CLIENT listens for terminal turn events and raises its own OS
 * notification; codex's `notify` hook / `tui.notifications` are CLI/TUI-only
 * and deliberately not used.
 *
 * Event mapping:
 * - `turn_completed`        → "回合完成" toast
 * - `error` (!willRetry)    → "回合失败" toast with the error message
 * - `cancelled`             → silent (the user pressed Stop themselves)
 * - `error` (willRetry)     → silent (backend is auto-retrying; turn still runs)
 */
export class TurnNotifier {
  constructor(private readonly deps: TurnNotifierDeps) {}

  handleEvent(event: AgentStreamEvent): void {
    const notification = this.toNotification(event)
    if (!notification) return
    if (!this.deps.isEnabled()) return
    if (this.deps.isWindowFocused()) return
    this.deps.notify(notification)
  }

  private toNotification(event: AgentStreamEvent): TurnNotification | null {
    if (event.type === 'turn_completed') {
      return {
        title: 'Codex 回合完成',
        body: '任务已完成,点击查看结果。',
        ...(event.threadId ? { threadId: event.threadId } : {}),
        outcome: 'completed',
      }
    }
    if (event.type === 'error' && event.willRetry !== true) {
      return {
        title: 'Codex 回合失败',
        body: truncate(event.error, MAX_BODY_LENGTH),
        ...(event.threadId ? { threadId: event.threadId } : {}),
        outcome: 'failed',
      }
    }
    return null
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
