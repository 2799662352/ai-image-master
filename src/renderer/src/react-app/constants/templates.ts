export interface TemplateData {
  key: string
  displayName: string
  desc: string
  icon: string
  prefix: string
  suffix: string
  negative: string
  negativeEnabled: boolean
}

export const BUILTIN_TEMPLATES: TemplateData[] = [
  { key: 'anime', displayName: '日式动画', desc: 'TV anime 赛璐璐着色', icon: '🎌', prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ', suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring', negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality', negativeEnabled: false },
  { key: 'manga', displayName: '黑白漫画', desc: '网点纸 + 动态线条', icon: '📖', prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ', suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout', negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render', negativeEnabled: false },
  { key: 'movie', displayName: '电影分镜', desc: '电影级光影景深', icon: '🎬', prefix: 'cinematic storyboard, film still, movie scene, cinematography, ', suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading', negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality', negativeEnabled: false },
  { key: 'webtoon', displayName: '韩式条漫', desc: '全彩柔和竖版', icon: '📱', prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ', suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere', negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome', negativeEnabled: false },
  { key: 'comic', displayName: '美漫风格', desc: '粗线条网点动作感', icon: '💥', prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ', suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene', negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading', negativeEnabled: false },
  { key: 'illustration', displayName: '插画风格', desc: '精细艺术插画', icon: '🎨', prefix: 'illustration, detailed artwork, artistic composition, ', suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration', negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background', negativeEnabled: false },
  { key: 'cinematic', displayName: '影院级写实', desc: '8K 写实自然景深', icon: '🎥', prefix: 'Cinematic Contact Sheet, award-winning trailer storyboard, precise grid layout with equal panels. Symmetrical grid, hard borders, clean white dividing lines. ', suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field, deeper DoF in wides shallower in close-ups with natural bokeh', negative: 'text, speech bubbles, dialogue, watermark, blurry, low quality, inconsistent characters', negativeEnabled: false },
  { key: 'theatrical', displayName: '剧场版动画', desc: '剧场版品质电影级', icon: '🎭', prefix: '((劇場版クオリティのスクリーンショット:1.5)), ((TVアニメの没入感:1.4)), ', suffix: ', 高品質, 8k, masterpiece, best quality, absurdres, cinematic lighting, highly detailed, depth of field, anime screencap', negative: '低品質, 作画崩壊, 実写, 3D, 異なる画風', negativeEnabled: false },
]

export const TEMPLATE_MAP = Object.fromEntries(
  BUILTIN_TEMPLATES.map((t) => [t.key, t])
) as Record<string, TemplateData>

export function getStyleInstructions(templateKey: string | null): string {
  if (!templateKey) return ''
  const t = TEMPLATE_MAP[templateKey]
  if (!t) return ''
  return `${t.prefix}[SUBJECT]${t.suffix}`
}
