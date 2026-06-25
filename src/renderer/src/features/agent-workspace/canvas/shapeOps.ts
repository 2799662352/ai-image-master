import { AssetRecordType, Box, type Editor, createBindingId, createShapeId, getSnapshot, toRichText } from 'tldraw'
import type { Bounds, CanvasStatePayload, ImageShapeListItem, ShapeSummary } from '../../../../../types/canvas'

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
  return summary
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
        assetUrl: summary.assetUrl ?? null,
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
