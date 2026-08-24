import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import VisualPromptBar from '../VisualPromptBar'

afterEach(() => cleanup())

vi.mock('../../../hooks/useDisplaySrc', () => ({ useDisplaySrc: (u: string) => u }))

const noop = () => {}
const REFS = [
  { url: 'https://x/a.png', label: 'REF-1' },
  { url: 'https://x/b.png', label: 'REF-2' },
]

/**
 * 图层分离是这一排（多角度 / 打光 / 全景 / 导演台）的**动作**，不是参数区的模式开关。
 * 关键约束：它跟模型无关——渠道由动作自己钉住 SD5 Pro，用户不该为了看见按钮先切模型。
 */
describe('VisualPromptBar — 图层分离', () => {
  it('宿主接了就显示，且不看当前模型（这一排根本不知道模型是什么）', () => {
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} onLayerSplit={noop} />)
    expect(screen.getByRole('button', { name: /图层分离/ })).toBeTruthy()
  })

  it('宿主没接就不显示（沿用这一排既有的约定）', () => {
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} />)
    expect(screen.queryByRole('button', { name: /图层分离/ })).toBeNull()
  })

  it('没有参考图时禁用，与多角度/打光同一口径', () => {
    render(<VisualPromptBar imageChoices={[]} onInject={noop} onLayerSplit={noop} />)
    const btn = screen.getByRole('button', { name: /图层分离/ }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(btn.title).toMatch(/先上传参考图/)
  })

  it('拆的是**选中的**那张 —— 这一排有选图器，「拆哪张」在这里有明确答案', () => {
    const onLayerSplit = vi.fn()
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} onLayerSplit={onLayerSplit} />)

    // 默认第 1 张
    fireEvent.click(screen.getByRole('button', { name: /图层分离/ }))
    expect(onLayerSplit).toHaveBeenLastCalledWith('https://x/a.png')

    // 切到第 2 张后再点
    fireEvent.click(screen.getByTitle('REF-2'))
    fireEvent.click(screen.getByRole('button', { name: /图层分离/ }))
    expect(onLayerSplit).toHaveBeenLastCalledWith('https://x/b.png')
  })

  it('禁用时点击不触发', () => {
    const onLayerSplit = vi.fn()
    render(<VisualPromptBar imageChoices={[]} onInject={noop} onLayerSplit={onLayerSplit} />)
    fireEvent.click(screen.getByRole('button', { name: /图层分离/ }))
    expect(onLayerSplit).not.toHaveBeenCalled()
  })

  it('提示里写明计费口径 —— 用户最容易误判「一次拆分算几张钱」', () => {
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} onLayerSplit={noop} />)
    expect(screen.getByRole('button', { name: /图层分离/ }).getAttribute('title')).toMatch(/按张计费/)
  })

  it('splitArmed 时显示按下态 —— 状态就一个 bit，由这个按钮自己表达，不另起横条', () => {
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} onLayerSplit={noop} splitArmed />)
    const btn = screen.getByRole('button', { name: /图层分离/ })
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    // 提示要改口:此刻该说「去点主按钮」，而不是再解释一遍这个按钮是干嘛的
    expect(btn.getAttribute('title')).toMatch(/主按钮/)
  })

  it('未选中时 aria-pressed 为 false', () => {
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} onLayerSplit={noop} />)
    expect(screen.getByRole('button', { name: /图层分离/ }).getAttribute('aria-pressed')).toBe('false')
  })

  it('不影响这一排既有的按钮', () => {
    render(<VisualPromptBar imageChoices={REFS} onInject={noop} onLayerSplit={noop} />)
    for (const name of [/多角度/, /打光/, /全景/, /导演台/]) {
      expect(screen.getByRole('button', { name }), String(name)).toBeTruthy()
    }
  })
})
