// 编辑器 ↔ 预览 的滚动对齐算法。
//
// 关键是**插值**:源码里占 1 行的东西(一张图、一个长表格)在预览里可能占 3 屏,
// 只按最近锚点吸附会一跳一跳。这里钉的就是"两个锚点之间按比例走"。

import { describe, expect, it } from 'vitest'
import { lineForPreviewTop, previewTopForLine, type PreviewAnchor } from '../markdownScrollSync'

const ANCHORS: PreviewAnchor[] = [
  { line: 1, top: 0 },
  { line: 11, top: 200 },
  { line: 21, top: 600 },
]

describe('previewTopForLine', () => {
  it('锚点上精确命中', () => {
    expect(previewTopForLine(ANCHORS, 1)).toBe(0)
    expect(previewTopForLine(ANCHORS, 11)).toBe(200)
    expect(previewTopForLine(ANCHORS, 21)).toBe(600)
  })

  it('锚点之间线性插值', () => {
    // 6 行在 1↔11 的正中间 → 200 的一半
    expect(previewTopForLine(ANCHORS, 6)).toBe(100)
    // 16 行在 11↔21 中间 → 200 + (600-200)/2
    expect(previewTopForLine(ANCHORS, 16)).toBe(400)
  })

  it('首个锚点之前回 0,末个锚点之后不外推', () => {
    expect(previewTopForLine(ANCHORS, 0)).toBe(0)
    // 继续外推只会把文档甩过头 —— 末锚点之后一律停在它身上
    expect(previewTopForLine(ANCHORS, 999)).toBe(600)
  })

  it('空锚点集不炸(文档还没渲染完)', () => {
    expect(previewTopForLine([], 5)).toBe(0)
  })

  it('同一行两个锚点(零宽区间)不产生除零', () => {
    const dup: PreviewAnchor[] = [{ line: 3, top: 10 }, { line: 3, top: 40 }, { line: 9, top: 100 }]
    expect(Number.isFinite(previewTopForLine(dup, 3))).toBe(true)
  })
})

describe('lineForPreviewTop', () => {
  it('是 previewTopForLine 的逆运算', () => {
    expect(lineForPreviewTop(ANCHORS, 0)).toBe(1)
    expect(lineForPreviewTop(ANCHORS, 200)).toBe(11)
    expect(lineForPreviewTop(ANCHORS, 100)).toBe(6)
    expect(lineForPreviewTop(ANCHORS, 400)).toBe(16)
  })

  it('取整到行 —— 行号是离散的', () => {
    expect(Number.isInteger(lineForPreviewTop(ANCHORS, 137))).toBe(true)
  })

  it('越界收敛到首/末锚点', () => {
    expect(lineForPreviewTop(ANCHORS, -50)).toBe(1)
    expect(lineForPreviewTop(ANCHORS, 99999)).toBe(21)
  })

  it('空锚点集回第一行', () => {
    expect(lineForPreviewTop([], 300)).toBe(1)
  })
})
