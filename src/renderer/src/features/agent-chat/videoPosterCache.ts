/**
 * videoPosterCache — remember which static poster URL belongs to each COS video
 * URL, so a video bubble resolves its still frame WITHOUT calling the main
 * process (and therefore without ever re-triggering the billable 数据万象
 * snapshot) after the first time, across reloads and sessions.
 *
 * The main process (`media:ensure-video-poster`) is the source of truth and is
 * itself idempotent (it HEAD-checks the COS object before billing). This cache
 * is purely a client-side fast path: a hit skips the IPC round-trip entirely.
 *
 * Stored as a single `{ [videoUrl]: posterUrl }` JSON blob in localStorage —
 * both values are short URLs, so even hundreds of entries stay tiny.
 */

const STORAGE_KEY = 'catimation:video-poster:v1'
/** Cap entries so a heavy user can't grow the blob unbounded. */
const MAX_ENTRIES = 500

const mem = new Map<string, string>()
let loaded = false

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return
    const obj = JSON.parse(raw) as unknown
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof v === 'string' && v.length > 0) mem.set(k, v)
      }
    }
  } catch {
    // Corrupt / unavailable storage — start empty; the IPC path still works.
  }
}

function persist(): void {
  try {
    const obj: Record<string, string> = {}
    for (const [k, v] of mem) obj[k] = v
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(obj))
  } catch {
    // Quota / unavailable — best-effort only.
  }
}

/** Cached static poster URL for a COS video URL, or undefined. */
export function getCachedPoster(videoUrl: string): string | undefined {
  if (!videoUrl) return undefined
  load()
  return mem.get(videoUrl)
}

/** Remember the static poster URL for a COS video URL. */
export function setCachedPoster(videoUrl: string, posterUrl: string): void {
  if (!videoUrl || !posterUrl) return
  load()
  // Refresh insertion order so the newest stays when we trim.
  mem.delete(videoUrl)
  mem.set(videoUrl, posterUrl)
  while (mem.size > MAX_ENTRIES) {
    const oldest = mem.keys().next().value
    if (oldest === undefined) break
    mem.delete(oldest)
  }
  persist()
}

/** Test-only: clear in-memory + persisted cache. */
export function __resetVideoPosterCacheForTests(): void {
  mem.clear()
  loaded = false
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
