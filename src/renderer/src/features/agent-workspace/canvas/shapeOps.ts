import { AssetRecordType, Box, type Editor, createBindingId, createShapeId, getSnapshot, toRichText } from 'tldraw'
import type { BlurryShape, Bounds, CanvasStatePayload, ImageShapeListItem, PeripheralShapeCluster, Point, ShapeSummary } from '../../../../../types/canvas'

/**
 * tldraw validates record `meta` with its `jsonValue` validator: a meta object
 * is rejected outright (ValidationError "Expected json serializable value, got
 * object") if ANY value is `undefined`, because `isValidJson(undefined)` is
 * false. Optional fields like `runId`/`assetPath`/`holderId` are frequently
 * absent (e.g. Codex calls create_image_version without a runId), so leaving
 * them as `undefined` makes the whole asset/shape creation throw — which crashes
 * the tldraw React tree and unmounts the editor (surfacing later as "canvas
 * disconnected"/canvas_open timeout). Strip undefined keys before handing meta
 * to createAssets/createShape.
 */
export function cleanMeta<T extends Record<string, unknown>>(meta: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (value !== undefined) out[key] = value
  }
  return out as Partial<T>
}

/**
 * Props for the small "version" arrow drawn from a source image to its edited
 * version. tldraw v5's arrow schema (arrowShapeProps) has NO `text` prop — the
 * AddRichText migration replaced `text` with `richText`, so passing `text`
 * throws ValidationError "At shape(type = arrow).props.text: Unexpected
 * property", which crashes the canvas (Store.put validation → tldraw error
 * boundary → editor unmounts → "canvas disconnected"). The version arrow has no
 * label, so we omit it entirely (a label would need `richText: toRichText(...)`,
 * never `text`). Kept as a pure builder so a unit test can assert we never
 * reintroduce a non-schema prop.
 */
export function buildVersionArrowProps(): Record<string, unknown> {
  return { start: { x: 0, y: 0 }, end: { x: 42, y: 0 }, color: 'blue', size: 's', arrowheadEnd: 'arrow', bend: 0 }
}

export function getBounds(editor: Editor, shape: { id: string; x?: number; y?: number; props?: { w?: number; h?: number } }): Bounds {
  const box = editor.getShapePageBounds(shape.id as never)
  if (box) return { x: box.x, y: box.y, w: box.w, h: box.h }
  return { x: shape.x ?? 0, y: shape.y ?? 0, w: shape.props?.w ?? 160, h: shape.props?.h ?? 120 }
}

export function extractText(editor: Editor, shape: { props?: Record<string, unknown> }): string | undefined {
  const props = shape.props ?? {}
  if (typeof props.text === 'string' && props.text.trim()) return props.text.trim()
  if (typeof props.label === 'string' && props.label.trim()) return props.label.trim()
  // Custom file-card shapes carry their filename in props.title.
  if (typeof props.title === 'string' && props.title.trim()) return props.title.trim()
  const richText = props.richText as { content?: unknown[] } | undefined
  if (!richText) return undefined
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: unknown; content?: unknown[] }
    if (typeof n.text === 'string') parts.push(n.text)
    if (Array.isArray(n.content)) n.content.forEach(visit)
  }
  visit(richText)
  return parts.join('').trim() || undefined
}

export function summarizeShape(editor: Editor, shape: any): ShapeSummary {
  const meta = shape.meta ?? {}
  const bounds = getBounds(editor, shape)
  const summary: ShapeSummary = {
    id: shape.id,
    type: shape.type,
    role: meta.aiCanvasRole,
    bounds,
    text: extractText(editor, shape),
    color: shape.props?.color,
    aspectRatio: meta.aspectRatio,
    version: meta.version,
    parentShapeId: meta.parentShapeId,
    assetPath: meta.assetPath,
    assetUrl: meta.assetUrl,
    meta,
  }
  if (shape.type === 'arrow') {
    const start = shape.props?.start
    const end = shape.props?.end
    if (start && end) {
      summary.arrowStart = { x: (shape.x ?? 0) + start.x, y: (shape.y ?? 0) + start.y }
      summary.arrowEnd = { x: (shape.x ?? 0) + end.x, y: (shape.y ?? 0) + end.y }
    }
  }
  // Focused-snapshot enrichment for images AND videos: resolve the backing
  // tldraw asset so Codex gets the shape's assetId, intrinsic pixel size, src
  // and (when known) an on-disk path — instead of the bare `meta:{}` that left
  // it "able to see the media but unable to get its file path". Mirrors tldraw
  // mcp-app's focused fields. Critically this now covers `video` too: a video
  // shape often carries its local mp4 path only on the backing asset's meta
  // (not the shape meta), so without this fallback canvas_snapshot handed the
  // agent a video with an assetId but no path, forcing it to hunt the disk by
  // filename/size. getAsset is read-only and optional-chained so simpler fakes
  // (and shapes without a linked asset) don't break.
  if (shape.type === 'image' || shape.type === 'video') {
    const assetId = shape.props?.assetId
    if (assetId) summary.assetId = String(assetId)
    const asset = assetId ? (editor.getAsset?.(assetId as never) as { props?: Record<string, unknown>; meta?: Record<string, unknown> } | undefined) : undefined
    if (asset) {
      if (!summary.assetUrl && typeof asset.props?.src === 'string') summary.assetUrl = asset.props.src
      if (typeof asset.props?.w === 'number') summary.imageWidth = asset.props.w
      if (typeof asset.props?.h === 'number') summary.imageHeight = asset.props.h
      if (!summary.assetPath && typeof asset.meta?.assetPath === 'string') summary.assetPath = asset.meta.assetPath
    }
  }
  // Custom file-card (audio/zip/pdf placeholder): the disk path lives in props
  // too — fall back to it so the path survives even if meta was stripped.
  if (shape.type === 'file-card' && !summary.assetPath && typeof shape.props?.assetPath === 'string' && shape.props.assetPath) {
    summary.assetPath = shape.props.assetPath
  }
  // Origin URL — the link counterpart of assetPath, so EVERY way content reaches
  // the canvas exposes its source in canvas_snapshot (the "公用能力"):
  //   • a pasted web link → tldraw makes a `bookmark` (or `embed`) whose
  //     `props.url` is the source of truth regardless of how it was created;
  //   • any shape may also carry `meta.sourceUrl` (e.g. agent-attached links).
  // Reading native `props.url` means no per-entry-point wiring is needed.
  const propsUrl = shape.props?.url
  if (typeof propsUrl === 'string' && propsUrl) {
    summary.sourceUrl = propsUrl
    if (!summary.assetUrl) summary.assetUrl = propsUrl
  } else if (typeof meta.sourceUrl === 'string' && meta.sourceUrl) {
    summary.sourceUrl = meta.sourceUrl
  }
  return summary
}

/**
 * Sanitize a model-supplied shape id (official Agent Starter Kit's
 * `ensureShapeIdExists` idea): the model hallucinates, drops the `shape:`
 * prefix, or references a shape deleted since it last looked. Instead of
 * failing the whole tool call with "not found" and forcing a snapshot→retry
 * round-trip, try to self-heal:
 *   1. exact id,
 *   2. missing `shape:` prefix,
 *   3. unique case-insensitive / suffix match against live page shape ids.
 * Ambiguous or hopeless ids return a structured error carrying nearby
 * candidate ids (+types) so the model can correct itself in ONE step.
 */
export function resolveShapeId(
  editor: Editor,
  rawId: unknown,
  opts: { preferType?: string } = {},
): { ok: true; id: string; corrected: boolean } | { ok: false; error: string } {
  const raw = String(rawId ?? '').trim()
  if (!raw) return { ok: false, error: 'Missing shapeId.' }
  const getShape = (id: string): unknown => {
    try {
      return editor.getShape(id as never)
    } catch {
      return undefined
    }
  }
  if (getShape(raw)) return { ok: true, id: raw, corrected: false }
  if (!raw.startsWith('shape:') && getShape(`shape:${raw}`)) {
    return { ok: true, id: `shape:${raw}`, corrected: true }
  }
  let pageShapes: Array<{ id: string; type?: string }> = []
  try {
    pageShapes = (editor.getCurrentPageShapes() as Array<{ id: string; type?: string }>) ?? []
  } catch {
    pageShapes = []
  }
  const lowered = raw.toLowerCase()
  const matches = pageShapes.filter((s) => {
    const id = String(s.id).toLowerCase()
    return id === lowered || id === `shape:${lowered}` || id.endsWith(lowered) || (lowered.length >= 6 && id.includes(lowered))
  })
  if (matches.length === 1) return { ok: true, id: String(matches[0].id), corrected: true }
  const pool = opts.preferType ? pageShapes.filter((s) => s.type === opts.preferType) : pageShapes
  const candidates = (matches.length > 1 ? matches : pool)
    .slice(0, 6)
    .map((s) => `${s.id} (${s.type ?? 'unknown'})`)
    .join(', ')
  const reason = matches.length > 1 ? `Ambiguous shapeId "${raw}"` : `No shape found for "${raw}"`
  return {
    ok: false,
    error: `${reason}. ${candidates ? `Candidates: ${candidates}.` : 'The canvas has no matching shapes.'} Call canvas_snapshot or list_canvas_images for current ids.`,
  }
}

/** Above this many shapes, canvas_snapshot switches from full summaries to the
 * tiered format (blurry viewport shapes + peripheral clusters). */
export const TIERED_SNAPSHOT_THRESHOLD = 40

const BLURRY_TEXT_MAX = 80

/** Longest inline `data:` URL we let through to the model before replacing it
 * with a short descriptor. Anything above this is pure context poison. */
const DATA_URL_MAX = 256

/**
 * Replace a huge base64 `data:` URL with a short human/model-readable
 * descriptor. The official Agent Starter Kit never sends raw asset payloads to
 * the model (its Blurry/Focused formats carry no src at all) — we keep a stub
 * so the agent still knows an inline asset EXISTS and how to get the pixels.
 */
export function truncateDataUrl(value: string): string {
  if (!value.startsWith('data:') || value.length <= DATA_URL_MAX) return value
  const headEnd = value.indexOf(',')
  const head = headEnd > 0 ? value.slice(5, headEnd) : ''
  const mime = head.split(';')[0] || 'unknown'
  const kb = Math.max(1, Math.round((value.length * 0.75) / 1024))
  return `[inline ${mime} ~${kb}KB omitted — use assetPath or get_canvas_image/get_canvas_video]`
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return truncateDataUrl(value)
  if (Array.isArray(value)) return value.map(sanitizeJsonValue)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitizeJsonValue(v)
    return out
  }
  return value
}

function roundPoint(p: Point): Point {
  return { x: Math.round(p.x), y: Math.round(p.y) }
}

/**
 * Payload hygiene for AGENT-FACING shape summaries (canvas_snapshot full mode,
 * focusedShapes, list/get image tools). summarizeShape itself stays full
 * fidelity because internal consumers (getSelectedVideo upload, annotation
 * export) need the real data: URL; this boundary copy:
 *   - rounds bounds / arrow points (official kit rounds all numbers sent to
 *     the model — sub-pixel floats are token noise),
 *   - replaces multi-MB base64 `assetUrl`s with a short descriptor,
 *   - sanitizes `meta` values the same way (meta.assetUrl mirrors the leak).
 * Without this, ONE generated image echoed ~2MB of base64 into the context.
 */
export function sanitizeSummaryForAgent(summary: ShapeSummary): ShapeSummary {
  const out: ShapeSummary = {
    ...summary,
    bounds: {
      x: Math.round(summary.bounds.x),
      y: Math.round(summary.bounds.y),
      w: Math.round(summary.bounds.w),
      h: Math.round(summary.bounds.h),
    },
  }
  if (out.arrowStart) out.arrowStart = roundPoint(out.arrowStart)
  if (out.arrowEnd) out.arrowEnd = roundPoint(out.arrowEnd)
  if (typeof out.assetUrl === 'string') out.assetUrl = truncateDataUrl(out.assetUrl)
  if (out.meta) out.meta = sanitizeJsonValue(out.meta) as ShapeSummary['meta']
  return out
}

/**
 * Reduce a full ShapeSummary to the compact "blurry" tier (official Agent
 * Starter Kit pattern): integer bounds, truncated text, no `meta` object. The
 * addressing fields the agent needs to drill down (id, assetPath, assetId) are
 * kept so a follow-up get_canvas_image / focusShapeIds call is always possible.
 */
export function toBlurryShape(summary: ShapeSummary): BlurryShape {
  const text = summary.text && summary.text.length > BLURRY_TEXT_MAX ? `${summary.text.slice(0, BLURRY_TEXT_MAX)}…` : summary.text
  const blurry: BlurryShape = {
    id: summary.id,
    type: summary.type,
    bounds: {
      x: Math.round(summary.bounds.x),
      y: Math.round(summary.bounds.y),
      w: Math.round(summary.bounds.w),
      h: Math.round(summary.bounds.h),
    },
  }
  if (summary.role) blurry.role = summary.role
  if (text) blurry.text = text
  if (summary.assetPath) blurry.assetPath = summary.assetPath
  if (summary.assetId) blurry.assetId = summary.assetId
  if (summary.sourceUrl) blurry.sourceUrl = summary.sourceUrl
  return blurry
}

/**
 * Group off-viewport shapes into spatial clusters (the Agent Starter Kit's
 * PeripheralShapeCluster tier). Grid-bucket clustering: shapes whose centers
 * fall in the same `cellSize` grid cell merge into one cluster carrying the
 * union bounds, a count and a type histogram. Deterministic and O(n) — good
 * enough for "there are ~12 images up-left of your viewport" awareness.
 */
export function clusterPeripheralShapes(summaries: ShapeSummary[], cellSize = 1200): PeripheralShapeCluster[] {
  const cells = new Map<string, { minX: number; minY: number; maxX: number; maxY: number; count: number; types: Record<string, number> }>()
  for (const s of summaries) {
    const cx = s.bounds.x + s.bounds.w / 2
    const cy = s.bounds.y + s.bounds.h / 2
    const key = `${Math.floor(cx / cellSize)}:${Math.floor(cy / cellSize)}`
    const cell = cells.get(key)
    if (cell) {
      cell.minX = Math.min(cell.minX, s.bounds.x)
      cell.minY = Math.min(cell.minY, s.bounds.y)
      cell.maxX = Math.max(cell.maxX, s.bounds.x + s.bounds.w)
      cell.maxY = Math.max(cell.maxY, s.bounds.y + s.bounds.h)
      cell.count += 1
      cell.types[s.type] = (cell.types[s.type] ?? 0) + 1
    } else {
      cells.set(key, {
        minX: s.bounds.x,
        minY: s.bounds.y,
        maxX: s.bounds.x + s.bounds.w,
        maxY: s.bounds.y + s.bounds.h,
        count: 1,
        types: { [s.type]: 1 },
      })
    }
  }
  return Array.from(cells.values()).map((cell) => ({
    bounds: {
      x: Math.round(cell.minX),
      y: Math.round(cell.minY),
      w: Math.round(cell.maxX - cell.minX),
      h: Math.round(cell.maxY - cell.minY),
    },
    count: cell.count,
    types: cell.types,
  }))
}

export interface TieredShapesResult {
  detailLevel: 'full' | 'tiered'
  /** Full summaries ('full') or blurry viewport shapes ('tiered'). */
  shapes: ShapeSummary[] | BlurryShape[]
  /** Only in 'tiered': full summaries for selected + focusShapeIds shapes. */
  focusedShapes?: ShapeSummary[]
  /** Only in 'tiered': grouped shapes outside the viewport. */
  peripheralClusters?: PeripheralShapeCluster[]
  /** Only in 'tiered': the viewport used to split in/out. */
  viewportBounds?: Bounds
}

/**
 * Split full shape summaries into the tiered canvas_snapshot format (Agent
 * Starter Kit's Blurry/Focused/Peripheral levels) once a canvas outgrows
 * `threshold` shapes:
 *   - viewport shapes → BlurryShape overview,
 *   - selected + explicitly requested (focusShapeIds) shapes → full summaries,
 *   - off-viewport shapes → PeripheralShapeCluster groups.
 * Below the threshold (or with `full: true`, or when the editor can't report a
 * viewport — e.g. simple fakes) everything is returned in full as before.
 */
export function buildTieredShapes(
  editor: Editor,
  summaries: ShapeSummary[],
  opts: { threshold?: number; full?: boolean; focusShapeIds?: string[]; selectedIds?: string[] } = {},
): TieredShapesResult {
  const threshold = opts.threshold ?? TIERED_SNAPSHOT_THRESHOLD
  const viewport = (editor as unknown as { getViewportPageBounds?: () => Box }).getViewportPageBounds?.()
  if (opts.full || summaries.length <= threshold || !viewport) {
    return { detailLevel: 'full', shapes: summaries.map(sanitizeSummaryForAgent) }
  }
  const focusIds = new Set<string>([...(opts.focusShapeIds ?? []), ...(opts.selectedIds ?? [])])
  const inViewport = (b: Bounds): boolean =>
    b.x + b.w >= viewport.x && b.x <= viewport.x + viewport.w && b.y + b.h >= viewport.y && b.y <= viewport.y + viewport.h
  const focused: ShapeSummary[] = []
  const blurry: BlurryShape[] = []
  const peripheral: ShapeSummary[] = []
  for (const s of summaries) {
    if (focusIds.has(s.id)) {
      focused.push(sanitizeSummaryForAgent(s))
    } else if (inViewport(s.bounds)) {
      blurry.push(toBlurryShape(s))
    } else {
      peripheral.push(s)
    }
  }
  return {
    detailLevel: 'tiered',
    shapes: blurry,
    focusedShapes: focused,
    peripheralClusters: clusterPeripheralShapes(peripheral),
    viewportBounds: { x: Math.round(viewport.x), y: Math.round(viewport.y), w: Math.round(viewport.w), h: Math.round(viewport.h) },
  }
}

export interface CanvasLint {
  kind: 'overlapping-images' | 'empty-holder' | 'degenerate-shape' | 'far-from-origin'
  shapeIds: string[]
  message: string
}

const LINT_MAX = 10

function overlapArea(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Cheap heuristics flagging LIKELY layout problems, attached to canvas_snapshot
 * (the official Agent Starter Kit feeds similar "lints" to its agent). Not
 * validation — just attention hints so the agent (esp. the auto-retouch loop)
 * spots issues without diffing the PNG pixel by pixel:
 *   - overlapping-images: two images covering >25% of the smaller one,
 *   - empty-holder: a dashed holder no inserted image references,
 *   - degenerate-shape: near-zero width/height (probably an accidental write),
 *   - far-from-origin: content stranded >20k px out (easy to lose).
 */
export function buildCanvasLints(summaries: ShapeSummary[]): CanvasLint[] {
  const lints: CanvasLint[] = []
  const images = summaries.filter((s) => s.type === 'image')
  outer: for (let i = 0; i < images.length; i++) {
    for (let j = i + 1; j < images.length; j++) {
      const a = images[i]
      const b = images[j]
      const overlap = overlapArea(a.bounds, b.bounds)
      const smaller = Math.min(a.bounds.w * a.bounds.h, b.bounds.w * b.bounds.h)
      if (smaller > 0 && overlap / smaller > 0.25) {
        lints.push({
          kind: 'overlapping-images',
          shapeIds: [a.id, b.id],
          message: `Images ${a.id} and ${b.id} overlap by >25% of the smaller one.`,
        })
        if (lints.length >= LINT_MAX) break outer
      }
    }
  }
  const filledHolderIds = new Set(summaries.map((s) => s.meta?.holderId).filter(Boolean))
  for (const s of summaries) {
    if (lints.length >= LINT_MAX) break
    if (s.role === 'image_holder' && !filledHolderIds.has(s.id)) {
      lints.push({ kind: 'empty-holder', shapeIds: [s.id], message: `Holder ${s.id} ("${s.text ?? ''}") has no image yet.` })
    }
  }
  for (const s of summaries) {
    if (lints.length >= LINT_MAX) break
    if (s.bounds.w < 2 || s.bounds.h < 2) {
      // text/arrow shapes legitimately report 0-height bounds from fallbacks — only
      // flag media/geo where a degenerate size is clearly wrong.
      if (s.type === 'image' || s.type === 'video' || s.type === 'geo') {
        lints.push({ kind: 'degenerate-shape', shapeIds: [s.id], message: `Shape ${s.id} (${s.type}) has near-zero size (${Math.round(s.bounds.w)}×${Math.round(s.bounds.h)}).` })
      }
    }
  }
  for (const s of summaries) {
    if (lints.length >= LINT_MAX) break
    if (Math.abs(s.bounds.x) > 20000 || Math.abs(s.bounds.y) > 20000) {
      lints.push({ kind: 'far-from-origin', shapeIds: [s.id], message: `Shape ${s.id} sits >20000px from the origin — easy to lose.` })
    }
  }
  return lints.slice(0, LINT_MAX)
}

/** Minimal shape of a tldraw 'file' external-asset handler (what the editor's
 * `externalAssetContentHandlers.file` is / what `registerExternalAssetHandler`
 * takes). Kept structural so this helper stays unit-testable without importing
 * tldraw's editor types. */
type FileAssetInfo = { type: 'file'; file: File; assetId?: unknown }
type FileAssetHandler = (info: FileAssetInfo) => Promise<{ type?: string; meta?: Record<string, unknown> } | undefined>

/**
 * Wrap tldraw's DEFAULT `file` external-asset handler so an OS-desktop-dropped
 * image/video gets a REAL on-disk path baked into `asset.meta.assetPath` at DROP
 * TIME — the AI-Canvas "path at creation" model (their App.tsx always sets
 * meta.assetPath when it creates a shape; OS drops never did, so the path only
 * existed in IndexedDB as an opaque `asset:<id>` ref and the agent had to call
 * get_canvas_video to materialize one on demand).
 *
 * We DELEGATE to the captured default handler instead of reimplementing it, so
 * tldraw keeps doing dimension probing, the IndexedDB upload, video/image
 * detection and the not-allowed/size checks (with the correct toasts/mime opts
 * baked into that closure). Then, best-effort, we persist a disk copy and merge
 * its path into the returned asset's meta. `summarizeShape` + `getSelectedVideo`
 * already read `asset.meta.assetPath`, so the path shows up natively in
 * `canvas_snapshot` afterwards. Capture order is safe: Tldraw.tsx registers the
 * defaults, then the store's onMount, then OUR onMount LAST — so grabbing the
 * existing handler and replacing it cannot lose the default.
 *
 * Failure is non-fatal: if there's no active thread or the disk copy fails, we
 * return the plain default asset unchanged (the clip still lands; on-demand
 * get_canvas_video can still materialize a path later).
 */
export function makeFileAssetHandlerWithDiskPath(
  defaultHandler: FileAssetHandler | null | undefined,
  persist: (file: File, threadId: string) => Promise<string | undefined>,
  getThreadId: () => string | undefined,
): FileAssetHandler {
  return async (info) => {
    const asset = defaultHandler ? await defaultHandler(info) : undefined
    if (!asset || (asset.type !== 'video' && asset.type !== 'image')) return asset
    try {
      const threadId = getThreadId()
      const file = info?.file
      if (threadId && file) {
        const diskPath = await persist(file, threadId)
        if (diskPath) return { ...asset, meta: { ...(asset.meta ?? {}), assetPath: diskPath } }
      }
    } catch {
      // Non-fatal: never block the drop just because the disk copy failed.
    }
    return asset
  }
}

/**
 * Flat, focused index of every image shape on the canvas (borrowed from
 * sora-canvas-mcp's `list_canvas_images`). Read-only + cheap: Codex calls this
 * to discover which `shapeId` to hand `get_canvas_image`, and whether a usable
 * on-disk file already exists (`hasFile`) before paying any export/upload cost.
 */
export function listImageShapes(editor: Editor): { items: ImageShapeListItem[] } {
  const items = editor
    .getCurrentPageShapes()
    .filter((shape: { type?: string }) => shape.type === 'image')
    .map((shape): ImageShapeListItem => {
      const summary = summarizeShape(editor, shape)
      return {
        shapeId: summary.id,
        assetId: summary.assetId ?? null,
        w: Math.round(summary.bounds.w),
        h: Math.round(summary.bounds.h),
        role: summary.role,
        version: summary.version,
        title: summary.meta?.title,
        assetPath: summary.assetPath ?? null,
        // list_canvas_images is agent-facing: never echo a multi-MB data: URL.
        assetUrl: summary.assetUrl ? truncateDataUrl(summary.assetUrl) : null,
        hasFile: Boolean(summary.assetPath),
      }
    })
  return { items }
}

const CAMERA_ANIM_MS = 320

/**
 * Pan (and only if needed, zoom OUT) so the given shapes are visible — ported
 * from tldraw mcp-app's `snapshot.zoomToFitRequestShapes`. After inserting an
 * image/version we frame it so it never lands off-screen, but we NEVER zoom in
 * past the user's current level (that would be jarring) and skip entirely when
 * the shapes are already in view. Fully defensive: any missing camera API (or a
 * non-tldraw fake editor in tests) makes it a silent no-op — framing is
 * best-effort and must never break or block a canvas write.
 */
export function zoomToFitShapes(editor: Editor, shapeIds: string[]): void {
  try {
    if (shapeIds.length === 0) return
    const e = editor as unknown as {
      getViewportPageBounds?: () => Box
      getViewportScreenBounds?: () => Box
      getZoomLevel?: () => number
      setCamera?: (point: { x: number; y: number; z: number }, opts?: unknown) => void
    }
    if (
      typeof e.getViewportPageBounds !== 'function' ||
      typeof e.getViewportScreenBounds !== 'function' ||
      typeof e.getZoomLevel !== 'function' ||
      typeof e.setCamera !== 'function'
    ) {
      return
    }
    const boxes: Box[] = []
    for (const id of shapeIds) {
      const b = editor.getShapePageBounds(id as never)
      if (b) boxes.push(b as Box)
    }
    if (boxes.length === 0) return

    const common = Box.Common(boxes)
    const viewport = e.getViewportPageBounds()
    const contained =
      common.x >= viewport.x &&
      common.y >= viewport.y &&
      common.x + common.w <= viewport.x + viewport.w &&
      common.y + common.h <= viewport.y + viewport.h
    if (contained) return

    const currentZoom = e.getZoomLevel()
    const screen = e.getViewportScreenBounds()
    const inset = 100
    const fitX = common.w > 0 ? (screen.w - inset) / common.w : Number.POSITIVE_INFINITY
    const fitY = common.h > 0 ? (screen.h - inset) / common.h : Number.POSITIVE_INFINITY
    const zoom = Math.min(currentZoom, Math.min(fitX, fitY))
    if (!Number.isFinite(zoom) || zoom <= 0) return

    const cx = common.x + common.w / 2
    const cy = common.y + common.h / 2
    const cameraX = -cx + screen.w / zoom / 2
    const cameraY = -cy + screen.h / zoom / 2
    if (!Number.isFinite(cameraX) || !Number.isFinite(cameraY)) return

    e.setCamera({ x: cameraX, y: cameraY, z: zoom }, { animation: { duration: CAMERA_ANIM_MS } })
  } catch {
    // Camera framing is best-effort; never let it break a canvas write.
  }
}

/**
 * Move the agent's viewport to a region — the action half of the tiered
 * snapshot loop (official Agent Kit's "move its viewport" capability). The
 * blurry overview / peripheralClusters tell the agent WHERE things are; this
 * lets it actually go there, then re-snapshot for full viewport detail.
 * Accepts either explicit page bounds (e.g. a cluster's bounds) or shape ids
 * (union of their page bounds). Unlike zoomToFitShapes this is an explicit
 * navigation request, so it MAY zoom in past the user's current level.
 */
export function focusRegion(
  editor: Editor,
  opts: { shapeIds?: string[]; bounds?: { x: number; y: number; w: number; h: number } },
): { ok: true; viewportBounds: { x: number; y: number; w: number; h: number } } | { ok: false; error: string } {
  let target: { x: number; y: number; w: number; h: number } | undefined
  if (opts.bounds && Number.isFinite(opts.bounds.x) && Number.isFinite(opts.bounds.y)) {
    target = {
      x: opts.bounds.x,
      y: opts.bounds.y,
      w: Math.max(1, Number(opts.bounds.w) || 1),
      h: Math.max(1, Number(opts.bounds.h) || 1),
    }
  } else if (opts.shapeIds && opts.shapeIds.length > 0) {
    // Manual union instead of Box.Common: getShapePageBounds returns plain
    // {x,y,w,h}-compatible objects in tests, and Box.Common needs Box instances.
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    for (const id of opts.shapeIds) {
      const b = editor.getShapePageBounds(id as never)
      if (!b) continue
      minX = Math.min(minX, b.x)
      minY = Math.min(minY, b.y)
      maxX = Math.max(maxX, b.x + b.w)
      maxY = Math.max(maxY, b.y + b.h)
    }
    if (!Number.isFinite(minX)) return { ok: false, error: 'None of the given shapeIds have page bounds.' }
    target = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) }
  }
  if (!target) return { ok: false, error: 'canvas_focus_region needs `bounds` or non-empty `shapeIds`.' }
  editor.zoomToBounds(target, { inset: 48, animation: { duration: CAMERA_ANIM_MS } })
  const vp = editor.getViewportPageBounds()
  return {
    ok: true,
    viewportBounds: { x: Math.round(vp.x), y: Math.round(vp.y), w: Math.round(vp.w), h: Math.round(vp.h) },
  }
}

/** Operations exposed by canvas_arrange — thin names over tldraw's batch layout APIs. */
export type ArrangeOperation =
  | 'align-left'
  | 'align-right'
  | 'align-top'
  | 'align-bottom'
  | 'align-center-horizontal'
  | 'align-center-vertical'
  | 'distribute-horizontal'
  | 'distribute-vertical'
  | 'stack-horizontal'
  | 'stack-vertical'
  | 'pack'

export const ARRANGE_OPERATIONS: readonly ArrangeOperation[] = [
  'align-left',
  'align-right',
  'align-top',
  'align-bottom',
  'align-center-horizontal',
  'align-center-vertical',
  'distribute-horizontal',
  'distribute-vertical',
  'stack-horizontal',
  'stack-vertical',
  'pack',
]

/**
 * Batch layout for the agent (official Agent Kit's align/distribute/stack
 * capability). Without this the agent lays out grids by updating x/y one shape
 * at a time — slow, round-trip heavy, and usually crooked. Wraps tldraw's
 * native alignShapes / distributeShapes / stackShapes / packShapes in one
 * atomic transaction and frames the result.
 */
export function arrangeShapes(
  editor: Editor,
  shapeIds: string[],
  operation: ArrangeOperation,
  gap?: number,
): { ok: true; operation: ArrangeOperation; arrangedCount: number } | { ok: false; error: string } {
  const minimum = operation.startsWith('distribute') ? 3 : 2
  if (shapeIds.length < minimum) {
    return { ok: false, error: `"${operation}" needs at least ${minimum} shapes (got ${shapeIds.length}).` }
  }
  const ids = shapeIds as never[]
  editor.run(() => {
    switch (operation) {
      case 'align-left':
        editor.alignShapes(ids, 'left')
        break
      case 'align-right':
        editor.alignShapes(ids, 'right')
        break
      case 'align-top':
        editor.alignShapes(ids, 'top')
        break
      case 'align-bottom':
        editor.alignShapes(ids, 'bottom')
        break
      case 'align-center-horizontal':
        editor.alignShapes(ids, 'center-horizontal')
        break
      case 'align-center-vertical':
        editor.alignShapes(ids, 'center-vertical')
        break
      case 'distribute-horizontal':
        editor.distributeShapes(ids, 'horizontal')
        break
      case 'distribute-vertical':
        editor.distributeShapes(ids, 'vertical')
        break
      case 'stack-horizontal':
        editor.stackShapes(ids, 'horizontal', gap)
        break
      case 'stack-vertical':
        editor.stackShapes(ids, 'vertical', gap)
        break
      case 'pack':
        editor.packShapes(ids, gap ?? 16)
        break
      default: {
        const exhausted: never = operation
        throw new Error(`Unknown arrange operation: ${String(exhausted)}`)
      }
    }
  })
  zoomToFitShapes(editor, shapeIds)
  return { ok: true, operation, arrangedCount: shapeIds.length }
}

/**
 * Structured single-shape update (official Agent Starter Kit ships dedicated
 * update/move/resize/label actions instead of forcing everything through raw
 * store code). Applies only the given fields; prop writes are guarded by "does
 * this shape type actually have that prop" so a bad request returns a friendly
 * error instead of a tldraw ValidationError crashing the canvas.
 *   - x/y: absolute page position; rotation: DEGREES (converted to radians —
 *     models think in degrees), absolute;
 *   - w/h: shape props when present (geo/image/video/file-card/note…);
 *   - text: richText for shapes with a richText prop (geo/text/note/arrow),
 *     plain `text` prop otherwise, file-card falls back to `title`;
 *   - color: shapes with a `color` prop.
 */
export function updateShapePartial(
  editor: Editor,
  shapeId: string,
  patch: { x?: number; y?: number; w?: number; h?: number; rotation?: number; text?: string; color?: string },
): { ok: true; shape: ShapeSummary } | { ok: false; error: string } {
  const shape = editor.getShape(shapeId as never) as { id: string; type: string; props?: Record<string, unknown> } | undefined
  if (!shape) return { ok: false, error: `No shape found: ${shapeId}` }
  const update: Record<string, unknown> = { id: shape.id, type: shape.type }
  const props: Record<string, unknown> = {}
  const hasProp = (key: string): boolean => shape.props != null && key in shape.props
  let touched = false
  if (Number.isFinite(patch.x)) { update.x = Number(patch.x); touched = true }
  if (Number.isFinite(patch.y)) { update.y = Number(patch.y); touched = true }
  if (Number.isFinite(patch.rotation)) { update.rotation = (Number(patch.rotation) * Math.PI) / 180; touched = true }
  if (Number.isFinite(patch.w) || Number.isFinite(patch.h)) {
    if (!hasProp('w') || !hasProp('h')) {
      return { ok: false, error: `Shape ${shapeId} (${shape.type}) has no w/h props — it cannot be resized this way.` }
    }
    if (Number.isFinite(patch.w)) props.w = Math.max(1, Number(patch.w))
    if (Number.isFinite(patch.h)) props.h = Math.max(1, Number(patch.h))
    touched = true
  }
  if (typeof patch.text === 'string') {
    if (hasProp('richText')) props.richText = toRichText(patch.text)
    else if (hasProp('text')) props.text = patch.text
    else if (hasProp('title')) props.title = patch.text
    else return { ok: false, error: `Shape ${shapeId} (${shape.type}) has no text-like prop to update.` }
    touched = true
  }
  if (typeof patch.color === 'string' && patch.color) {
    if (!hasProp('color')) return { ok: false, error: `Shape ${shapeId} (${shape.type}) has no color prop.` }
    props.color = patch.color
    touched = true
  }
  if (!touched) return { ok: false, error: 'canvas_update_shape: no updatable fields given (x/y/w/h/rotation/text/color).' }
  if (Object.keys(props).length > 0) update.props = props
  editor.run(() => {
    editor.updateShape(update as never)
  })
  const updated = editor.getShape(shapeId as never)
  return { ok: true, shape: sanitizeSummaryForAgent(summarizeShape(editor, updated)) }
}

/**
 * Structured batch delete — the missing destructive counterpart of the insert
 * tools (previously only reachable via raw canvas_exec code). Ids are resolved
 * by the caller (canvasBridge runs resolveShapeId per id), so everything here
 * is known to exist; wrapped in editor.run for a single undo entry.
 */
export function deleteShapesById(
  editor: Editor,
  shapeIds: string[],
): { ok: true; deletedCount: number; deletedIds: string[] } | { ok: false; error: string } {
  if (shapeIds.length === 0) return { ok: false, error: 'canvas_delete_shapes requires at least one shapeId.' }
  editor.run(() => {
    editor.deleteShapes(shapeIds as never[])
  })
  return { ok: true, deletedCount: shapeIds.length, deletedIds: shapeIds }
}

/**
 * Cheap per-shape fingerprint for the "what changed since your last snapshot"
 * diff (the official Agent Starter Kit feeds the agent the user's recent
 * actions; we approximate it by diffing snapshots). Captures identity +
 * geometry + text + version — enough to notice moves/resizes/edits without
 * hashing the whole shape record.
 */
export function fingerprintSummary(s: ShapeSummary): string {
  const b = s.bounds
  return `${s.type}|${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}|${s.text ?? ''}|${s.version ?? ''}`
}

export function fingerprintSummaries(summaries: ShapeSummary[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const s of summaries) map.set(s.id, fingerprintSummary(s))
  return map
}

export interface SnapshotDiff {
  created: string[]
  updated: string[]
  deleted: string[]
}

const DIFF_ID_CAP = 100

/** Diff the previous snapshot's fingerprints against the current summaries.
 * Returns undefined when nothing changed (so the field is omitted entirely). */
export function diffShapeFingerprints(prev: Map<string, string>, current: ShapeSummary[]): SnapshotDiff | undefined {
  const created: string[] = []
  const updated: string[] = []
  const seen = new Set<string>()
  for (const s of current) {
    seen.add(s.id)
    const old = prev.get(s.id)
    if (old === undefined) created.push(s.id)
    else if (old !== fingerprintSummary(s)) updated.push(s.id)
  }
  const deleted: string[] = []
  for (const id of prev.keys()) {
    if (!seen.has(id)) deleted.push(id)
  }
  if (created.length === 0 && updated.length === 0 && deleted.length === 0) return undefined
  return {
    created: created.slice(0, DIFF_ID_CAP),
    updated: updated.slice(0, DIFF_ID_CAP),
    deleted: deleted.slice(0, DIFF_ID_CAP),
  }
}

export function readCanvasState(editor: Editor, base: CanvasStatePayload): CanvasStatePayload {
  const shapes = editor.getCurrentPageShapes().map((shape) => summarizeShape(editor, shape))
  const selectedShapeIds = editor.getSelectedShapeIds().map(String)
  const selectionShapes = shapes.filter((shape) => selectedShapeIds.includes(shape.id))
  return {
    ...base,
    snapshot: getSnapshot(editor.store),
    shapes,
    selection: {
      canvasId: base.canvasId,
      pageId: base.metadata.activePageId,
      selectedShapeIds,
      shapes: selectionShapes,
    },
  }
}

function loadImageDimensions(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ w: image.naturalWidth || 1024, h: image.naturalHeight || 1024 })
    image.onerror = () => reject(new Error(`Could not load image: ${src}`))
    image.src = src
  })
}

/**
 * Probe a video's intrinsic dimensions via a <video> element. Resolves with a
 * 16:9 default on error OR after a timeout — jsdom (tests) and the occasional
 * undecodable src never fire loadedmetadata, and dimension probing must never
 * hang a canvas write.
 */
function loadVideoDimensions(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (dims: { w: number; h: number }): void => {
      if (!done) {
        done = true
        resolve(dims)
      }
    }
    const timer = setTimeout(() => finish({ w: 640, h: 360 }), 4000)
    try {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        clearTimeout(timer)
        finish({ w: video.videoWidth || 640, h: video.videoHeight || 360 })
      }
      video.onerror = () => {
        clearTimeout(timer)
        finish({ w: 640, h: 360 })
      }
      video.src = src
    } catch {
      clearTimeout(timer)
      finish({ w: 640, h: 360 })
    }
  })
}

/**
 * Place a video file on the canvas as a real tldraw `video` shape (asset +
 * shape), so a generated clip (e.g. Seedance) shows up and plays inline — the
 * video counterpart to insertImageIntoHolder. Videos don't use holders; the
 * model gives a path (+optional x/y/w/h). Display size caps the longest edge to
 * 640px (aspect preserved) unless explicit w/h are passed. Same atomic editor.run
 * + zoom-to-fit discipline as the image path.
 */
export async function insertVideo(
  editor: Editor,
  payload: { assetUrl: string; assetPath?: string; videoShapeId?: string; title?: string; x?: number; y?: number; w?: number; h?: number; mimeType?: string },
): Promise<{ videoShapeId: string; bounds: Bounds }> {
  // Skip the probe when the caller already knows the size (also keeps tests fast).
  const natural = payload.w && payload.h ? { w: payload.w, h: payload.h } : await loadVideoDimensions(payload.assetUrl)
  const MAX_EDGE = 640
  let w = payload.w ?? natural.w
  let h = payload.h ?? natural.h
  const longest = Math.max(w, h)
  if (longest > MAX_EDGE) {
    const scale = MAX_EDGE / longest
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const assetId = AssetRecordType.createId()
  const videoShapeId = (payload.videoShapeId ? String(payload.videoShapeId) : createShapeId(`video_${crypto.randomUUID().slice(0, 8)}`)) as never
  const title = String(payload.title ?? 'AI 视频')
  const x = Number(payload.x ?? 100)
  const y = Number(payload.y ?? 100)
  // Atomic: asset + shape in ONE transaction so a rejected record rolls back
  // cleanly instead of leaving a half-written page (same guard as images).
  editor.run(() => {
    editor.createAssets([
      { id: assetId, typeName: 'asset', type: 'video', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: payload.mimeType ?? 'video/mp4', isAnimated: true }, meta: cleanMeta({ assetPath: payload.assetPath }) } as never,
    ])
    editor.createShape({
      id: videoShapeId,
      type: 'video',
      x,
      y,
      props: { assetId, w, h, altText: title },
      meta: cleanMeta({ aiCanvasRole: 'ai_video', assetPath: payload.assetPath, assetUrl: payload.assetUrl, title }),
    } as never)
    editor.bringToFront([videoShapeId])
    editor.select(videoShapeId)
  })
  zoomToFitShapes(editor, [String(videoShapeId)])
  return { videoShapeId: String(videoShapeId), bounds: { x, y, w, h } }
}

/**
 * Drop a free-floating TEXT note onto the canvas (fixed-width, wrapped) — used to
 * surface an AI analysis (e.g. a video-understanding result) right next to its
 * source shape. When `nearShapeId` is given (and no explicit x/y), it lands to
 * the RIGHT of that shape so it reads as a caption for the understood video.
 * tldraw's text shape needs `autoSize:false` + a `w` to WRAP long markdown-ish
 * content instead of stretching into one endless line. Same atomic editor.run +
 * best-effort zoom-to-fit discipline as the media inserts.
 */
export function insertTextNote(
  editor: Editor,
  payload: { text: string; title?: string; nearShapeId?: string; x?: number; y?: number; width?: number; role?: string },
): { shapeId: string; bounds: Bounds } {
  const text = String(payload.text ?? '').trim()
  if (!text) throw new Error('insertTextNote requires non-empty text')
  const title = payload.title && String(payload.title).trim() ? String(payload.title).trim() : undefined
  const body = title ? `${title}\n\n${text}` : text
  let x = typeof payload.x === 'number' ? payload.x : 100
  let y = typeof payload.y === 'number' ? payload.y : 100
  if ((typeof payload.x !== 'number' || typeof payload.y !== 'number') && payload.nearShapeId) {
    const b = editor.getShapePageBounds(payload.nearShapeId as never)
    if (b) {
      x = b.x + b.w + 40
      y = b.y
    }
  }
  const w = typeof payload.width === 'number' && payload.width > 0 ? payload.width : 360
  const shapeId = createShapeId(`note_${crypto.randomUUID().slice(0, 8)}`) as never
  editor.run(() => {
    editor.createShape({
      id: shapeId,
      type: 'text',
      x,
      y,
      props: { richText: toRichText(body), w, autoSize: false, color: 'black', size: 's', textAlign: 'start' },
      meta: cleanMeta({ aiCanvasRole: payload.role ?? 'note', title, sourceShapeId: payload.nearShapeId }),
    } as never)
    editor.bringToFront([shapeId])
    editor.select(shapeId)
  })
  zoomToFitShapes(editor, [String(shapeId)])
  return { shapeId: String(shapeId), bounds: { x, y, w, h: 0 } }
}

/**
 * Drop a PLACEHOLDER card for a file tldraw cannot render as a shape — audio
 * (mp3/wav…), archives, pdf, arbitrary docs. tldraw only makes real shapes for
 * image/video, so without this such files would land NOWHERE and the agent
 * could never see them. Creates our custom `file-card` shape (registered via
 * canvasShapeUtils): a styled card with icon/name/ext/path and, for audio with
 * a loadable src, an inline player. `meta` still carries the on-disk
 * `assetPath` (+ `assetKind`), so `summarizeShape` surfaces the path in
 * canvas_snapshot exactly like a media shape — the agent can e.g. mux an mp3
 * with ffmpeg by reading that path. Atomic editor.run + best-effort
 * zoom-to-fit, same discipline as the media inserts.
 */
export function insertFilePlaceholder(
  editor: Editor,
  payload: { assetPath?: string; assetUrl?: string; title: string; kind: 'audio' | 'file'; x?: number; y?: number },
): { shapeId: string; bounds: Bounds } {
  const title = String(payload.title ?? 'file').trim() || 'file'
  const x = Number(payload.x ?? 100)
  const y = Number(payload.y ?? 100)
  const w = 320
  // Extra row for the inline audio player: either a directly playable src OR a
  // disk path (FileCardShapeUtil resolves paths to blob: via the attachments IPC).
  const playable =
    payload.kind === 'audio' &&
    ((typeof payload.assetUrl === 'string' && /^(data|blob|https?):/.test(payload.assetUrl)) ||
      (typeof payload.assetPath === 'string' && payload.assetPath.length > 0))
  const h = playable ? 128 : 88
  const shapeId = createShapeId(`file_${crypto.randomUUID().slice(0, 8)}`) as never
  editor.run(() => {
    editor.createShape({
      id: shapeId,
      type: 'file-card',
      x,
      y,
      props: { w, h, kind: payload.kind, title, assetPath: payload.assetPath ?? '', assetUrl: payload.assetUrl ?? '' },
      meta: cleanMeta({
        aiCanvasRole: payload.kind === 'audio' ? 'dropped_audio' : 'dropped_file',
        assetKind: payload.kind,
        assetPath: payload.assetPath,
        assetUrl: payload.assetUrl,
        title,
      }),
    } as never)
    editor.bringToFront([shapeId])
    editor.select(shapeId)
  })
  zoomToFitShapes(editor, [String(shapeId)])
  return { shapeId: String(shapeId), bounds: { x, y, w, h } }
}

/** Minimal shape of tldraw's 'files' external-CONTENT handler (`editor
 * .externalContentHandlers.files` / what `registerExternalContentHandler` takes).
 * Structural so the wrapper below stays unit-testable without tldraw types. */
type FilesContentInfo = { type?: 'files'; files: File[]; point?: { x: number; y: number } }
type FilesContentHandler = (info: FilesContentInfo) => Promise<void> | void

/**
 * Wrap tldraw's DEFAULT 'files' content handler so OS-dropped files tldraw can't
 * render (audio/zip/pdf/…) still leave a path-bearing placeholder instead of just
 * a "type not allowed" toast. The default content handler `continue`-skips any
 * file whose mime has no asset util, so those files normally vanish; here we split
 * the drop:
 *   - files tldraw CAN render → delegate to the captured default (which routes
 *     them through the asset handler, so our drop-time `meta.assetPath` stamping
 *     still applies to images/videos),
 *   - everything else → `placeOther` (one placeholder note per file).
 * Capture-then-replace is safe (defaults registered before our onMount). Each
 * `placeOther` is isolated so one failure can't abort the rest of the batch, and
 * an all-supported drop behaves byte-for-byte like stock tldraw.
 */
export function makeFilesContentHandlerWithPlaceholders(
  defaultHandler: FilesContentHandler | null | undefined,
  isHandledByTldraw: (file: File) => boolean,
  placeOther: (file: File, point: { x: number; y: number } | undefined, index: number) => Promise<void>,
): FilesContentHandler {
  return async (info) => {
    const files = info?.files ?? []
    const supported = files.filter((f) => isHandledByTldraw(f))
    const others = files.filter((f) => !isHandledByTldraw(f))
    if (supported.length && defaultHandler) {
      await defaultHandler({ ...info, files: supported })
    }
    let i = 0
    for (const f of others) {
      try {
        await placeOther(f, info?.point, i)
      } catch {
        // Non-fatal: never let one bad placeholder abort the rest of the drop.
      }
      i += 1
    }
  }
}

/**
 * Place a standalone image at an arbitrary page point (NOT inside a holder) —
 * used when the user drags a file from the workspace tree onto the canvas. Same
 * atomic asset+shape transaction + zoom-to-fit as insertImageIntoHolder, but it
 * frames itself at the drop location and caps the longest edge to 512px so a
 * huge source file doesn't swallow the viewport.
 */
export async function insertImageAt(
  editor: Editor,
  payload: { assetUrl: string; assetPath?: string; imageShapeId?: string; title?: string; x?: number; y?: number; w?: number; h?: number; mimeType?: string },
): Promise<{ imageShapeId: string; bounds: Bounds }> {
  const natural = payload.w && payload.h ? { w: payload.w, h: payload.h } : await loadImageDimensions(payload.assetUrl)
  const MAX_EDGE = 512
  let w = payload.w ?? natural.w
  let h = payload.h ?? natural.h
  const longest = Math.max(w, h)
  if (longest > MAX_EDGE) {
    const scale = MAX_EDGE / longest
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const assetId = AssetRecordType.createId()
  const imageShapeId = (payload.imageShapeId ? String(payload.imageShapeId) : createShapeId(`image_${crypto.randomUUID().slice(0, 8)}`)) as never
  const title = String(payload.title ?? 'Image')
  const x = Number(payload.x ?? 100)
  const y = Number(payload.y ?? 100)
  editor.run(() => {
    editor.createAssets([
      { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: payload.mimeType ?? 'image/png', isAnimated: false }, meta: cleanMeta({ assetPath: payload.assetPath }) } as never,
    ])
    editor.createShape({
      id: imageShapeId,
      type: 'image',
      x,
      y,
      props: { assetId, w, h, altText: title },
      meta: cleanMeta({ aiCanvasRole: 'dropped_image', assetPath: payload.assetPath, assetUrl: payload.assetUrl, title }),
    } as never)
    editor.bringToFront([imageShapeId])
    editor.select(imageShapeId)
  })
  zoomToFitShapes(editor, [String(imageShapeId)])
  return { imageShapeId: String(imageShapeId), bounds: { x, y, w, h } }
}

export function createHolder(editor: Editor, payload: Record<string, unknown>): { shapeId: string; bounds: Bounds } {
  const shapeId = (payload.shapeId ? String(payload.shapeId) : createShapeId(`holder_${crypto.randomUUID().slice(0, 8)}`)) as never
  const x = Number(payload.x ?? 100)
  const y = Number(payload.y ?? 100)
  const w = Number(payload.w ?? 403)
  const h = Number(payload.h ?? 567)
  const label = String(payload.label ?? 'AI 图片')
  if (editor.getShape(shapeId)) {
    editor.select(shapeId)
    return { shapeId: String(shapeId), bounds: { x, y, w, h } }
  }
  editor.createShape({
    id: shapeId,
    type: 'geo',
    x,
    y,
    props: { w, h, geo: 'rectangle', dash: 'dashed', color: 'blue', fill: 'none', size: 'm', richText: toRichText(label), align: 'middle', verticalAlign: 'middle' },
    meta: cleanMeta({ aiCanvasRole: 'image_holder', aspectRatio: String(payload.aspectRatio ?? '5:7'), acceptsGeneratedImage: true, title: label }),
  } as never)
  editor.select(shapeId)
  return { shapeId: String(shapeId), bounds: { x, y, w, h } }
}

export async function insertImageIntoHolder(
  editor: Editor,
  payload: { holderShapeId: string; assetUrl: string; assetPath?: string; imageShapeId?: string; title?: string; runId?: string },
): Promise<{ imageShapeId: string; bounds: Bounds; version: number }> {
  const holder = editor.getShape(payload.holderShapeId as never) as any
  if (!holder) throw new Error(`Holder not found: ${payload.holderShapeId}`)
  const bounds = getBounds(editor, holder)
  const natural = await loadImageDimensions(payload.assetUrl)
  const assetId = AssetRecordType.createId()
  const imageShapeId = (payload.imageShapeId ? String(payload.imageShapeId) : createShapeId(`image_${crypto.randomUUID().slice(0, 8)}`)) as never
  const title = String(payload.title ?? holder.meta?.title ?? 'AI 图片')
  // Atomic write: asset + image share ONE transaction. tldraw's editor.run rolls
  // back automatically if any inner create throws (e.g. a schema violation), so a
  // late failure can never leave the store half-written (asset committed, image
  // missing) — the inconsistent state was what bricked the canvas before.
  editor.run(() => {
    editor.createAssets([
      { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: 'image/png', isAnimated: false }, meta: cleanMeta({ assetPath: payload.assetPath, sourceRunId: payload.runId }) } as never,
    ])
    editor.createShape({
      id: imageShapeId,
      type: 'image',
      x: bounds.x,
      y: bounds.y,
      props: { assetId, w: bounds.w, h: bounds.h, altText: title },
      meta: cleanMeta({ aiCanvasRole: 'ai_image', holderId: payload.holderShapeId, sourceRunId: payload.runId, version: 1, assetPath: payload.assetPath, assetUrl: payload.assetUrl, title }),
    } as never)
    editor.bringToFront([imageShapeId])
    editor.select(imageShapeId)
  })
  // Frame the freshly inserted image (camera is not a store transaction, so do
  // it AFTER the atomic run).
  zoomToFitShapes(editor, [String(imageShapeId)])
  return { imageShapeId: String(imageShapeId), bounds, version: 1 }
}

export async function createImageVersion(
  editor: Editor,
  payload: { sourceShapeId: string; assetUrl: string; assetPath?: string; newShapeId?: string; title?: string; runId?: string; version?: number },
): Promise<{ newShapeId: string; version: number; parentShapeId: string }> {
  const source = editor.getShape(payload.sourceShapeId as never) as any
  if (!source) throw new Error(`Source image not found: ${payload.sourceShapeId}`)
  const sourceBounds = getBounds(editor, source)
  const natural = await loadImageDimensions(payload.assetUrl)
  const assetId = AssetRecordType.createId()
  const newShapeId = (payload.newShapeId ? String(payload.newShapeId) : createShapeId(`image_${crypto.randomUUID().slice(0, 8)}`)) as never
  const version = Number(payload.version ?? Number(source.meta?.version ?? 1) + 1)
  const x = sourceBounds.x + sourceBounds.w + 80
  const y = sourceBounds.y
  const title = String(payload.title ?? `AI 图片 v${version}`)
  // Atomic write: asset + new image + version arrow share ONE transaction. This
  // is exactly the regression that bricked the canvas — the arrow create threw
  // AFTER the image was committed, leaving a half-written page. tldraw's
  // editor.run rolls everything back on any inner throw, so the image never
  // lands without its arrow (or vice-versa) and the store stays consistent.
  editor.run(() => {
    editor.createAssets([
      { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: 'image/png', isAnimated: false }, meta: cleanMeta({ assetPath: payload.assetPath, sourceRunId: payload.runId }) } as never,
    ])
    editor.createShape({
      id: newShapeId,
      type: 'image',
      x,
      y,
      props: { assetId, w: sourceBounds.w, h: sourceBounds.h, altText: title },
      meta: cleanMeta({ aiCanvasRole: 'ai_image', holderId: source.meta?.holderId, parentShapeId: payload.sourceShapeId, sourceRunId: payload.runId, version, assetPath: payload.assetPath, assetUrl: payload.assetUrl, title }),
    } as never)
    // Version arrow is BOUND to both images (start→source, end→new) instead of
    // being a floating shape with fixed coords. With bindings, dragging either
    // image keeps the connector attached — mirrors tldraw mcp-app's
    // createArrowBetweenShapes. The static start/end in buildVersionArrowProps()
    // are just initial values the binding resolution overrides.
    const arrowId = createShapeId(`version_arrow_${crypto.randomUUID().slice(0, 8)}`) as never
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: sourceBounds.x + sourceBounds.w + 20,
      y: sourceBounds.y + sourceBounds.h / 2,
      props: buildVersionArrowProps(),
      meta: cleanMeta({ aiCanvasRole: 'version_group', parentShapeId: payload.sourceShapeId }),
    } as never)
    editor.createBindings([
      {
        id: createBindingId(),
        type: 'arrow',
        fromId: arrowId,
        toId: payload.sourceShapeId as never,
        props: { terminal: 'start', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
      },
      {
        id: createBindingId(),
        type: 'arrow',
        fromId: arrowId,
        toId: newShapeId,
        props: { terminal: 'end', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } },
      },
    ] as never)
    editor.select(newShapeId)
  })
  // Frame source + new version (and the connector between them) after the atomic run.
  zoomToFitShapes(editor, [payload.sourceShapeId, String(newShapeId)])
  return { newShapeId: String(newShapeId), version, parentShapeId: payload.sourceShapeId }
}
