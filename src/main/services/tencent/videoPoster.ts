/**
 * videoPoster — generate a video bubble's still frame ONCE and persist it as a
 * static COS object, so chat never re-runs the *billable* 数据万象「媒体处理」
 * snapshot (`ci-process=snapshot`) on every render.
 *
 * Strategy (idempotent, bill-once-per-video):
 *   1. Derive a deterministic sibling object key `<videoKey>.poster.jpg`.
 *   2. HEAD the static poster URL (bucket is public-read) — if it already
 *      exists, return it with NO processing cost.
 *   3. Otherwise run exactly one `ci-process=snapshot` GET (the only billable
 *      step), then `putObject` the JPEG bytes back to COS under the poster key.
 *   4. Renderers then reference the plain poster object URL (a normal object
 *      GET → no CI processing → no recurring billing), cached client-side so
 *      this whole path runs at most once per video, ever.
 *
 * All I/O is injected (`EnsureVideoPosterDeps`) so this module stays free of
 * `electron` / COS SDK imports and is unit-testable in a plain node env. The
 * snapshot params (`time=1&format=jpg&width=512`) are empirically verified
 * against the live bucket (HTTP 200 image/jpeg, 2026-06-29).
 */

/** Poster snapshot frame width (px). Height auto by aspect ratio. */
const DEFAULT_POSTER_WIDTH = 512

/**
 * Snapshot timestamp (seconds). 1s lands past any fade-in / black first frame
 * for the multi-second clips this app generates. Out-of-range times error, so
 * callers with very short clips can pass `0`.
 */
const DEFAULT_POSTER_TIME = 1

export interface ParsedCosUrl {
  bucket: string
  region: string
  /** Object key (no leading slash, query/hash stripped). */
  key: string
}

const COS_URL_RE = /^https?:\/\/([^./]+)\.cos\.([^./]+)\.myqcloud\.com\/(.+)$/

/** Parse `https://<bucket>.cos.<region>.myqcloud.com/<key>` into its parts. */
export function parseCosUrl(url: string): ParsedCosUrl | null {
  if (typeof url !== 'string' || url.length === 0) return null
  const m = url.match(COS_URL_RE)
  if (!m) return null
  const [, bucket, region, rest] = m
  const key = rest.split('#')[0].split('?')[0].replace(/^\/+/, '')
  if (!key) return null
  return { bucket, region, key }
}

/** Deterministic sibling poster object key for a video key. */
export function posterKeyFor(videoKey: string): string {
  return `${videoKey}.poster.jpg`
}

/** Public URL of the static poster object (a normal GET — no CI processing). */
export function posterUrlFor(parsed: ParsedCosUrl): string {
  return `https://${parsed.bucket}.cos.${parsed.region}.myqcloud.com/${posterKeyFor(parsed.key)}`
}

/** The (billable) 数据万象 snapshot URL. Strips any existing query first. */
export function snapshotUrlFor(
  videoUrl: string,
  width: number = DEFAULT_POSTER_WIDTH,
  timeSec: number = DEFAULT_POSTER_TIME,
): string {
  const base = videoUrl.split('#')[0].split('?')[0]
  const w = Math.max(1, Math.round(width))
  const t = Math.max(0, timeSec)
  return `${base}?ci-process=snapshot&time=${t}&format=jpg&width=${w}`
}

export interface SnapshotResponse {
  ok: boolean
  status: number
  body: Buffer
  contentType?: string
}

export interface EnsureVideoPosterDeps {
  /** HEAD the static poster URL (unsigned, public-read) → already persisted? */
  headExists: (url: string) => Promise<boolean>
  /** GET the CI snapshot — the ONE billable processing call. */
  fetchSnapshot: (url: string) => Promise<SnapshotResponse>
  /** Upload the poster JPEG to COS; resolves to its public URL. */
  upload: (opts: {
    bucket: string
    region: string
    key: string
    body: Buffer
    contentType?: string
  }) => Promise<string>
  /** Optional snapshot frame width / timestamp overrides. */
  width?: number
  timeSec?: number
}

export type EnsureVideoPosterResult =
  | { ok: true; posterUrl: string; generated: boolean }
  | { ok: false; reason: string }

/**
 * Ensure a persisted poster object exists for `videoUrl` and return its static
 * URL. Bills at most one snapshot per video (guarded by the COS HEAD check),
 * and never for non-COS sources.
 */
export async function ensureVideoPoster(
  videoUrl: string,
  deps: EnsureVideoPosterDeps,
): Promise<EnsureVideoPosterResult> {
  const parsed = parseCosUrl(videoUrl)
  if (!parsed) return { ok: false, reason: 'not a COS url' }

  const posterUrl = posterUrlFor(parsed)

  // 1. Idempotency: an existing poster object means zero billing, zero upload.
  try {
    if (await deps.headExists(posterUrl)) {
      return { ok: true, posterUrl, generated: false }
    }
  } catch {
    // HEAD failed (network / proxy) — fall through and (re)generate. Worst case
    // is one extra snapshot, never a broken poster.
  }

  // 2. The single billable snapshot.
  let snap: SnapshotResponse
  try {
    snap = await deps.fetchSnapshot(snapshotUrlFor(videoUrl, deps.width, deps.timeSec))
  } catch (err) {
    return { ok: false, reason: `snapshot fetch failed: ${String(err)}` }
  }
  if (!snap.ok || snap.body.length === 0) {
    return { ok: false, reason: `snapshot http ${snap.status}` }
  }
  if (snap.contentType && !snap.contentType.startsWith('image/')) {
    // A 200 with XML/JSON is a CI business error, not a frame — don't persist it.
    return { ok: false, reason: `snapshot returned ${snap.contentType}` }
  }

  // 3. Persist as a plain static object (future GETs are processing-free).
  try {
    const uploaded = await deps.upload({
      bucket: parsed.bucket,
      region: parsed.region,
      key: posterKeyFor(parsed.key),
      body: snap.body,
      contentType: snap.contentType || 'image/jpeg',
    })
    return { ok: true, posterUrl: uploaded || posterUrl, generated: true }
  } catch (err) {
    return { ok: false, reason: `poster upload failed: ${String(err)}` }
  }
}
