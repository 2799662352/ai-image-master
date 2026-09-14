// 灯箱图片工具条(设计稿 D4)—— 标注 / 评论 / 擦除 / 移除背景 / 调整尺寸 的纯逻辑。
//
// 一切工具最终都收敛成同一件事:「一张带标注的副本」+「一段附加指令」进下一条消息。
// 这与上游 Codex App 的浏览器注释模式同构(截图 + 评论文字随任务发送,见
// openai/codex#28291 对图片预览注释的请求),Codex 协议侧零改动:副本走既有 localImage
// 附件通路,指令是普通文本。
//
// 坐标一律归一化到 0..1(相对图片显示框),这样标注不依赖灯箱的实际缩放,导出到原图
// 分辩率时按比例还原即可。

export type ImageToolMode = 'annotate' | 'comment' | 'erase'

export interface NormPoint {
  x: number
  y: number
}

export interface AnnotationStroke {
  id: string
  /** 圈注 vs 红色擦除区域 */
  kind: 'annotate' | 'erase'
  /** 圈注颜色(调色板 hex);缺省 = 青。擦除笔迹忽略此字段,永远红。 */
  color?: string
  points: NormPoint[]
}

export interface ImageComment {
  id: string
  /** 1-based 编号,与图上的钉一致 */
  n: number
  at: NormPoint
  text: string
}

export interface ResizePreset {
  id: string
  label: string
  /** 进指令的自然语言 */
  instruction: string
}

export type ImageToolAction = { type: 'remove-bg' } | { type: 'resize'; preset: ResizePreset }

export const RESIZE_PRESETS: ResizePreset[] = [
  { id: '1:1', label: '1:1 方形 · 1024×1024', instruction: '改成 1:1 方形(1024×1024)' },
  { id: '16:9', label: '16:9 横版 · 1920×1080', instruction: '改成 16:9 横版(1920×1080)' },
  { id: '9:16', label: '9:16 竖版 · 1080×1920', instruction: '改成 9:16 竖版(1080×1920)' },
  { id: '4:3', label: '4:3 · 1600×1200', instruction: '改成 4:3(1600×1200)' },
  { id: '2K', label: '放大到 2K(保持比例)', instruction: '保持比例放大到 2K 分辨率' },
]

/** 默认青色 = 标注,红色 = 擦除;与抽屉方言一致(青是抽屉唯一强调色,红只给危险/删除语义)。 */
export const STROKE_COLOR: Record<AnnotationStroke['kind'], string> = {
  annotate: '#22d3ee',
  erase: '#f87171',
}

/**
 * 标注调色板(用户要求可选色)。青打头 = 默认;**不含红**——红是擦除笔迹的专属语义,
 * 指令里「红色描出 = 要擦除」不能被一条红色圈注搅浑。label 进指令文字("黄色圈注")。
 */
export const ANNOTATION_COLORS: ReadonlyArray<{ hex: string; label: string }> = [
  { hex: '#22d3ee', label: '青' },
  { hex: '#facc15', label: '黄' },
  { hex: '#4ade80', label: '绿' },
  { hex: '#c084fc', label: '紫' },
  { hex: '#f472b6', label: '粉' },
  { hex: '#ffffff', label: '白' },
  { hex: '#18181b', label: '黑' },
]

/** 一条笔迹实际画出来的颜色:擦除永远红,圈注取自己的色、缺省青。 */
export function strokeColor(stroke: Pick<AnnotationStroke, 'kind' | 'color'>): string {
  if (stroke.kind === 'erase') return STROKE_COLOR.erase
  return stroke.color ?? STROKE_COLOR.annotate
}

/** hex → 「青色」这样的中文名;调色板外的色值原样返回,别硬猜。 */
export function annotationColorName(hex: string): string {
  const hit = ANNOTATION_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())
  return hit ? `${hit.label}色` : hex
}

/** 圈注按颜色分组计数,保持调色板顺序;返回 [颜色名, 数量]。 */
function annotationCountsByColor(strokes: ReadonlyArray<AnnotationStroke>): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const s of strokes) {
    if (s.kind !== 'annotate') continue
    const hex = strokeColor(s).toLowerCase()
    counts.set(hex, (counts.get(hex) ?? 0) + 1)
  }
  const order = ANNOTATION_COLORS.map((c) => c.hex.toLowerCase())
  return [...counts.entries()]
    .sort((a, b) => {
      const ia = order.indexOf(a[0])
      const ib = order.indexOf(b[0])
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib)
    })
    .map(([hex, n]) => [annotationColorName(hex), n])
}

/**
 * 侧栏一行小结:「圈注 3 处(青色 2 · 黄色 1) · 红色擦除 1 处」。单色时不展开括号。
 * 没有笔迹返回 ''。
 */
export function summarizeStrokes(strokes: ReadonlyArray<AnnotationStroke>): string {
  const byColor = annotationCountsByColor(strokes)
  const annotateCount = byColor.reduce((sum, [, n]) => sum + n, 0)
  const eraseCount = strokes.filter((s) => s.kind === 'erase').length
  const parts: string[] = []
  if (annotateCount) {
    parts.push(
      byColor.length === 1
        ? `${byColor[0][0]}圈注 ${annotateCount} 处`
        : `圈注 ${annotateCount} 处(${byColor.map(([name, n]) => `${name} ${n}`).join(' · ')})`,
    )
  }
  if (eraseCount) parts.push(`红色擦除 ${eraseCount} 处`)
  return parts.join(' · ')
}

export const PIN_COLOR = '#67e8f9'

interface RectLike {
  left: number
  top: number
  width: number
  height: number
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** 把客户端坐标映射进图片显示框,归一化并夹到 0..1;零尺寸框返回原点而不是 NaN。 */
export function normalizePoint(clientX: number, clientY: number, rect: RectLike): NormPoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 }
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  }
}

/** 删除一条后编号要连续,图上的钉与列表编号才对得上。 */
export function renumberComments(comments: ReadonlyArray<ImageComment>): ImageComment[] {
  return comments.map((c, i) => ({ ...c, n: i + 1 }))
}

/**
 * 附加指令文本。只写用户真正做过的事:没画就没有「标注」行,没评论就没有编号列表,
 * 全空返回 '' 让调用方知道没东西可发。
 */
export function buildImageFeedbackInstruction(input: {
  imageName: string
  comments: ReadonlyArray<ImageComment>
  strokes: ReadonlyArray<AnnotationStroke>
  action?: ImageToolAction
  /**
   * 真 inpainting 遮罩的附件名(`<stem>.mask.png`)。给了它,擦除那一行就从「描述红色区域」
   * 升级为 generate_image 的 maskImage / referenceImages 调用说明;没给(画布不可用)则回落。
   */
  maskName?: string
}): string {
  const byColor = annotationCountsByColor(input.strokes)
  const annotateCount = byColor.reduce((sum, [, n]) => sum + n, 0)
  const eraseCount = input.strokes.filter((s) => s.kind === 'erase').length
  const hasComments = input.comments.length > 0
  if (!annotateCount && !eraseCount && !hasComments && !input.action) return ''

  // 「青色」/「青色 / 黄色」—— 只点名真用到的颜色,模型才对得上图上的圈。
  const colorNames = byColor.map(([name]) => name).join(' / ')
  const lines: string[] = []
  const legend: string[] = []
  if (annotateCount) legend.push(`${colorNames}圈注 = 需要修改的区域`)
  if (eraseCount) legend.push('红色描出 = 需要擦除的区域')
  if (hasComments) legend.push('编号钉 = 下面的评论位置')
  lines.push(
    `[图片反馈 · ${input.imageName}]` +
      (legend.length ? `(附件是带标注的副本:${legend.join(';')})` : '(附件是这张图)'),
  )
  if (annotateCount) {
    const breakdown = byColor.length > 1 ? `(${byColor.map(([name, n]) => `${name} ${n} 处`).join('、')})` : ''
    lines.push(`标注:已在图上用${colorNames}圈出 ${annotateCount} 处需要修改的区域${breakdown},请按评论逐处处理。`)
  }
  if (eraseCount && input.maskName) {
    // 与 OpenAI /v1/images/edits `mask` 契约一致:带 alpha 的 PNG,alpha=0 = 可重绘;尺寸同原图;
    // 只作用于 image[0];官方口径 prompt-guided —— 提示词先写唯一改动,再列保留项。
    // 擦除绑定 GPT Image 2.5(改图用 sunburst,要快用 flare):目前只有这两档有 mask 局部重绘能力。
    lines.push(
      `擦除(局部重绘):附件 ${input.maskName} 是 alpha 遮罩(透明区域 = 要重绘,尺寸与原图一致)。` +
        `请调用 generate_image:referenceImages=[原图 ${input.imageName}],maskImage=${input.maskName},` +
        `model=gpt-image-2.5-sunburst(画质优先;赶时间可用 gpt-image-2.5-flare);` +
        `prompt 先写「只改透明区域:把这 ${eraseCount} 处的内容抹掉并按周围画面自然补全」,再列出必须保留不变的部分(构图、光线、遮罩外的所有主体)。`,
    )
  } else if (eraseCount) {
    lines.push(`擦除:请把红色描出的 ${eraseCount} 处区域内容抹掉,并按周围画面自然补全(inpainting),其余部分保持不变。`)
  }
  if (hasComments) {
    lines.push('评论:')
    for (const c of input.comments) lines.push(`${c.n}. ${c.text}`)
  }
  if (input.action?.type === 'remove-bg') {
    lines.push('移除背景:请去掉背景、只保留主体,输出透明底 PNG(generate_image 用 transparentBackground=true,以此图为参考图,主体轮廓不要变)。')
  } else if (input.action?.type === 'resize') {
    lines.push(`调整尺寸:请把这张图${input.action.preset.instruction},保留主体与构图,不要裁掉关键内容。(${input.action.preset.label})`)
  }
  return lines.join('\n')
}

/**
 * 把原图 + 标注层合成一张 PNG(原图分辨率)。灯箱里画的是归一化坐标,这里按原图尺寸
 * 还原;圈注按各自颜色画。评论钉画成青色圆 + 编号。返回 null 表示画布不可用(测试环境)。
 */
export async function composeAnnotatedImage(
  image: HTMLImageElement,
  strokes: ReadonlyArray<AnnotationStroke>,
  comments: ReadonlyArray<ImageComment>,
): Promise<Blob | null> {
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  if (!w || !h || typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(image, 0, 0, w, h)

  const lineWidth = Math.max(3, Math.round(Math.min(w, h) / 220))
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue
    ctx.strokeStyle = strokeColor(stroke)
    ctx.lineWidth = stroke.kind === 'erase' ? lineWidth * 2 : lineWidth
    ctx.globalAlpha = stroke.kind === 'erase' ? 0.85 : 1
    ctx.beginPath()
    stroke.points.forEach((p, i) => {
      const x = p.x * w
      const y = p.y * h
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    if (stroke.points.length === 1) {
      const p = stroke.points[0]
      ctx.arc(p.x * w, p.y * h, lineWidth, 0, Math.PI * 2)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  const r = Math.max(12, Math.round(Math.min(w, h) / 60))
  for (const c of comments) {
    const x = c.at.x * w
    const y = c.at.y * h
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fillStyle = PIN_COLOR
    ctx.fill()
    ctx.lineWidth = Math.max(2, Math.round(r / 6))
    ctx.strokeStyle = '#09090B'
    ctx.stroke()
    ctx.fillStyle = '#09090B'
    ctx.font = `700 ${Math.round(r * 1.1)}px "JetBrains Mono", "Exo 2", sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(c.n), x, y + 1)
  }

  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

/** `foo.png` → `foo.标注.png`;没有扩展名就直接加后缀。 */
export function annotatedFileName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}.标注.png`
  return `${name.slice(0, dot)}.标注.png`
}

/** `foo.png` → `foo.mask.png`,与原图同名并列,模型一眼能配对。 */
export function maskFileName(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return `${name}.mask.png`
  return `${name.slice(0, dot)}.mask.png`
}

/**
 * 擦除笔迹 → OpenAI edits 遮罩:与原图**同分辩率**的 PNG,整张不透明,红色笔迹处
 * 用 destination-out 抠成 alpha=0(= 允许重绘)。笔宽按原图短边放大,并比屏幕上看到的
 * 略宽 —— 官方建议透明区域「宁大勿小」,连边缘、阴影一起盖住,模型才好自然补全。
 * 没有擦除笔迹或画布不可用返回 null。
 */
export async function composeEraseMask(
  image: HTMLImageElement,
  strokes: ReadonlyArray<AnnotationStroke>,
): Promise<Blob | null> {
  const erase = strokes.filter((s) => s.kind === 'erase' && s.points.length > 0)
  if (erase.length === 0) return null
  const w = image.naturalWidth || image.width
  const h = image.naturalHeight || image.height
  if (!w || !h || typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'destination-out'
  ctx.strokeStyle = '#000000'
  ctx.fillStyle = '#000000'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const brush = Math.max(24, Math.round(Math.min(w, h) / 40))
  ctx.lineWidth = brush
  for (const stroke of erase) {
    ctx.beginPath()
    stroke.points.forEach((p, i) => {
      const x = p.x * w
      const y = p.y * h
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    if (stroke.points.length === 1) {
      const p = stroke.points[0]
      ctx.arc(p.x * w, p.y * h, brush / 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}
