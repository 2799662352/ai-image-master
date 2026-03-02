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

type EditableTemplateFields = Pick<TemplateData, 'prefix' | 'suffix' | 'negative' | 'negativeEnabled'>

const TEMPLATE_OVERRIDES_STORAGE_KEY = 'director.template-overrides.v1'

export const BUILTIN_TEMPLATES: TemplateData[] = [
  { key: 'anime', displayName: '日式动画', desc: 'TV anime 赛璐璐着色', icon: '🎌', prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ', suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring', negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality', negativeEnabled: false },
  { key: 'manga', displayName: '黑白漫画', desc: '网点纸 + 动态线条', icon: '📖', prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ', suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout', negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render', negativeEnabled: false },
  { key: 'movie', displayName: '电影分镜', desc: '电影级光影景深', icon: '🎬', prefix: 'cinematic storyboard, film still, movie scene, cinematography, ', suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading', negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality', negativeEnabled: false },
  { key: 'webtoon', displayName: '韩式条漫', desc: '全彩柔和竖版', icon: '📱', prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ', suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere', negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome', negativeEnabled: false },
  { key: 'comic', displayName: '美漫风格', desc: '粗线条网点动作感', icon: '💥', prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ', suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene', negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading', negativeEnabled: false },
  { key: 'illustration', displayName: '插画风格', desc: '精细艺术插画', icon: '🎨', prefix: 'illustration, detailed artwork, artistic composition, ', suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration', negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background', negativeEnabled: false },
  { key: 'cinematic', displayName: '影院级写实', desc: '8K 写实自然景深', icon: '🎥', prefix: 'Cinematic Contact Sheet, award-winning trailer storyboard, precise grid layout with equal panels. Symmetrical grid, hard borders, clean white dividing lines. Each panel labeled with KF number + shot type + suggested duration. ', suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field, deeper DoF in wides shallower in close-ups with natural bokeh', negative: 'text, speech bubbles, dialogue, watermark, signature, blurry, low quality, inconsistent characters, different outfits, style change, irregular panels, asymmetric grid, new characters not in reference, guessed identities, brand logos', negativeEnabled: false },
  { key: 'theatrical', displayName: '剧场版动画', desc: '剧场版品质电影级', icon: '🎭', prefix: '((現代的な撮影技術を駆使した日本のアニメ映画スタイル:1.5)), ((劇場版クオリティのスクリーンショット:1.5)), ((TVアニメの没入感:1.4)), 以下のプロンプトに従って画像の絵コンテを調整します。日本のアニメ映画版で、監督に見せるための絵コンテです。ストーリー感を表現します。複数のカットで構成されたものは必ず映画版のスクリーンショットで構成された絵コンテで、テキスト内のすべてのストーリー情報を漏らさず、最も重要な演技のカットを示してください。((参考画像の画風に完全に従って構築します:1.6)), ((画風の完全再現:1.6)), ((オリジナル画風を維持:1.5)), ', suffix: ', 高品質, 8k, masterpiece, best quality, absurdres, veryaesthetic, full color, anime cel shading, TV anime coloring, modern anime style, cinematic lighting, highly detailed, depth of field, anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, key animation frames, emotional acting focus', negative: '低品質, 作画崩壊, 実写, 3D, 異なる画風, 画風の変更, 文字, ぼやけ, (worst quality, low quality:1.4), illustration, static illustration, poster, artbook, sketch, monochrome, grayscale', negativeEnabled: false },
]

const DEFAULT_TEMPLATE_MAP = Object.fromEntries(
  BUILTIN_TEMPLATES.map((t) => [t.key, { ...t }])
) as Record<string, TemplateData>

export const TEMPLATE_MAP = Object.fromEntries(
  BUILTIN_TEMPLATES.map((t) => [t.key, { ...t }])
) as Record<string, TemplateData>

function readTemplateOverrides(): Record<string, EditableTemplateFields> {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return {}
    const raw = window.localStorage.getItem(TEMPLATE_OVERRIDES_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    return parsed as Record<string, EditableTemplateFields>
  } catch {
    return {}
  }
}

function writeTemplateOverrides(overrides: Record<string, EditableTemplateFields>): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(TEMPLATE_OVERRIDES_STORAGE_KEY, JSON.stringify(overrides))
  } catch {
    // Best-effort persistence; ignore quota/storage errors.
  }
}

function applyOverrides(): void {
  const overrides = readTemplateOverrides()
  for (const [key, value] of Object.entries(overrides)) {
    const target = TEMPLATE_MAP[key]
    if (!target) continue
    target.prefix = value.prefix
    target.suffix = value.suffix
    target.negative = value.negative
    target.negativeEnabled = Boolean(value.negativeEnabled)
  }
}

applyOverrides()

export function persistTemplateOverride(key: string, value: EditableTemplateFields): void {
  const target = TEMPLATE_MAP[key]
  if (!target) return

  target.prefix = value.prefix
  target.suffix = value.suffix
  target.negative = value.negative
  target.negativeEnabled = value.negativeEnabled

  const overrides = readTemplateOverrides()
  overrides[key] = value
  writeTemplateOverrides(overrides)
}

export function resetTemplateOverride(key: string): void {
  const target = TEMPLATE_MAP[key]
  const fallback = DEFAULT_TEMPLATE_MAP[key]
  if (!target || !fallback) return

  target.prefix = fallback.prefix
  target.suffix = fallback.suffix
  target.negative = fallback.negative
  target.negativeEnabled = fallback.negativeEnabled

  const overrides = readTemplateOverrides()
  delete overrides[key]
  writeTemplateOverrides(overrides)
}

export function getStyleInstructions(templateKey: string | null): string {
  if (!templateKey) return ''
  const t = TEMPLATE_MAP[templateKey]
  if (!t) return ''
  return `${t.prefix}[SUBJECT]${t.suffix}`
}
