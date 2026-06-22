import { AssetRecordType, type Editor, createShapeId, getSnapshot, toRichText } from 'tldraw'
import type { Bounds, CanvasStatePayload, ShapeSummary } from '../../../../../types/canvas'

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
  return summary
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
    meta: { aiCanvasRole: 'image_holder', aspectRatio: String(payload.aspectRatio ?? '5:7'), acceptsGeneratedImage: true, title: label },
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
  editor.createAssets([
    { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: 'image/png', isAnimated: false }, meta: { assetPath: payload.assetPath, sourceRunId: payload.runId } } as never,
  ])
  editor.createShape({
    id: imageShapeId,
    type: 'image',
    x: bounds.x,
    y: bounds.y,
    props: { assetId, w: bounds.w, h: bounds.h, altText: title },
    meta: { aiCanvasRole: 'ai_image', holderId: payload.holderShapeId, sourceRunId: payload.runId, version: 1, assetPath: payload.assetPath, assetUrl: payload.assetUrl, title },
  } as never)
  editor.bringToFront([imageShapeId])
  editor.select(imageShapeId)
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
  editor.createAssets([
    { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: 'image/png', isAnimated: false }, meta: { assetPath: payload.assetPath, sourceRunId: payload.runId } } as never,
  ])
  editor.createShape({
    id: newShapeId,
    type: 'image',
    x,
    y,
    props: { assetId, w: sourceBounds.w, h: sourceBounds.h, altText: title },
    meta: { aiCanvasRole: 'ai_image', holderId: source.meta?.holderId, parentShapeId: payload.sourceShapeId, sourceRunId: payload.runId, version, assetPath: payload.assetPath, assetUrl: payload.assetUrl, title },
  } as never)
  editor.createShape({
    id: createShapeId(`version_arrow_${crypto.randomUUID().slice(0, 8)}`) as never,
    type: 'arrow',
    x: sourceBounds.x + sourceBounds.w + 20,
    y: sourceBounds.y + sourceBounds.h / 2,
    props: { start: { x: 0, y: 0 }, end: { x: 42, y: 0 }, color: 'blue', size: 's', arrowheadEnd: 'arrow', text: '', bend: 0 },
    meta: { aiCanvasRole: 'version_group', parentShapeId: payload.sourceShapeId },
  } as never)
  editor.select(newShapeId)
  return { newShapeId: String(newShapeId), version, parentShapeId: payload.sourceShapeId }
}
