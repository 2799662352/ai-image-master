import { deleteObjects } from '../tencent/cosClient'
import { getMpsClient } from '../tencent/mpsClient'

const REAPER_INTERVAL_MS = 5_000

interface ReapEntry {
  inputCosKey: string
}

/**
 * Process-lifetime registry of cancelled-but-still-processing MPS tasks.
 * Periodically polls each entry's DescribeTaskDetail; when terminal (outer
 * Status === 'FINISH'), best-effort deletes the input COS object plus the
 * output if one was produced, then drops the entry. Per spec §8.1 we
 * intentionally do NOT persist this map across restarts — a crashed app
 * leaves orphan COS objects, and the user-configured COS lifecycle (§13.2)
 * is the secondary safety net.
 */
const tracked = new Map<string, ReapEntry>()
let interval: NodeJS.Timeout | null = null
const inflight = new Set<string>()

export function getReapingSize(): number {
  return tracked.size
}

export function trackForReaping(mpsTaskId: string, inputCosKey: string): void {
  if (!mpsTaskId || !inputCosKey) return
  tracked.set(mpsTaskId, { inputCosKey })
  ensureInterval()
}

function ensureInterval(): void {
  if (interval !== null) return
  interval = setInterval(tick, REAPER_INTERVAL_MS)
}

function stopInterval(): void {
  if (interval !== null) {
    clearInterval(interval)
    interval = null
  }
}

function tick(): void {
  const ids = Array.from(tracked.keys())
  for (const mpsTaskId of ids) {
    if (inflight.has(mpsTaskId)) continue
    inflight.add(mpsTaskId)
    void reapOne(mpsTaskId).finally(() => inflight.delete(mpsTaskId))
  }
}

async function reapOne(mpsTaskId: string): Promise<void> {
  const entry = tracked.get(mpsTaskId)
  if (!entry) return

  let resp: any
  try {
    resp = await getMpsClient().DescribeTaskDetail({ TaskId: mpsTaskId })
  } catch (err: any) {
    // Transient API failure — keep the entry, retry next interval.
    console.warn(`[smart-erase/reaper] DescribeTaskDetail failed for ${mpsTaskId}:`, err?.message ?? err)
    return
  }

  // Non-terminal: keep waiting.
  if (resp?.Status !== 'FINISH') return

  // Inner-status defensive check: even with outer FINISH, the typedef permits
  // SmartEraseTaskResult.Status === 'PROCESSING' (mirrors runner behavior).
  // Treat as still-processing and keep entry.
  const innerStatus = resp.WorkflowTask?.SmartEraseTaskResult?.Status
  if (innerStatus === 'PROCESSING') return

  // Terminal: figure out which keys to delete.
  const keys: string[] = [entry.inputCosKey]
  const outputPath: string | undefined = resp.WorkflowTask?.SmartEraseTaskResult?.Output?.Path
  if (outputPath) {
    const outKey = outputPath.replace(/^\/+/, '')
    if (outKey) keys.push(outKey)
  }

  // Remove from tracked BEFORE the delete so a rejection doesn't leave us
  // retrying forever; spec §8.1 says reaping is best-effort.
  tracked.delete(mpsTaskId)
  if (tracked.size === 0) stopInterval()

  try {
    await deleteObjects(keys)
  } catch (err: any) {
    console.warn(`[smart-erase/reaper] deleteObjects failed for ${mpsTaskId}:`, err?.message ?? err)
  }
}

/**
 * Stop the interval and clear the map. Any poll-in-flight is allowed to
 * settle naturally (its `tracked.delete` will no-op on the cleared map).
 */
export async function untrackAndCleanupAll(): Promise<void> {
  tracked.clear()
  stopInterval()
}
