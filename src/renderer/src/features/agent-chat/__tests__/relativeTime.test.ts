import { describe, expect, it } from 'vitest'
import { formatRelativeTime, groupThreadsByRecency } from '../relativeTime'
import type { AgentThreadSummary } from '../../../../../types/agent'

const NOW = new Date('2026-05-07T15:00:00Z').getTime()

function thread(id: string, lastMessageAt: string | null): AgentThreadSummary {
  return {
    id,
    title: id,
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: lastMessageAt ?? '2026-05-01T00:00:00Z',
    lastMessageAt: lastMessageAt ?? undefined,
  }
}

describe('formatRelativeTime', () => {
  it('renders "just now" for under 60s', () => {
    expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('just now')
  })

  it('renders Nm for under 60min', () => {
    expect(formatRelativeTime(NOW - 12 * 60_000, NOW)).toBe('12m ago')
  })

  it('renders Nh for under 24h', () => {
    expect(formatRelativeTime(NOW - 5 * 60 * 60_000, NOW)).toBe('5h ago')
  })

  it('renders Nd for >= 24h and < 7d', () => {
    expect(formatRelativeTime(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe('3d ago')
  })

  it('renders ISO date for >= 7d', () => {
    const ts = new Date('2026-04-01T00:00:00Z').getTime()
    expect(formatRelativeTime(ts, NOW)).toBe('2026-04-01')
  })

  it('renders "—" for null/undefined timestamps', () => {
    expect(formatRelativeTime(null, NOW)).toBe('—')
    expect(formatRelativeTime(undefined, NOW)).toBe('—')
  })
})

describe('groupThreadsByRecency', () => {
  it('groups threads into Today / Yesterday / Last 7 days / Older buckets', () => {
    const threads = [
      thread('today', new Date(NOW - 1 * 60 * 60_000).toISOString()), // 1h ago
      thread('yesterday', new Date(NOW - 30 * 60 * 60_000).toISOString()), // 30h ago
      thread('week', new Date(NOW - 5 * 24 * 60 * 60_000).toISOString()), // 5 days ago
      thread('older', new Date(NOW - 60 * 24 * 60 * 60_000).toISOString()), // 60 days ago
    ]
    const groups = groupThreadsByRecency(threads, NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Last 7 days', 'Older'])
    expect(groups[0].threads.map((t) => t.id)).toEqual(['today'])
    expect(groups[1].threads.map((t) => t.id)).toEqual(['yesterday'])
    expect(groups[2].threads.map((t) => t.id)).toEqual(['week'])
    expect(groups[3].threads.map((t) => t.id)).toEqual(['older'])
  })

  it('omits empty groups', () => {
    const groups = groupThreadsByRecency([thread('only', new Date(NOW).toISOString())], NOW)
    expect(groups.map((g) => g.label)).toEqual(['Today'])
  })

  it('threads without lastMessageAt fall into "Older"', () => {
    const groups = groupThreadsByRecency([thread('orphan', null)], NOW)
    expect(groups[0].label).toBe('Older')
    expect(groups[0].threads[0].id).toBe('orphan')
  })
})
