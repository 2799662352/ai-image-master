import { describe, expect, it } from 'vitest'
import {
  ANNOTATION_COLORS,
  RESIZE_PRESETS,
  STROKE_COLOR,
  buildImageFeedbackInstruction,
  maskFileName,
  normalizePoint,
  renumberComments,
  strokeColor,
  summarizeStrokes,
  type AnnotationStroke,
  type ImageComment,
} from '../lightbox/imageTools'

/**
 * 灯箱图片工具条(设计稿 D4)的纯逻辑:标注 / 评论 / 擦除 / 移除背景 / 调整尺寸
 * 最终都变成「一张带标注的副本 + 一段附加指令」交给 Codex —— 与上游 Codex App
 * 浏览器注释模式(截图 + 评论文字)同构。这里只测文字与几何,画布合成走真机。
 */

const strokes = (kinds: Array<'annotate' | 'erase'>): AnnotationStroke[] =>
  kinds.map((kind, i) => ({ id: `s${i}`, kind, points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }] }))

const comments: ImageComment[] = [
  { id: 'c1', n: 1, at: { x: 0.2, y: 0.3 }, text: '这块霓虹再暗 20%' },
  { id: 'c2', n: 2, at: { x: 0.6, y: 0.4 }, text: '标题字体不动' },
]

describe('normalizePoint', () => {
  it('maps a client point into the image box as 0..1 and clamps outside points', () => {
    const rect = { left: 100, top: 50, width: 200, height: 100 }
    expect(normalizePoint(150, 100, rect)).toEqual({ x: 0.25, y: 0.5 })
    expect(normalizePoint(0, 0, rect)).toEqual({ x: 0, y: 0 })
    expect(normalizePoint(999, 999, rect)).toEqual({ x: 1, y: 1 })
  })

  it('is safe on a zero-size rect', () => {
    expect(normalizePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 })
  })
})

describe('maskFileName', () => {
  it('derives <stem>.mask.png so the mask sits next to its image by name', () => {
    expect(maskFileName('night_v2.png')).toBe('night_v2.mask.png')
    expect(maskFileName('photo.jpeg')).toBe('photo.mask.png')
    expect(maskFileName('noext')).toBe('noext.mask.png')
  })
})

describe('renumberComments', () => {
  it('keeps order and renumbers 1..n after a deletion', () => {
    const out = renumberComments([comments[1], { ...comments[0], n: 7 }])
    expect(out.map((c) => c.n)).toEqual([1, 2])
    expect(out.map((c) => c.id)).toEqual(['c2', 'c1'])
  })
})

// 用户反馈 2026-09-14:标注要能选颜色。调色板不含红(红是擦除的专属语义),
// 指令/侧栏按实际用到的颜色点名,模型才对得上图上的圈。
describe('annotation colours', () => {
  it('the palette leads with cyan (the drawer accent) and never offers the erase red', () => {
    expect(ANNOTATION_COLORS[0].hex).toBe(STROKE_COLOR.annotate)
    expect(ANNOTATION_COLORS.length).toBeGreaterThanOrEqual(5)
    expect(ANNOTATION_COLORS.some((c) => c.hex.toLowerCase() === STROKE_COLOR.erase.toLowerCase())).toBe(false)
    expect(new Set(ANNOTATION_COLORS.map((c) => c.hex)).size).toBe(ANNOTATION_COLORS.length)
  })

  it('strokeColor: annotate strokes use their own colour (default cyan); erase is always red', () => {
    expect(strokeColor({ id: 'a', kind: 'annotate', points: [] })).toBe(STROKE_COLOR.annotate)
    expect(strokeColor({ id: 'b', kind: 'annotate', color: '#facc15', points: [] })).toBe('#facc15')
    expect(strokeColor({ id: 'c', kind: 'erase', color: '#facc15', points: [] })).toBe(STROKE_COLOR.erase)
  })

  it('summarizeStrokes: counts per colour for annotations, red erase separately', () => {
    const yellow = ANNOTATION_COLORS.find((c) => c.label === '黄')!.hex
    const s: AnnotationStroke[] = [
      ...strokes(['annotate', 'annotate', 'erase']),
      { id: 'y', kind: 'annotate', color: yellow, points: [{ x: 0.5, y: 0.5 }] },
    ]
    const text = summarizeStrokes(s)
    expect(text).toContain('圈注 3 处')
    expect(text).toContain('青色 2')
    expect(text).toContain('黄色 1')
    expect(text).toContain('红色擦除 1 处')
    expect(summarizeStrokes([])).toBe('')
  })

  it('the instruction legend names every colour actually used, so a yellow circle is not called cyan', () => {
    const yellow = ANNOTATION_COLORS.find((c) => c.label === '黄')!.hex
    const text = buildImageFeedbackInstruction({
      imageName: 'a.png',
      comments: [],
      strokes: [
        { id: 'y1', kind: 'annotate', color: yellow, points: [{ x: 0.1, y: 0.1 }] },
        { id: 'y2', kind: 'annotate', color: yellow, points: [{ x: 0.3, y: 0.3 }] },
      ],
    })
    expect(text).toContain('黄色')
    expect(text).not.toContain('青色')
    expect(text).toContain('2 处')
  })
})

describe('buildImageFeedbackInstruction', () => {
  it('returns an empty string when nothing was marked', () => {
    expect(buildImageFeedbackInstruction({ imageName: 'a.png', comments: [], strokes: [] })).toBe('')
  })

  it('lists numbered comments under a header that names the image', () => {
    const text = buildImageFeedbackInstruction({ imageName: 'night_v2.png', comments, strokes: [] })
    expect(text.startsWith('[图片反馈 · night_v2.png]')).toBe(true)
    expect(text).toContain('1. 这块霓虹再暗 20%')
    expect(text).toContain('2. 标题字体不动')
    expect(text).not.toContain('擦除')
    expect(text).not.toContain('移除背景')
  })

  it('describes annotation and erase strokes by count and colour', () => {
    const text = buildImageFeedbackInstruction({
      imageName: 'a.png',
      comments: [],
      strokes: strokes(['annotate', 'annotate', 'erase']),
    })
    expect(text).toContain('青色')
    expect(text).toContain('2 处')
    expect(text).toContain('红色')
    expect(text).toContain('1 处')
    expect(text).toMatch(/擦除|抹掉/)
  })

  // P3c:擦除有真遮罩时,指令要点名遮罩文件 + generate_image 的 maskImage/referenceImages 用法,
  // 并把 alpha 语义(透明 = 重绘)写进去 —— 这是模型唯一能拿到的操作说明。
  it('names the mask file and the maskImage tool contract when an erase mask is attached', () => {
    const text = buildImageFeedbackInstruction({
      imageName: 'a.png',
      comments: [],
      strokes: strokes(['erase']),
      maskName: 'a.mask.png',
    })
    expect(text).toContain('a.mask.png')
    expect(text).toContain('maskImage')
    expect(text).toContain('referenceImages')
    expect(text).toMatch(/透明|alpha/i)
    // 擦除绑定 2.5(用户拍板:目前只有 2.5 有这个能力);sunburst 是改图优先的那一档,排第一。
    expect(text).toContain('gpt-image-2.5-sunburst')
    expect(text).not.toMatch(/gpt-image-2(?![.\-])/)
  })

  it('falls back to the red-stroke description when no mask file could be produced', () => {
    const text = buildImageFeedbackInstruction({ imageName: 'a.png', comments: [], strokes: strokes(['erase']) })
    expect(text).not.toContain('maskImage')
    expect(text).toContain('红色')
  })

  it('appends the remove-background action with the transparentBackground hint', () => {
    const text = buildImageFeedbackInstruction({ imageName: 'a.png', comments: [], strokes: [], action: { type: 'remove-bg' } })
    expect(text).toContain('移除背景')
    expect(text).toContain('transparentBackground')
  })

  it('appends the resize action with the chosen preset', () => {
    const preset = RESIZE_PRESETS.find((p) => p.id === '16:9')!
    const text = buildImageFeedbackInstruction({ imageName: 'a.png', comments: [], strokes: [], action: { type: 'resize', preset } })
    expect(text).toContain('调整尺寸')
    expect(text).toContain(preset.label)
  })

  it('ships resize presets covering square, landscape, portrait and 2K', () => {
    expect(RESIZE_PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(['1:1', '16:9', '9:16', '2K']))
  })
})
