// 「高级编辑」标注核心 —— 在视频某一帧上画标注,再把「帧 + 标注」拍平成一张图。
//
// 移植自 sora-ui 的 advancedVideoEditFlatten.ts(画布工程)。那边的宿主是 tldraw,
// 保存要建节点连边;这里只留**与宿主无关**的部分:标注模型、绘制、橡皮命中、拍平。
// 写回卡片素材的那一段在 AdvancedVideoEditModal / WorkbenchCard 里,不进这个文件 ——
// 纯函数才好单测,而这些几何计算正是最该被钉住的部分。
//
// 为什么值得有:Seedance 2.5 的 edit_video 是「照着参考图改视频」,而「改哪儿」
// 用嘴说不清楚(「把左边第二个人的衣服换掉」)。在帧上圈一下、标个号,再把这张
// 带标注的图作为参考图发过去,比任何措辞都准。

/** 标注坐标一律是**显示坐标**(canvas 覆盖层的 CSS 像素),拍平时再缩放到视频原始分辨率。 */
export interface AnnotationPoint {
  x: number
  y: number
}

export interface AnnotationRect {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
  color: string
  strokeWidth: number
}

export interface AnnotationStroke {
  kind: 'stroke'
  points: AnnotationPoint[]
  color: string
  strokeWidth: number
}

/** 直线段;`arrowHead` 在末端画一个开口箭头。 */
export interface AnnotationLine {
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  strokeWidth: number
  arrowHead: boolean
}

export interface AnnotationText {
  kind: 'text'
  x: number
  y: number
  text: string
  color: string
  fontSize: number
}

/** 定位钉:水滴形 + 序号,钉尖落在 (x, y)。序号供提示词里「①处换成…」这类指代。 */
export interface AnnotationPin {
  kind: 'pin'
  x: number
  y: number
  index: number
}

export type FrameAnnotation =
  | AnnotationRect
  | AnnotationStroke
  | AnnotationLine
  | AnnotationText
  | AnnotationPin

export type AnnotationToolId = 'rect' | 'brush' | 'arrow' | 'text' | 'eraser' | 'pin'

/** 定位钉固定用青色 —— 它是「位置指代」不是「画笔痕迹」,不跟随调色板。 */
export const PIN_MARKER_COLOR = '#14b8a6'

/** 色板:红 / 橙黄 / 绿 / 浅蓝 / 黑 / 白(与 sora-ui mock 一致)。 */
export const STROKE_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#38bdf8', '#111111', '#ffffff'] as const

export const STROKE_WIDTH = 3
export const MIN_LINE_LENGTH = 8
export const DEFAULT_TEXT = '文字'
export const DEFAULT_FONT_SIZE = 20
/** 橡皮笔尖半径(显示坐标 px)。 */
export const ERASER_RADIUS_PX = 14

export function formatTimestamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}

/** 拍平帧的展示名 / 素材名,例如 `00:04 视频帧标注`。 */
export function frameAnnotationLabel(timeSec: number): string {
  return `${formatTimestamp(timeSec)} 视频帧标注`
}

function distSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx
  const dy = ay - by
  return dx * dx + dy * dy
}

function pointNearSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  radius: number,
): boolean {
  const r2 = radius * radius
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-6) return distSq(px, py, x1, y1) <= r2
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return distSq(px, py, x1 + t * dx, y1 + t * dy) <= r2
}

function paintPinMarker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  index: number,
  scale: number,
): void {
  const r = Math.max(10, 12 * scale)
  const cx = x
  const cy = y - r * 1.65
  ctx.fillStyle = PIN_MARKER_COLOR
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(cx - r * 0.72, cy + r * 0.55)
  ctx.lineTo(cx, y)
  ctx.lineTo(cx + r * 0.72, cy + r * 0.55)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#111111'
  ctx.font = `bold ${Math.max(10, r * 0.95)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(index), cx, cy + 0.5)
}

/**
 * 画一条标注。`sx`/`sy` 是「显示坐标 → 目标画布」的缩放:覆盖层预览传 1,
 * 拍平到视频原始分辨率时传 `视频宽/显示宽`。线宽与字号按均值缩放,
 * 否则非等比时笔画会被拉扁。
 */
export function paintFrameAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: FrameAnnotation,
  sx = 1,
  sy = 1,
): void {
  const scale = (sx + sy) / 2

  if (ann.kind === 'text') {
    const fontSize = Math.max(10, ann.fontSize * scale)
    ctx.fillStyle = ann.color
    ctx.font = `${fontSize}px system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(ann.text || DEFAULT_TEXT, ann.x * sx, ann.y * sy)
    return
  }

  if (ann.kind === 'pin') {
    paintPinMarker(ctx, ann.x * sx, ann.y * sy, ann.index, scale)
    return
  }

  ctx.strokeStyle = ann.color
  ctx.lineWidth = Math.max(1, ann.strokeWidth * scale)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  if (ann.kind === 'rect') {
    ctx.strokeRect(ann.x * sx, ann.y * sy, ann.w * sx, ann.h * sy)
    return
  }

  if (ann.kind === 'stroke') {
    if (ann.points.length < 2) return
    ctx.beginPath()
    ctx.moveTo(ann.points[0].x * sx, ann.points[0].y * sy)
    for (let i = 1; i < ann.points.length; i += 1) {
      ctx.lineTo(ann.points[i].x * sx, ann.points[i].y * sy)
    }
    ctx.stroke()
    return
  }

  if (ann.kind === 'line') {
    const x1 = ann.x1 * sx
    const y1 = ann.y1 * sy
    const x2 = ann.x2 * sx
    const y2 = ann.y2 * sy
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()
    if (ann.arrowHead) {
      const angle = Math.atan2(y2 - y1, x2 - x1)
      const head = Math.max(10, ann.strokeWidth * 4 * scale)
      ctx.beginPath()
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6))
      ctx.moveTo(x2, y2)
      ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6))
      ctx.stroke()
    }
    return
  }

  const exhaustive: never = ann
  void exhaustive
}

/** 橡皮是否命中这条标注。笔画不走这里 —— 它要拆段而不是整删。 */
function shapeHitByEraser(ann: FrameAnnotation, p: AnnotationPoint, r: number): boolean {
  switch (ann.kind) {
    case 'stroke':
      return false
    case 'rect': {
      const { x, y, w, h } = ann
      const band = r + ann.strokeWidth / 2
      return (
        pointNearSegment(p.x, p.y, x, y, x + w, y, band)
        || pointNearSegment(p.x, p.y, x + w, y, x + w, y + h, band)
        || pointNearSegment(p.x, p.y, x + w, y + h, x, y + h, band)
        || pointNearSegment(p.x, p.y, x, y + h, x, y, band)
      )
    }
    case 'line': {
      const band = r + ann.strokeWidth / 2
      return pointNearSegment(p.x, p.y, ann.x1, ann.y1, ann.x2, ann.y2, band)
    }
    case 'text': {
      // 没有 ctx 就量不准文字宽度,按字号估一个包围盒 —— 擦除是模糊操作,够用。
      const label = ann.text || DEFAULT_TEXT
      const approxW = Math.max(24, label.length * ann.fontSize * 0.6)
      const approxH = ann.fontSize + 4
      return (
        p.x >= ann.x - r && p.x <= ann.x + approxW + r
        && p.y >= ann.y - r && p.y <= ann.y + approxH + r
      )
    }
    case 'pin': {
      // 钉尖与钉头都算命中:用户多半冲着看得见的那个圆去擦。
      const tipR = Math.max(r, 16)
      const markerCy = ann.y - 12 * 1.65
      return (
        distSq(p.x, p.y, ann.x, ann.y) <= tipR * tipR
        || distSq(p.x, p.y, ann.x, markerCy) <= tipR * tipR
      )
    }
    default: {
      const exhaustive: never = ann
      return exhaustive
    }
  }
}

/** 笔画按点擦除:命中的点删掉,剩下的连续段各自成为一条新笔画。 */
function eraseStrokeAtPoint(ann: AnnotationStroke, p: AnnotationPoint, r: number): AnnotationStroke[] {
  const r2 = r * r
  const pts = ann.points
  if (pts.length === 0) return []

  const remove = new Array<boolean>(pts.length).fill(false)
  for (let i = 0; i < pts.length; i += 1) {
    if (distSq(pts[i].x, pts[i].y, p.x, p.y) <= r2) remove[i] = true
  }
  // 线段命中也要擦:采样点稀疏时,橡皮可能落在两点之间而一个点都没碰到。
  for (let i = 0; i < pts.length - 1; i += 1) {
    if (pointNearSegment(p.x, p.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, r)) {
      remove[i] = true
      remove[i + 1] = true
    }
  }

  const segments: AnnotationStroke[] = []
  let run: AnnotationPoint[] = []
  const flush = (): void => {
    if (run.length > 1) segments.push({ ...ann, points: run })
    run = []
  }
  for (let i = 0; i < pts.length; i += 1) {
    if (!remove[i]) run.push(pts[i])
    else flush()
  }
  flush()
  return segments
}

/** 删掉钉之后重新编号,让序号始终是连续的 1..n —— 提示词里按序号指代,断号会指错。 */
export function renumberPins(annotations: readonly FrameAnnotation[]): FrameAnnotation[] {
  let n = 0
  return annotations.map((a) => {
    if (a.kind !== 'pin') return a
    n += 1
    return a.index === n ? a : { ...a, index: n }
  })
}

/**
 * 在一点擦除:笔画拆段,矩形/线/文字/钉命中即整删。
 * 什么都没擦到时**返回原数组引用** —— 橡皮是逐 pointermove 调的,
 * 每次都造新数组会让 React 白重渲染一整轮。
 */
export function eraseAnnotationsAtPoint(
  annotations: readonly FrameAnnotation[],
  p: AnnotationPoint,
  r: number,
): readonly FrameAnnotation[] {
  const out: FrameAnnotation[] = []
  let changed = false
  for (const ann of annotations) {
    if (ann.kind === 'stroke') {
      const parts = eraseStrokeAtPoint(ann, p, r)
      if (parts.length !== 1 || parts[0].points.length !== ann.points.length) changed = true
      out.push(...parts)
      continue
    }
    if (shapeHitByEraser(ann, p, r)) {
      changed = true
      continue
    }
    out.push(ann)
  }
  if (!changed) return annotations
  return renumberPins(out)
}

/**
 * 读时长。COS / 跨域流常见 `duration === Infinity`,回退到 seekable 末端;
 * 都读不到返回 0(调用方据此禁用进度条,而不是画一条永远拖不动的)。
 */
export function readVideoDuration(video: HTMLVideoElement): number {
  const d = video.duration
  if (Number.isFinite(d) && d > 0) return d
  try {
    if (video.seekable && video.seekable.length > 0) {
      const end = video.seekable.end(video.seekable.length - 1)
      if (Number.isFinite(end) && end > 0) return end
    }
  } catch {
    // 某些状态下访问 seekable 会抛,当作读不到
  }
  return 0
}

function seekVideo(video: HTMLVideoElement, timeSec: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener('seeked', onSeeked)
      video.removeEventListener('error', onError)
    }
    const onSeeked = (): void => {
      cleanup()
      resolve()
    }
    const onError = (): void => {
      cleanup()
      reject(new Error('视频 seek 失败'))
    }
    video.addEventListener('seeked', onSeeked)
    video.addEventListener('error', onError)
    try {
      video.currentTime = timeSec
    } catch (err) {
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

export interface FlattenFrameArgs {
  video: HTMLVideoElement
  /** 覆盖层的 CSS 显示尺寸 —— 标注坐标就在这个空间里。 */
  displayWidth: number
  displayHeight: number
  annotations: readonly FrameAnnotation[]
  timeSec: number
}

/** 拍平结果:图本体 + **实际出图尺寸**(界面用它把「多少像素」摆给用户看)。 */
export interface FlattenedFrame {
  dataUrl: string
  width: number
  height: number
}

/**
 * 编码质量。0.92 → 0.95 是因为这张图不是普通照片:上面叠着标注的硬边(线条、
 * 箭头、文字、定位钉),而 JPEG 恰恰在硬边周围产生振铃,看起来就是「标注糊了」。
 * 提到 0.95 体积大约 +30%,但素材现在是转存到 COS 的(不再内联进请求),这点体积
 * 无关紧要。**不用 PNG**:底子是视频帧,照片内容做无损只会白白胖到几 MB。
 */
const FRAME_JPEG_QUALITY = 0.95

/**
 * 抽当前帧 + 画标注 → JPEG。**按视频原始分辨率**出图,不是按预览尺寸:
 * 这张图要当参考图发给上游,分辨率掉一半等于白标。
 *
 * 也就是说清晰度的上限是**源视频本身** —— 720p 的片子抽出来就是 1280×720,这里
 * 没有任何地方会再降一档。觉得不够清楚就得换更高分辨率的源视频;放大是无中生有,
 * 只会得到一张更大的糊图。返回值带上尺寸就是为了让这件事一眼可见。
 *
 * 跨域视频会让 canvas 被污染、`toDataURL` 抛 SecurityError。这里把它翻译成人话
 * 再抛 —— 原始报错只有一句 "Tainted canvases may not be exported",用户无从下手。
 */
export async function flattenAnnotatedFrameToDataUrl(
  args: FlattenFrameArgs,
): Promise<FlattenedFrame> {
  const { video, displayWidth, displayHeight, annotations, timeSec } = args
  // readyState < 2 = 连当前帧的数据都还没有,drawImage 会画出一片空白。
  if (video.readyState < 2) throw new Error('视频尚未就绪，无法抽帧')

  const duration = Number.isFinite(video.duration) ? video.duration : timeSec
  const target = Math.max(0, Math.min(timeSec, duration))
  // 容差 40ms ≈ 一帧:已经停在这儿就别再 seek 一次,那会多等一个 seeked 往返。
  if (Math.abs(video.currentTime - target) > 0.04) await seekVideo(video, target)

  const vw = video.videoWidth || Math.round(displayWidth)
  const vh = video.videoHeight || Math.round(displayHeight)
  if (vw < 2 || vh < 2) throw new Error('无法读取视频尺寸')

  const canvas = document.createElement('canvas')
  canvas.width = vw
  canvas.height = vh
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 不可用')

  ctx.drawImage(video, 0, 0, vw, vh)

  const sx = vw / Math.max(1, displayWidth)
  const sy = vh / Math.max(1, displayHeight)
  for (const ann of annotations) paintFrameAnnotation(ctx, ann, sx, sy)

  try {
    return { dataUrl: canvas.toDataURL('image/jpeg', FRAME_JPEG_QUALITY), width: vw, height: vh }
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'SecurityError') {
      throw new Error('该视频来自外部地址且未开放跨域，浏览器不允许抽帧。把它下载到本地再拖进卡片即可。')
    }
    throw err instanceof Error ? err : new Error(String(err))
  }
}
