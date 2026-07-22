// MaterialStack 素材拖拽换位单测:HTML5 DnD 换位回调、视觉反馈类名、
// 跨堆叠(不同 kind mime)不生效、disabled 时不可拖。

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'
import { MaterialStack, materialDragMime } from '../MaterialStack'

const MATERIALS: VideoWorkbenchMaterial[] = [
  { name: 'a.png', src: 'data:image/png;base64,AAA' },
  { name: 'b.png', src: 'data:image/png;base64,BBB' },
  { name: 'c.png', src: 'data:image/png;base64,CCC' },
]

/** jsdom 没有 DataTransfer:手搓一个够用的 stub。 */
function makeDataTransfer(): {
  data: Record<string, string>
  types: string[]
  effectAllowed: string
  dropEffect: string
  setData: (t: string, v: string) => void
  getData: (t: string) => string
} {
  const data: Record<string, string> = {}
  return {
    data,
    get types() {
      return Object.keys(data)
    },
    effectAllowed: '',
    dropEffect: '',
    setData(t: string, v: string) {
      data[t] = v
    },
    getData(t: string) {
      return data[t] ?? ''
    },
  } as never
}

/**
 * jsdom 没有 DragEvent(fireEvent.dragOver 的 clientX 会丢):用 MouseEvent
 * 造同名事件再挂 dataTransfer,clientX 才能进 React 合成事件。
 */
function fireDrag(
  el: HTMLElement,
  type: 'dragstart' | 'dragover' | 'drop' | 'dragend',
  dt: ReturnType<typeof makeDataTransfer>,
  clientX = 0,
) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
  Object.defineProperty(ev, 'dataTransfer', { value: dt })
  fireEvent(el, ev)
}

function renderStack(overrides: Partial<Parameters<typeof MaterialStack>[0]> = {}) {
  const onReorder = vi.fn()
  render(
    <MaterialStack
      kind="image"
      label="参考图"
      accept="image/*"
      materials={MATERIALS}
      limit={9}
      onAdd={vi.fn()}
      onRemove={vi.fn()}
      onReorder={onReorder}
      {...overrides}
    />,
  )
  return { onReorder }
}

afterEach(() => {
  cleanup()
})

describe('MaterialStack 拖拽换位', () => {
  it('拖起第 0 项放到第 2 项右半 → onReorder(0, 2);拖动中有半透明/指示线类名', () => {
    const { onReorder } = renderStack()
    const items = [0, 1, 2].map((i) => screen.getByTestId(`vw-stack-item-image-${i}`))
    const dt = makeDataTransfer()

    fireDrag(items[0], 'dragstart', dt)
    expect(dt.getData(materialDragMime('image'))).toBe('0')
    expect(items[0].className).toContain('vw-mat-dragging')

    // 目标项 rect 在 jsdom 里全 0:clientX=1 > 中点 0 → 落在右半(after)
    fireDrag(items[2], 'dragover', dt, 1)
    expect(items[2].className).toContain('vw-mat-drop-after')

    fireDrag(items[2], 'drop', dt, 1)
    // target = 2+1 = 3,from(0) < target → 3-1 = 2
    expect(onReorder).toHaveBeenCalledWith(0, 2)
    expect(items[0].className).not.toContain('vw-mat-dragging')
    expect(items[2].className).not.toContain('vw-mat-drop-after')
  })

  it('放到目标项左半 → 插到目标前(before 指示线)', () => {
    const { onReorder } = renderStack()
    const items = [0, 1, 2].map((i) => screen.getByTestId(`vw-stack-item-image-${i}`))
    const dt = makeDataTransfer()

    fireDrag(items[2], 'dragstart', dt)
    fireDrag(items[0], 'dragover', dt, -1)
    expect(items[0].className).toContain('vw-mat-drop-before')
    fireDrag(items[0], 'drop', dt, -1)
    expect(onReorder).toHaveBeenCalledWith(2, 0)
  })

  it('原地放下(from === target)不触发 onReorder', () => {
    const { onReorder } = renderStack()
    const item = screen.getByTestId('vw-stack-item-image-1')
    const dt = makeDataTransfer()
    fireDrag(item, 'dragstart', dt)
    fireDrag(item, 'drop', dt, -1)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('跨堆叠拖拽(video mime 拖进 image 堆叠)不生效', () => {
    const { onReorder } = renderStack()
    const item = screen.getByTestId('vw-stack-item-image-0')
    const dt = makeDataTransfer()
    dt.setData(materialDragMime('video'), '0')
    fireDrag(item, 'dragover', dt, 1)
    expect(item.className).not.toContain('vw-mat-drop')
    fireDrag(item, 'drop', dt, 1)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it('disabled 时素材不可拖拽', () => {
    renderStack({ disabled: true })
    const item = screen.getByTestId('vw-stack-item-image-0')
    expect(item.getAttribute('draggable')).toBe('false')
  })
})
