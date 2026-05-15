import type { AgentThreadSummary } from '../../../../types/agent'

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Render a short relative time like Cursor's sidebar — "just now", "12m ago", "5h ago", "3d ago", or ISO date. */
export function formatRelativeTime(
  ts: number | string | null | undefined,
  now: number = Date.now(),
): string {
  if (ts == null) return '—'
  const ms = typeof ts === 'string' ? Date.parse(ts) : ts
  if (!Number.isFinite(ms)) return '—'

  const diff = now - ms
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(diff / (60 * 60_000))
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(diff / (24 * 60 * 60_000))
  if (days < 7) return `${days}d ago`
  return new Date(ms).toISOString().slice(0, 10)
}

export interface ThreadGroup {
  label: 'Today' | 'Yesterday' | 'Last 7 days' | 'Older'
  threads: AgentThreadSummary[]
}

/**
 * Bucket threads into Cursor-style sidebar groups by `lastMessageAt`. Threads
 * without `lastMessageAt` always land in `Older` so the active groups stay
 * meaningful. Each bucket preserves the input order (caller is expected to
 * have already sorted by recency).
 */
export function groupThreadsByRecency(
  threads: ReadonlyArray<AgentThreadSummary>,
  now: number = Date.now(),
): ThreadGroup[] {
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 24 * 60 * 60_000
  const weekStart = todayStart - 7 * 24 * 60 * 60_000

  const today: AgentThreadSummary[] = []
  const yesterday: AgentThreadSummary[] = []
  const week: AgentThreadSummary[] = []
  const older: AgentThreadSummary[] = []

  for (const t of threads) {
    const raw = t.lastMessageAt
    const ts = raw == null ? null : Date.parse(raw)
    if (ts == null || !Number.isFinite(ts)) {
      older.push(t)
      continue
    }
    if (ts >= todayStart) today.push(t)
    else if (ts >= yesterdayStart) yesterday.push(t)
    else if (ts >= weekStart) week.push(t)
    else older.push(t)
  }

  const out: ThreadGroup[] = []
  if (today.length) out.push({ label: 'Today', threads: today })
  if (yesterday.length) out.push({ label: 'Yesterday', threads: yesterday })
  if (week.length) out.push({ label: 'Last 7 days', threads: week })
  if (older.length) out.push({ label: 'Older', threads: older })
  return out
}
