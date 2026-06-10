import type { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import path from 'node:path'
import type { TimelineItem } from '../../types/agent-timeline'

/**
 * One-time cleanup for the stream-retry duplication bug (fixed in v4.3.29,
 * see codexNotificationRouter willRetry forwarding + trimRetriedStreamItems).
 *
 * Before the fix, a Codex stream retry re-streamed the ENTIRE response under
 * new item ids while the failed attempt's partial paragraphs were kept, so
 * `AgentManager.applyAssistantEvent` persisted stacked duplicates into
 * `AgentMessage.items`:
 *
 *   [reasoning-a, text("前缀截断"), reasoning-b, text("前缀截断 + 完整版")]
 *
 * The fix stops NEW duplicates but rows written during the affected window
 * stay dirty. This module rewrites those rows once at startup.
 *
 * Safety properties:
 *   - Only `role: 'assistant'` rows are scanned (user rows use a different
 *     item shape and were never affected).
 *   - Only text/reasoning items are candidates; tool items (shell, fileEdit,
 *     artifact, activity) really executed and are never removed.
 *   - An item is removed ONLY when a LATER item of the SAME type is an exact
 *     match or a strict prefix-extension of it, and the matched prefix is at
 *     least {@link MIN_DUP_MATCH_LEN} chars — short openings like "好的。"
 *     can legitimately repeat and must survive.
 *   - The pass is idempotent, so a crash mid-cleanup is harmless: the marker
 *     is only written after a fully successful pass and the next launch
 *     simply re-runs.
 */
export const MIN_DUP_MATCH_LEN = 8

const DEDUPABLE_TYPES = new Set<TimelineItem['type']>(['text', 'reasoning'])

function contentOf(item: TimelineItem): string | null {
  if (item.type === 'text' || item.type === 'reasoning') {
    return typeof item.content === 'string' ? item.content.trimEnd() : null
  }
  return null
}

function isTimelineItemArray(value: unknown): value is TimelineItem[] {
  return (
    Array.isArray(value) &&
    value.every((v) => v != null && typeof v === 'object' && typeof (v as { type?: unknown }).type === 'string')
  )
}

/**
 * Pure dedup rule. Returns the cleaned array, or `null` when the input is
 * malformed or nothing changed (callers use `null` to skip the DB write).
 */
export function dedupeRetryArtifactItems(items: unknown): TimelineItem[] | null {
  if (!isTimelineItemArray(items)) return null

  const keep = new Array<boolean>(items.length).fill(true)

  for (let i = 0; i < items.length; i++) {
    const type = items[i].type
    if (!DEDUPABLE_TYPES.has(type)) continue
    const earlier = contentOf(items[i])
    if (earlier === null || earlier.length < MIN_DUP_MATCH_LEN) continue

    for (let j = i + 1; j < items.length; j++) {
      if (items[j].type !== type) continue
      const later = contentOf(items[j])
      if (later !== null && later.startsWith(earlier)) {
        // A later same-type item repeats this one verbatim (or extends it):
        // the earlier item is the failed attempt's partial output.
        keep[i] = false
        break
      }
    }
  }

  if (keep.every(Boolean)) return null
  return items.filter((_, idx) => keep[idx])
}

export interface DedupStats {
  scanned: number
  cleaned: number
  itemsRemoved: number
}

/**
 * Scans every assistant message and rewrites rows whose items contain retry
 * artifacts. Per-row failures are logged and skipped so one locked/corrupt
 * row can't abort the whole pass.
 */
export async function cleanupRetriedDuplicates(prisma: PrismaClient): Promise<DedupStats> {
  const rows = await prisma.agentMessage.findMany({
    where: { role: 'assistant' },
    select: { id: true, items: true },
  })

  const stats: DedupStats = { scanned: rows.length, cleaned: 0, itemsRemoved: 0 }

  for (const row of rows) {
    const cleaned = dedupeRetryArtifactItems(row.items)
    if (cleaned === null) continue
    const removed = (row.items as unknown[]).length - cleaned.length
    try {
      await prisma.agentMessage.update({
        where: { id: row.id },
        // Same JSON round-trip as ThreadStore.addMessage: TimelineItem is a
        // tagged union Prisma's InputJsonValue rejects at compile time.
        data: { items: JSON.parse(JSON.stringify(cleaned)) },
      })
      stats.cleaned += 1
      stats.itemsRemoved += removed
    } catch (err) {
      console.warn(`[historyDedup] failed to rewrite message ${row.id}:`, err)
    }
  }

  return stats
}

/**
 * Startup entry point. Runs {@link cleanupRetriedDuplicates} exactly once per
 * install: a marker file is written after the first fully successful pass and
 * checked on subsequent launches. If the pass throws (DB unreachable, …) the
 * marker is NOT written and the next launch retries — the cleanup itself is
 * idempotent so partial progress is never a problem.
 *
 * Returns the stats, or `null` when the marker says the cleanup already ran.
 */
export async function runStartupDedupOnce(opts: {
  prisma: PrismaClient
  markerPath: string
}): Promise<DedupStats | null> {
  const { prisma, markerPath } = opts
  if (fs.existsSync(markerPath)) return null

  const stats = await cleanupRetriedDuplicates(prisma)

  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ completedAt: new Date().toISOString(), ...stats }, null, 2),
  )
  return stats
}
