import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelParamsPanel } from '../ModelParamsPanel'
import {
  YOUCHUAN_V8_PARAM_SPECS,
  type ModelParamValue,
} from '../../../../../shared/imageModelParams'

afterEach(() => cleanup())

function renderPanel(values: Record<string, ModelParamValue> = {}) {
  const onChange = vi.fn()
  const onReset = vi.fn()
  const utils = render(
    <ModelParamsPanel specs={YOUCHUAN_V8_PARAM_SPECS} values={values} onChange={onChange} onReset={onReset} />,
  )
  const openAdvanced = () => fireEvent.click(screen.getByTestId('model-params-advanced-toggle'))
  return { ...utils, onChange, onReset, openAdvanced }
}

describe('ModelParamsPanel', () => {
  it('没有参数表的渠道不渲染任何东西(不冒出空面板)', () => {
    const { container } = render(<ModelParamsPanel specs={[]} values={{}} onChange={vi.fn()} onReset={vi.fn()} />)
    expect(container.innerHTML).toBe('')
  })

  it('主区只有原生 2K,默认显示「是 默认」;高级参数默认折叠', () => {
    renderPanel()
    const hd = screen.getByTestId('model-param-hd') as HTMLSelectElement
    expect(hd.value).toBe('on')
    expect(Array.from(hd.options).map((o) => o.textContent)).toEqual(['否', '是 默认'])
    expect(screen.getByText('直接输出原生 2K 分辨率，计费 ×1.5')).toBeTruthy()
    // 折叠:高级控件不在 DOM 里
    expect(screen.queryByTestId('model-params-advanced')).toBeNull()
    expect(screen.queryByTestId('model-param-chaos')).toBeNull()
    expect(screen.getByText('不设置的项由模型自动决定，一般保持默认即可。')).toBeTruthy()
  })

  it('关掉原生 2K:显式设 false 并带上默认值(让 store 知道何时算「回到默认」)', () => {
    const { onChange } = renderPanel()
    fireEvent.change(screen.getByTestId('model-param-hd'), { target: { value: 'off' } })
    expect(onChange).toHaveBeenCalledWith('hd', false, true)
  })

  it('用户把原生 2K 设成 false 时界面显示「否」', () => {
    renderPanel({ hd: false })
    expect((screen.getByTestId('model-param-hd') as HTMLSelectElement).value).toBe('off')
  })

  it('展开高级参数:全部 10 项都在,选择项第一个是「自动」', () => {
    const { openAdvanced } = renderPanel()
    openAdvanced()
    for (const key of ['quality', 'chaos', 'stylize', 'raw', 'iw', 'sref', 'sw', 'sv', 'seed', 'no']) {
      expect(screen.getByTestId(`model-param-${key}`), key).toBeTruthy()
    }
    const quality = screen.getByTestId('model-param-quality') as HTMLSelectElement
    expect(Array.from(quality.options).map((o) => o.textContent)).toEqual(['自动', '1', '4'])
    expect(quality.value).toBe('')
    // 原始模式:没有产品默认,选项是「否 默认」/「是」
    const raw = screen.getByTestId('model-param-raw') as HTMLSelectElement
    expect(Array.from(raw.options).map((o) => o.textContent)).toEqual(['否 默认', '是'])
  })

  it('数字框:输入值回传数字,清空回传 undefined(= 回到自动);图像权重允许小数', () => {
    const { onChange, openAdvanced } = renderPanel({ chaos: 20 })
    openAdvanced()
    const chaos = screen.getByTestId('model-param-chaos') as HTMLInputElement
    expect(chaos.value).toBe('20')
    expect(chaos.getAttribute('min')).toBe('0')
    expect(chaos.getAttribute('max')).toBe('100')
    expect(chaos.getAttribute('step')).toBe('1')

    fireEvent.change(chaos, { target: { value: '55' } })
    expect(onChange).toHaveBeenLastCalledWith('chaos', 55)
    fireEvent.change(chaos, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('chaos', undefined)

    const iw = screen.getByTestId('model-param-iw') as HTMLInputElement
    expect(iw.getAttribute('step')).toBe('0.1')
    expect(iw.getAttribute('max')).toBe('3')
    fireEvent.change(iw, { target: { value: '1.5' } })
    expect(onChange).toHaveBeenLastCalledWith('iw', 1.5)
  })

  it('选择项:选值回传(数字档位回传数字),选「自动」回传 undefined', () => {
    const { onChange, openAdvanced } = renderPanel({ quality: '4' })
    openAdvanced()
    const quality = screen.getByTestId('model-param-quality') as HTMLSelectElement
    expect(quality.value).toBe('4')
    fireEvent.change(quality, { target: { value: '1' } })
    expect(onChange).toHaveBeenLastCalledWith('quality', '1')
    fireEvent.change(quality, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('quality', undefined)

    fireEvent.change(screen.getByTestId('model-param-sv'), { target: { value: '6' } })
    expect(onChange).toHaveBeenLastCalledWith('sv', 6)
  })

  it('没有产品默认的开关:开 = true,关 = 删键(不显式发 false)', () => {
    const { onChange, openAdvanced } = renderPanel()
    openAdvanced()
    const raw = screen.getByTestId('model-param-raw')
    fireEvent.change(raw, { target: { value: 'on' } })
    expect(onChange).toHaveBeenLastCalledWith('raw', true)
    fireEvent.change(raw, { target: { value: 'off' } })
    expect(onChange).toHaveBeenLastCalledWith('raw', undefined)
  })

  it('风格参考图:一行一个链接,打出多行不被去空行吞掉;空 = 回到自动', () => {
    const { onChange, openAdvanced } = renderPanel()
    openAdvanced()
    const sref = screen.getByTestId('model-param-sref') as HTMLTextAreaElement

    fireEvent.change(sref, { target: { value: 'https://e.com/a.png\n' } })
    expect(onChange).toHaveBeenLastCalledWith('sref', ['https://e.com/a.png'])
    // 末尾的换行还在草稿里,可以接着打下一行
    expect(sref.value).toBe('https://e.com/a.png\n')

    fireEvent.change(sref, { target: { value: 'https://e.com/a.png\nhttps://e.com/b.png' } })
    expect(onChange).toHaveBeenLastCalledWith('sref', ['https://e.com/a.png', 'https://e.com/b.png'])

    fireEvent.change(sref, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('sref', undefined)
  })

  it('排除内容:文本框回传字符串,清空回到自动', () => {
    const { onChange, openAdvanced } = renderPanel()
    openAdvanced()
    fireEvent.change(screen.getByTestId('model-param-no'), { target: { value: 'watermark' } })
    expect(onChange).toHaveBeenLastCalledWith('no', 'watermark')
  })

  it('排除内容:已有值时清空回到自动', () => {
    const { onChange, openAdvanced } = renderPanel({ no: 'watermark' })
    openAdvanced()
    fireEvent.change(screen.getByTestId('model-param-no'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('no', undefined)
  })

  it('标题行显示「已设置 N 项」(只算高级参数),没设置时不显示', () => {
    const { rerender } = render(
      <ModelParamsPanel specs={YOUCHUAN_V8_PARAM_SPECS} values={{}} onChange={vi.fn()} onReset={vi.fn()} />,
    )
    expect(screen.queryByTestId('model-params-set-count')).toBeNull()

    rerender(
      <ModelParamsPanel
        specs={YOUCHUAN_V8_PARAM_SPECS}
        values={{ hd: false, chaos: 10, raw: true }}
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    )
    // hd 在主区,不计入高级参数的数量
    expect(screen.getByTestId('model-params-set-count').textContent).toContain('已设置 2 项')
  })

  it('「全部恢复自动」:没有任何设置时禁用,有设置时可点并触发 onReset', () => {
    const { rerender } = render(
      <ModelParamsPanel specs={YOUCHUAN_V8_PARAM_SPECS} values={{}} onChange={vi.fn()} onReset={vi.fn()} />,
    )
    expect((screen.getByTestId('model-params-reset') as HTMLButtonElement).disabled).toBe(true)

    const onReset = vi.fn()
    rerender(
      <ModelParamsPanel specs={YOUCHUAN_V8_PARAM_SPECS} values={{ chaos: 10 }} onChange={vi.fn()} onReset={onReset} />,
    )
    const reset = screen.getByTestId('model-params-reset') as HTMLButtonElement
    expect(reset.disabled).toBe(false)
    fireEvent.click(reset)
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('越界值就地提示(出网前 ApiService 还会再拒一次),合法值不提示', () => {
    const { rerender } = render(
      <ModelParamsPanel specs={YOUCHUAN_V8_PARAM_SPECS} values={{ chaos: 10 }} onChange={vi.fn()} onReset={vi.fn()} />,
    )
    expect(screen.queryByTestId('model-params-errors')).toBeNull()

    rerender(
      <ModelParamsPanel specs={YOUCHUAN_V8_PARAM_SPECS} values={{ chaos: 500 }} onChange={vi.fn()} onReset={vi.fn()} />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('混沌程度')
    expect(alert.textContent).toContain('不能大于 100')
  })
})
