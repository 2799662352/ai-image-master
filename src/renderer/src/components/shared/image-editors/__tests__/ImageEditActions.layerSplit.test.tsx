import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import ImageEditActions from '../ImageEditActions'

afterEach(() => cleanup())

const noop = () => {}
const URL_A = 'https://x/a.png'

/**
 * 「图层分离」挂在已有图的工具栏上而不是生成表单里 —— 这个动作的对象是一张
 * 已经存在的图。沿用工具栏既有的「宿主没接回调就不显示」约定。
 */
describe('ImageEditActions — 图层分离', () => {
  it('宿主接了才显示', () => {
    render(
      <ImageEditActions
        theme="default"
        imageUrl={URL_A}
        onOpenEditor={noop}
        onLayerSplit={noop}
      />,
    )
    expect(screen.getByText('图层分离')).toBeTruthy()
  })

  it('宿主没接就不显示（批量页等未接入的面不该凭空冒出这个按钮）', () => {
    render(<ImageEditActions theme="default" imageUrl={URL_A} onOpenEditor={noop} />)
    expect(screen.queryByText('图层分离')).toBeNull()
  })

  it('点击把这一张的 url 交回宿主', () => {
    const onLayerSplit = vi.fn()
    render(
      <ImageEditActions
        theme="default"
        imageUrl={URL_A}
        onOpenEditor={noop}
        onLayerSplit={onLayerSplit}
      />,
    )
    fireEvent.click(screen.getByText('图层分离'))
    expect(onLayerSplit).toHaveBeenCalledWith(URL_A)
  })

  it('点击不冒泡 —— 缩略图外层挂着「点开放大预览」，冒上去会同时弹 lightbox', () => {
    const onCardClick = vi.fn()
    render(
      <div onClick={onCardClick}>
        <ImageEditActions
          theme="default"
          imageUrl={URL_A}
          onOpenEditor={noop}
          onLayerSplit={noop}
        />
      </div>,
    )
    fireEvent.click(screen.getByText('图层分离'))
    expect(onCardClick).not.toHaveBeenCalled()
  })

  it('提示里写明计费口径 —— 用户最容易误判「一次拆分算几张钱」', () => {
    render(
      <ImageEditActions
        theme="default"
        imageUrl={URL_A}
        onOpenEditor={noop}
        onLayerSplit={noop}
      />,
    )
    expect(screen.getByText('图层分离').getAttribute('title')).toMatch(/按张计费/)
  })

  it('不影响既有按钮（多角度/打光/全景/导演台照常在）', () => {
    render(
      <ImageEditActions
        theme="default"
        imageUrl={URL_A}
        onOpenEditor={noop}
        onLayerSplit={noop}
      />,
    )
    for (const label of ['多角度', '打光', '全景', '导演台']) {
      expect(screen.getByText(label), label).toBeTruthy()
    }
  })
})
