import type { AgentThreadSummary } from '../../../../types/agent'

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Timestamp in any shape we meet → epoch ms (NaN when unparseable). Rows from
 * `listThreads` arrive with real `Date`s (structured clone keeps Prisma
 * DateTimes); optimistic store patches write ISO strings; tests pass numbers.
 * `Number.isFinite(new Date())` is false, so a Date must be unwrapped first —
 * that is why every sidebar row used to read "—".
 */
function toEpochMs(ts: unknown): number {
  if (ts instanceof Date) return ts.getTime()
  if (typeof ts === 'number') return ts
  if (typeof ts === 'string') return Date.parse(ts)
  return Number.NaN
}

/** Render a short relative time like Cursor's sidebar — "just now", "12m ago", "5h ago", "3d ago", or ISO date. */
export function formatRelativeTime(
  ts: number | string | Date | null | undefined,
  now: number = Date.now(),
): string {
  if (ts == null) return '—'
  const ms = toEpochMs(ts)
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
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Last 7 days' | 'Older'
  threads: AgentThreadSummary[]
}

/**
 * `pinnedAt` as epoch ms, or NaN when not pinned. Prisma `DateTime` columns
 * cross the main→renderer IPC boundary via structured clone, so they arrive as
 * real `Date` objects — while the optimistic store patch writes an ISO string.
 * Both must count, or a pin "works" until the very next list refresh.
 */
export function pinnedAtMs(thread: Pick<AgentThreadSummary, 'pinnedAt'>): number {
  return toEpochMs(thread.pinnedAt)
}

/** `pinnedAt` parses to a real timestamp → pinned. Null/absent/garbage → not. */
export function isThreadPinned(thread: Pick<AgentThreadSummary, 'pinnedAt'>): boolean {
  return Number.isFinite(pinnedAtMs(thread))
}

/**
 * Bucket threads into Cursor-style sidebar groups. Pinned threads (`pinnedAt`)
 * come first as their own group, most recently pinned first, and are removed
 * from the recency buckets so a pin never shows twice. The rest bucket by
 * `lastMessageAt`; threads without it always land in `Older` so the active
 * groups stay meaningful. Each recency bucket preserves the input order
 * (caller is expected to have already sorted by recency).
 */
export function groupThreadsByRecency(
  threads: ReadonlyArray<AgentThreadSummary>,
  now: number = Date.now(),
): ThreadGroup[] {
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - 24 * 60 * 60_000
  const weekStart = todayStart - 7 * 24 * 60 * 60_000

  const pinned: AgentThreadSummary[] = []
  const today: AgentThreadSummary[] = []
  const yesterday: AgentThreadSummary[] = []
  const week: AgentThreadSummary[] = []
  const older: AgentThreadSummary[] = []

  for (const t of threads) {
    if (isThreadPinned(t)) {
      pinned.push(t)
      continue
    }
    const raw = t.lastMessageAt
    const ts = raw == null ? null : toEpochMs(raw)
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
  if (pinned.length) {
    pinned.sort((a, b) => pinnedAtMs(b) - pinnedAtMs(a))
    out.push({ label: 'Pinned', threads: pinned })
  }
  if (today.length) out.push({ label: 'Today', threads: today })
  if (yesterday.length) out.push({ label: 'Yesterday', threads: yesterday })
  if (week.length) out.push({ label: 'Last 7 days', threads: week })
  if (older.length) out.push({ label: 'Older', threads: older })
  return out
}
