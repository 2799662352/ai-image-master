import type { AnnotationInstruction, CanvasStatePayload, ShapeSummary } from '../../../../../types/canvas'

export function holderSize(aspectRatio: string, input?: { w?: number; h?: number }): { w: number; h: number } {
  if (input?.w && input?.h) return { w: input.w, h: input.h }
  const [rawW, rawH] = aspectRatio.split(':').map((part) => Number(part))
  if (Number.isFinite(rawW) && Number.isFinite(rawH) && rawW > 0 && rawH > 0) {
    const base = 420
    return { w: base, h: Math.round((base * rawH) / rawW) }
  }
  return { w: 420, h: 588 }
}

export function findPreferredHolder(state: CanvasStatePayload): ShapeSummary | undefined {
  const selectedHolder = state.selection.shapes.find((shape) => shape.role === 'image_holder')
  if (selectedHolder) return selectedHolder
  const holders = state.shapes.filter((shape) => shape.role === 'image_holder')
  if (holders.length === 1) return holders[0]
  return undefined
}

export function generationPrompt(input: { request: string; aspectRatio: string; intendedUse?: string }): string {
  return [
    `请生成一张图片。`,
    ``,
    `用户需求：${input.request}`,
    `画面比例：${input.aspectRatio}`,
    input.intendedUse ? `用途：${input.intendedUse}` : undefined,
    `构图要求：主体明确，适合放入画布继续标注修改。`,
    `文字策略：如果用户要求标题、广告语或字体风格，请把文字作为画面创意的一部分直接设计进图片，充分发挥字体设计和排版能力。`,
    `避免：低清晰度、错乱文字、水印、畸形主体、杂乱背景。`,
  ]
    .filter(Boolean)
    .join('\n')
}

function formatAnnotation(annotation: AnnotationInstruction, index: number): string {
  const region = annotation.region
  return `${index + 1}. 在图片相对区域 x=${region.x.toFixed(2)}, y=${region.y.toFixed(2)}, w=${region.w.toFixed(2)}, h=${region.h.toFixed(2)}：${annotation.instruction}`
}

export function editPrompt(input: { userRequest?: string; annotations: AnnotationInstruction[] }): string {
  const annotationList = input.annotations.length
    ? input.annotations.map(formatAnnotation).join('\n')
    : '没有可靠的结构化标注。请优先保持原图不变，等待用户补充说明。'
  return [
    `基于输入图片进行编辑。保持整体构图、主体位置、光影风格、画面质感和品牌视觉风格不变。`,
    input.userRequest ? `用户补充要求：${input.userRequest}` : undefined,
    ``,
    `请根据以下画布标注进行修改：`,
    annotationList,
    ``,
    `不要改变：`,
    `- 未标注区域。`,
    `- 品牌名和主要标题，除非用户明确要求。`,
    `- 原图整体比例、风格和主体识别度。`,
    ``,
    `输出要求：与原图相同比例；修改自然；如果某条标注意图不明确，优先保持原样。`,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
