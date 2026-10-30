import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ModelParamsPanel } from '../ModelParamsPanel'
import {
  NOVELAI_V45_PARAM_SPECS,
  NOVELAI_V5_PARAM_SPECS,
  type ModelParamSpec,
  type ModelParamValue,
} from '../../../../../shared/imageModelParams'

afterEach(() => cleanup())

function renderPanel(
  values: Record<string, ModelParamValue> = {},
  specs: readonly ModelParamSpec[] = NOVELAI_V5_PARAM_SPECS,
) {
  const onChange = vi.fn()
  const onReset = vi.fn()
  const utils = render(<ModelParamsPanel specs={specs} values={values} onChange={onChange} onReset={onReset} />)
  const openAdvanced = () => fireEvent.click(screen.getByTestId('model-params-advanced-toggle'))
  return { ...utils, onChange, onReset, openAdvanced }
}

describe('ModelParamsPanel · NovelAI 主区', () => {
  it('主区:画风 / 负面提示词 / 角色提示词;高级参数默认折叠', () => {
    renderPanel()
    expect(screen.getByTestId('model-param-dataset_mode')).toBeTruthy()
    expect(screen.getByTestId('model-param-negative_prompt')).toBeTruthy()
    expect(screen.getByTestId('model-param-characters')).toBeTruthy()
    expect(screen.queryByTestId('model-param-steps')).toBeNull()
  })

  it('画风下拉:未设置显示「默认（…）」,且默认项不在列表里重复出现', () => {
    renderPanel()
    const mode = screen.getByTestId('model-param-dataset_mode') as HTMLSelectElement
    const labels = Array.from(mode.options).map((o) => o.textContent ?? '')
    expect(labels).toHaveLength(2)
    expect(labels[0]).toMatch(/^默认（/)
    expect(mode.value).toBe('')
  })

  it('画风选「兽人」:回传 furry 并带上默认值(让 store 知道何时算回到默认)', () => {
    const { onChange } = renderPanel()
    const mode = screen.getByTestId('model-param-dataset_mode') as HTMLSelectElement
    const furry = Array.from(mode.options).find((o) => o.value === 'furry')!
    fireEvent.change(mode, { target: { value: furry.value } })
    expect(onChange).toHaveBeenLastCalledWith('dataset_mode', 'furry', 'anime')
  })

  it('负面提示词是多行文本框,输入回传字符串', () => {
    const { onChange } = renderPanel()
    const neg = screen.getByTestId('model-param-negative_prompt') as HTMLTextAreaElement
    expect(neg.tagName).toBe('TEXTAREA')
    expect(neg.getAttribute('maxlength')).toBe('2000')
    fireEvent.change(neg, { target: { value: 'lowres' } })
    expect(onChange).toHaveBeenLastCalledWith('negative_prompt', 'lowres')
  })

  it('负面提示词:已有值时清空回到自动', () => {
    const { onChange } = renderPanel({ negative_prompt: 'lowres' })
    fireEvent.change(screen.getByTestId('model-param-negative_prompt'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('negative_prompt', undefined)
  })
})

describe('ModelParamsPanel · NovelAI 高级参数', () => {
  it('数字框:占位符读作「默认 N」;输入值回传数字并带默认值', () => {
    const { onChange, openAdvanced } = renderPanel()
    openAdvanced()
    const steps = screen.getByTestId('model-param-steps') as HTMLInputElement
    expect(steps.placeholder).toBe('默认 23')
    expect(steps.getAttribute('min')).toBe('1')
    expect(steps.getAttribute('max')).toBe('50')

    fireEvent.change(steps, { target: { value: '30' } })
    expect(onChange).toHaveBeenLastCalledWith('steps', 30, 23)
  })

  it('数字框:已有值时清空只回传 undefined(= 回到默认)', () => {
    const { onChange, openAdvanced } = renderPanel({ steps: 30 })
    openAdvanced()
    fireEvent.change(screen.getByTestId('model-param-steps'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('steps', undefined)
  })

  it('没有默认值的数字框(种子)只回传两个参数', () => {
    const { onChange, openAdvanced } = renderPanel()
    openAdvanced()
    const seed = screen.getByTestId('model-param-seed') as HTMLInputElement
    expect(seed.placeholder).toBe('自动')
    fireEvent.change(seed, { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith('seed', 42)
  })

  it('采样器下拉:默认项只出现一次(在「默认（…）」里),选别的回传值与默认', () => {
    const { onChange, openAdvanced } = renderPanel()
    openAdvanced()
    const sampler = screen.getByTestId('model-param-sampler') as HTMLSelectElement
    const values = Array.from(sampler.options).map((o) => o.value)
    expect(values[0]).toBe('')
    expect(values).not.toContain('Euler Ancestral')
    expect(values).toContain('Euler')
    expect(sampler.value).toBe('')

    fireEvent.change(sampler, { target: { value: 'Euler' } })
    expect(onChange).toHaveBeenLastCalledWith('sampler', 'Euler', 'Euler Ancestral')
    fireEvent.change(sampler, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('sampler', undefined)
  })

  it('持久化里残留的「等于默认」的值,界面显示成未设置而不是空白', () => {
    renderPanel({ sampler: 'Euler Ancestral' })
    // 展开前不渲染;展开后再看
    fireEvent.click(screen.getByTestId('model-params-advanced-toggle'))
    expect((screen.getByTestId('model-param-sampler') as HTMLSelectElement).value).toBe('')
  })

  it('已设置的采样器正确回显', () => {
    const { openAdvanced } = renderPanel({ sampler: 'DPM++ 2M' })
    openAdvanced()
    expect((screen.getByTestId('model-param-sampler') as HTMLSelectElement).value).toBe('DPM++ 2M')
  })
})

describe('ModelParamsPanel · 角色提示词编辑器', () => {
  it('没有角色时只有「添加角色」按钮', () => {
    renderPanel()
    expect(screen.queryByTestId('character-row-0')).toBeNull()
    expect(screen.getByTestId('characters-add').textContent).toContain('添加角色')
  })

  it('添加角色:回传带一行草稿(提示词空、居中)的列表', () => {
    const { onChange } = renderPanel()
    fireEvent.click(screen.getByTestId('characters-add'))
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: '', x: 0.5, y: 0.5 }])
  })

  it('编辑提示词 / 负面:整行回传,其余行不动', () => {
    const rows = [
      { prompt: 'a', x: 0.5, y: 0.5 },
      { prompt: 'b', x: 0.2, y: 0.8 },
    ]
    const { onChange } = renderPanel({ characters: rows })
    fireEvent.change(screen.getByLabelText('角色 2 提示词'), { target: { value: 'b2' } })
    expect(onChange).toHaveBeenLastCalledWith('characters', [rows[0], { ...rows[1], prompt: 'b2' }])

    fireEvent.change(screen.getByLabelText('角色 1 不想要的内容'), { target: { value: 'hat' } })
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ ...rows[0], uc: 'hat' }, rows[1]])
  })

  it('九宫格选位置:左上 = (0.2, 0.2),正中 = (0.5, 0.5),右下 = (0.8, 0.8)', () => {
    const { onChange } = renderPanel({ characters: [{ prompt: 'a', x: 0.5, y: 0.5 }] })
    const group = screen.getByRole('group', { name: '角色 1 位置' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons).toHaveLength(9)
    // 当前是正中
    expect(buttons[4].getAttribute('aria-pressed')).toBe('true')
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1)

    fireEvent.click(buttons[0])
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: 'a', x: 0.2, y: 0.2 }])
    fireEvent.click(buttons[8])
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: 'a', x: 0.8, y: 0.8 }])
  })

  it('x / y 微调:回传数字;清空回到 0.5', () => {
    const { onChange } = renderPanel({ characters: [{ prompt: 'a', x: 0.5, y: 0.5 }] })
    fireEvent.change(screen.getByLabelText('角色 1 位置 x'), { target: { value: '0.35' } })
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: 'a', x: 0.35, y: 0.5 }])
    fireEvent.change(screen.getByLabelText('角色 1 位置 y'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: 'a', x: 0.5, y: 0.5 }])
  })

  it('关掉某个角色:enabled=false 保留这一行(切走再切回来输入不丢);重新打开去掉该键', () => {
    const { onChange } = renderPanel({ characters: [{ prompt: 'a', x: 0.5, y: 0.5 }] })
    fireEvent.click(screen.getByLabelText('启用角色 1'))
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: 'a', x: 0.5, y: 0.5, enabled: false }])
  })

  it('已关掉的角色再打开:enabled 被清掉', () => {
    const { onChange } = renderPanel({ characters: [{ prompt: 'a', x: 0.5, y: 0.5, enabled: false }] })
    const box = screen.getByLabelText('启用角色 1') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(box)
    const last = onChange.mock.calls.at(-1)!
    expect(last[0]).toBe('characters')
    expect((last[1] as Array<Record<string, unknown>>)[0].enabled).toBeUndefined()
  })

  it('删除:删掉那一行;删完回传 undefined(= 回到自动)', () => {
    const { onChange } = renderPanel({
      characters: [
        { prompt: 'a', x: 0.5, y: 0.5 },
        { prompt: 'b', x: 0.5, y: 0.5 },
      ],
    })
    fireEvent.click(screen.getByLabelText('删除角色 1'))
    expect(onChange).toHaveBeenLastCalledWith('characters', [{ prompt: 'b', x: 0.5, y: 0.5 }])
  })

  it('只剩一行时删除 → undefined', () => {
    const { onChange } = renderPanel({ characters: [{ prompt: 'a', x: 0.5, y: 0.5 }] })
    fireEvent.click(screen.getByLabelText('删除角色 1'))
    expect(onChange).toHaveBeenLastCalledWith('characters', undefined)
  })

  it('V4.5 满 6 个:添加按钮禁用并写明上限;V5 同样的 6 个还能继续加', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ prompt: `c${i}`, x: 0.5, y: 0.5 }))
    const v45 = renderPanel({ characters: six }, NOVELAI_V45_PARAM_SPECS)
    const add45 = screen.getByTestId('characters-add') as HTMLButtonElement
    expect(add45.disabled).toBe(true)
    expect(add45.textContent).toContain('已达上限 6 个')
    v45.unmount()

    renderPanel({ characters: six }, NOVELAI_V5_PARAM_SPECS)
    expect((screen.getByTestId('characters-add') as HTMLButtonElement).disabled).toBe(false)
  })
})
