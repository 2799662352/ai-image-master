// 草图板(设计稿 D3)的导出与调色板 —— 与 React / tldraw DOM 解耦的纯逻辑,方便测。
import { GeoShapeGeoStyle, type Editor, type TLDefaultColorStyle, type TLGeoShapeGeoStyle } from 'tldraw'

/** 底部 14 个色点 → tldraw 命名色(tldraw 的 DefaultColorStyle 只认这些名字,不认 hex)。 */
export const SKETCH_COLORS: ReadonlyArray<{ style: TLDefaultColorStyle; hex: string; label: string }> = [
  { style: 'black', hex: '#1d1d1d', label: '黑' },
  { style: 'grey', hex: '#9fa8b2', label: '灰' },
  { style: 'red', hex: '#e03131', label: '红' },
  { style: 'light-red', hex: '#ff8787', label: '浅红' },
  { style: 'orange', hex: '#f76707', label: '橙' },
  { style: 'yellow', hex: '#ffc034', label: '黄' },
  { style: 'green', hex: '#099268', label: '绿' },
  { style: 'light-green', hex: '#40c057', label: '浅绿' },
  { style: 'light-blue', hex: '#4dabf7', label: '青' },
  { style: 'blue', hex: '#4263eb', label: '蓝' },
  { style: 'violet', hex: '#ae3ec9', label: '紫' },
  { style: 'light-violet', hex: '#e599f7', label: '浅紫' },
  { style: 'white', hex: '#ffffff', label: '白' },
]

export type SketchTool = 'select' | 'draw' | 'text' | 'geo' | 'arrow' | 'line' | 'eraser'

/** Toolbar pills. 形状 is a split button: its flyout picks among {@link SKETCH_SHAPES}. */
export const SKETCH_TOOLS: ReadonlyArray<{ id: SketchTool; label: string }> = [
  { id: 'select', label: '选择' },
  { id: 'draw', label: '画笔' },
  { id: 'text', label: '文字' },
  { id: 'geo', label: '形状' },
  { id: 'eraser', label: '橡皮' },
]

/** Tools that light up the 形状 pill: geo shapes plus tldraw's arrow and line tools. */
export const SHAPE_TOOLS: ReadonlySet<SketchTool> = new Set<SketchTool>(['geo', 'arrow', 'line'])

/** One entry of the 形状 flyout: either a geo style or a whole tldraw tool. */
export type SketchShapeChoice =
  | { id: string; kind: 'geo'; geo: TLGeoShapeGeoStyle; label: string }
  | { id: string; kind: 'tool'; tool: 'arrow' | 'line'; label: string }

export const SKETCH_SHAPES: ReadonlyArray<SketchShapeChoice> = [
  { id: 'rectangle', kind: 'geo', geo: 'rectangle', label: '矩形' },
  { id: 'ellipse', kind: 'geo', geo: 'ellipse', label: '椭圆' },
  { id: 'triangle', kind: 'geo', geo: 'triangle', label: '三角形' },
  { id: 'diamond', kind: 'geo', geo: 'diamond', label: '菱形' },
  { id: 'star', kind: 'geo', geo: 'star', label: '星形' },
  { id: 'cloud', kind: 'geo', geo: 'cloud', label: '云' },
  { id: 'heart', kind: 'geo', geo: 'heart', label: '心形' },
  { id: 'arrow', kind: 'tool', tool: 'arrow', label: '箭头' },
  { id: 'line', kind: 'tool', tool: 'line', label: '直线' },
]

/**
 * Activate a flyout choice the way tldraw's own toolbar does: geo shapes set the
 * `tldraw:geo` style for the next shapes and switch to the geo tool; arrow /
 * line are their own tools. Returns the tool that is now current.
 */
export function applySketchShape(
  editor: Pick<Editor, 'setStyleForNextShapes' | 'setCurrentTool'>,
  choice: SketchShapeChoice,
): SketchTool {
  if (choice.kind === 'geo') {
    editor.setStyleForNextShapes(GeoShapeGeoStyle, choice.geo)
    editor.setCurrentTool('geo')
    return 'geo'
  }
  editor.setCurrentTool(choice.tool)
  return choice.tool
}

export type SketchStrokeSize = 's' | 'm' | 'l' | 'xl'

/**
 * Stops of the stroke slider, thin → thick. `px` mirrors what tldraw 5.4 draws
 * at zoom 1 — draw stroke = 2 × STROKE_SIZES + 1 → 3 / 4.5 / 6 / 11 — so the
 * preview dot is the real width, not a symbol. tldraw's size style only has
 * these four buckets (a continuous width would need the shape `scale` prop,
 * whose SVG export path scales geometry too), so the slider snaps to them.
 */
export const STROKE_STOPS: ReadonlyArray<{ id: SketchStrokeSize; px: number; label: string }> = [
  { id: 's', px: 3, label: '细' },
  { id: 'm', px: 4.5, label: '中' },
  { id: 'l', px: 6, label: '粗' },
  { id: 'xl', px: 11, label: '特粗' },
]

/** jsdom's Blob has no arrayBuffer(); Response yields the same bytes everywhere. */
export async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Response(blob).arrayBuffer()
}

/** `草图-20260914-100509.png` */
export function sketchFileName(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `草图-${stamp}.png`
}

/**
 * Current page → PNG. Null when the page is empty so the caller can treat
 * "确认" on a blank pad as cancel instead of attaching a white square. White
 * background on purpose: the model reads a sketch better on paper than on a
 * transparent checker, and it matches what the user saw while drawing.
 */
export async function exportSketch(editor: Pick<Editor, 'getCurrentPageShapeIds' | 'toImage'>): Promise<Blob | null> {
  const ids = [...editor.getCurrentPageShapeIds()]
  if (ids.length === 0) return null
  const { blob } = await editor.toImage(ids, { format: 'png', background: true, padding: 32, scale: 2 })
  return blob
}
