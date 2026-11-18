// 视频工作台的「渠道 → 模型」两级选择器。
//
// 结构与交互照出图渠道面板:左栏 tablist(数量 + 当前模型所在渠道的圆点),右栏 tabpanel;
// 悬停(90ms 延迟)/ 点击 / 键盘聚焦切渠道;选中即关;Esc / 面板外按下 / 滚动关。
// 分组与叫法的数据层在 modelChannels.test.ts,这里只钉**交互**与它们的接线。

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WORKBENCH_VIDEO_MODEL_ALIASES, type SeedanceModelAlias } from '../../../../../types/seedance'
import { MODEL_PICKER_HOVER_DELAY_MS, VideoModelPicker } from '../VideoModelPicker'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function setup(
  props: Partial<{
    value: SeedanceModelAlias
    models: readonly SeedanceModelAlias[]
    billing: 'platform' | 'own-key'
    disabled: boolean
  }> = {},
) {
  const onSelect = vi.fn()
  const view = render(
    <VideoModelPicker
      value={props.value ?? '2.0'}
      models={props.models ?? WORKBENCH_VIDEO_MODEL_ALIASES}
      billing={props.billing ?? 'platform'}
      disabled={props.disabled}
      onSelect={onSelect}
    />,
  )
  return { onSelect, ...view }
}

const trigger = () => screen.getByTestId('vw-model-picker')
const openPanel = (): HTMLElement => {
  fireEvent.click(trigger())
  return screen.getByTestId('vw-model-panel')
}
const tab = (panel: HTMLElement, channel: string): HTMLElement =>
  panel.querySelector<HTMLElement>(`[role="tab"][data-channel="${channel}"]`) as HTMLElement
const rows = (panel: HTMLElement): string[] =>
  Array.from(panel.querySelectorAll<HTMLElement>('[data-vw-mp-option]')).map((el) => el.dataset.model ?? '')
const row = (panel: HTMLElement, model: string): HTMLElement =>
  panel.querySelector<HTMLElement>(`[data-vw-mp-option][data-model="${model}"]`) as HTMLElement

describe('按钮', () => {
  it('写着当前模型的完整叫法,读屏名字是「模型：<叫法>」,收起时没有面板', () => {
    setup({ value: 'cn-seedance-2.5' })
    expect(trigger().textContent).toContain('Seedance 2.5 · Roneyun-cn')
    expect(trigger().getAttribute('aria-label')).toBe('模型：Seedance 2.5 · Roneyun-cn')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  it('点一下展开、再点一下收起', () => {
    setup()
    openPanel()
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(trigger())
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  it('禁用时点不开', () => {
    setup({ disabled: true })
    fireEvent.click(trigger())
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  it('面板开着时变成禁用(卡片开始生成)→ 面板跟着收起', () => {
    const { rerender, onSelect } = setup()
    openPanel()
    rerender(<VideoModelPicker value="2.0" models={WORKBENCH_VIDEO_MODEL_ALIASES} billing="platform" disabled onSelect={onSelect} />)
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  // 🧬 变异点:删掉组件里「禁用就 setOpen(false)」那个 effect —— 渲染处还有一道 `!disabled`,
  // 所以禁用期间面板照样不显示;真正的症状在**解禁之后**:开关还记着「开」,面板凭空弹出来。
  it('禁用期间收起之后,解禁不会让面板自己再弹出来', () => {
    const { rerender, onSelect } = setup()
    openPanel()
    const props = { value: '2.0' as const, models: WORKBENCH_VIDEO_MODEL_ALIASES, billing: 'platform' as const, onSelect }
    rerender(<VideoModelPicker {...props} disabled />)
    rerender(<VideoModelPicker {...props} />)
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('面板结构', () => {
  it('面板在 document.body 上(portal),不在卡片的 DOM 里', () => {
    const { container } = setup()
    const panel = openPanel()
    expect(panel.parentElement).toBe(document.body)
    expect(container.contains(panel)).toBe(false)
  })

  it('左栏是 tablist:四个渠道按序排列,每栏带模型数量', () => {
    setup()
    const panel = openPanel()
    const list = within(panel).getByRole('tablist', { name: '视频渠道' })
    const tabs = within(list).getAllByRole('tab')
    expect(tabs.map((t) => [t.dataset.channel, t.querySelector('.vw-mp-tab__name')?.textContent, t.querySelector('.vw-mp-tab__count')?.textContent])).toEqual([
      ['volcengine', '火山方舟', '5'],
      ['roneyun-cn', 'Roneyun-cn', '4'],
      ['wan', '阿里万相', '2'],
      ['kling', '可灵', '2'],
    ])
  })

  it('打开时停在当前模型所在的渠道,右栏只列这个渠道的模型,当前那行标 aria-current', () => {
    setup({ value: 'cn-seedance-2.0-fast' })
    const panel = openPanel()
    expect(within(panel).getByRole('tab', { selected: true }).dataset.channel).toBe('roneyun-cn')
    expect(rows(panel)).toEqual(['cn-seedance-2.0', 'cn-seedance-2.0-fast', 'cn-seedance-2.0-mini', 'cn-seedance-2.5'])
    expect(row(panel, 'cn-seedance-2.0-fast').getAttribute('aria-current')).toBe('true')
    expect(panel.querySelectorAll('[aria-current="true"]')).toHaveLength(1)
    // 右栏标题带渠道名与说明。
    expect(panel.querySelector('.vw-mp-head__title')?.textContent).toBe('Roneyun-cn')
    expect(panel.querySelector('.vw-mp-head__caption')?.textContent).toMatch(/公网链接/)
  })

  it('右栏每行:去掉渠道名的叫法 + 能力说明;别名放在 tooltip', () => {
    setup({ value: 'cn-seedance-2.5', billing: 'platform' })
    const panel = openPanel()
    const r = row(panel, 'cn-seedance-2.5')
    expect(r.querySelector('.vw-mp-opt__name')?.textContent).toBe('Seedance 2.5')
    expect(r.querySelector('.vw-mp-opt__desc')?.textContent).toBe(
      '4–30 秒 · 最高 4k · 参考 30 图 / 10 视频 / 10 音频 · 可编辑 / 延长 · 样片',
    )
    expect(r.getAttribute('title')).toBe('cn-seedance-2.5')
  })

  it('当前模型所在渠道的左栏有圆点,别的渠道没有', () => {
    setup({ value: 'kling4' })
    const panel = openPanel()
    const withDot = Array.from(panel.querySelectorAll<HTMLElement>('[role="tab"]'))
      .filter((t) => t.querySelector('[data-testid="vw-model-current-dot"]'))
      .map((t) => t.dataset.channel)
    expect(withDot).toEqual(['kling'])
  })

  it('当前值是旧存档里认不出的别名:停在第一栏,没有圆点,不崩', () => {
    setup({ value: 'seedance-1.0' as SeedanceModelAlias })
    const panel = openPanel()
    expect(within(panel).getByRole('tab', { selected: true }).dataset.channel).toBe('volcengine')
    expect(panel.querySelectorAll('[data-testid="vw-model-current-dot"]')).toHaveLength(0)
    expect(trigger().textContent).toContain('seedance-1.0')
  })

  it('只传入一部分模型时,没有模型的渠道不出栏', () => {
    setup({ value: '2.0', models: ['2.0', 'wan3'] })
    const panel = openPanel()
    expect(Array.from(panel.querySelectorAll<HTMLElement>('[role="tab"]')).map((t) => t.dataset.channel)).toEqual(['volcengine', 'wan'])
  })
})

describe('切换渠道', () => {
  it('点左栏切换右栏', () => {
    setup()
    const panel = openPanel()
    fireEvent.click(tab(panel, 'kling'))
    expect(rows(panel)).toEqual(['kling4', 'kling4-omni'])
    expect(tab(panel, 'kling').getAttribute('aria-selected')).toBe('true')
    expect(tab(panel, 'volcengine').getAttribute('aria-selected')).toBe('false')
  })

  it(`悬停 ${MODEL_PICKER_HOVER_DELAY_MS}ms 后才切 —— 斜着划向右栏路过别的渠道不会把右栏换掉`, () => {
    vi.useFakeTimers()
    setup()
    const panel = openPanel()
    fireEvent.pointerEnter(tab(panel, 'wan'))
    act(() => {
      vi.advanceTimersByTime(MODEL_PICKER_HOVER_DELAY_MS - 10)
    })
    expect(rows(panel)).toContain('2.0')
    act(() => {
      vi.advanceTimersByTime(20)
    })
    expect(rows(panel)).toEqual(['wan3', 'wan3-prime'])
  })

  it('没等到延迟就划走:不切;划进右栏同样取消', () => {
    vi.useFakeTimers()
    setup()
    const panel = openPanel()
    fireEvent.pointerEnter(tab(panel, 'kling'))
    fireEvent.pointerLeave(tab(panel, 'kling'))
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(rows(panel)).toContain('2.0')

    fireEvent.pointerEnter(tab(panel, 'kling'))
    fireEvent.pointerEnter(panel.querySelector('[role="tabpanel"]') as HTMLElement)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(rows(panel)).toContain('2.0')
  })

  it('悬停切渠道不会改变当前模型(只有选中才改)', () => {
    vi.useFakeTimers()
    const { onSelect } = setup({ value: '2.0' })
    const panel = openPanel()
    fireEvent.pointerEnter(tab(panel, 'roneyun-cn'))
    act(() => {
      vi.advanceTimersByTime(MODEL_PICKER_HOVER_DELAY_MS + 10)
    })
    expect(onSelect).not.toHaveBeenCalled()
    expect(trigger().getAttribute('aria-label')).toBe('模型：Seedance 2.0 满血')
  })
})

describe('选择', () => {
  it('点一个模型 → onSelect 收到别名,面板收起,焦点回到按钮', () => {
    const { onSelect } = setup({ value: '2.0' })
    const panel = openPanel()
    fireEvent.click(tab(panel, 'roneyun-cn'))
    fireEvent.click(row(panel, 'cn-seedance-2.5'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('cn-seedance-2.5')
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  /**
   * 选的就是当前模型:只关面板。发一次「换模型」会触发卡片上一轮分辨率 / 时长收敛,而用户什么都没换。
   * 🧬 变异点:去掉 `if (model !== value)`,这条必红。
   */
  it('选当前模型只关面板,不发 onSelect', () => {
    const { onSelect } = setup({ value: '2.5' })
    const panel = openPanel()
    fireEvent.click(row(panel, '2.5'))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })
})

describe('关闭', () => {
  it('Esc 关闭并把焦点还给按钮', () => {
    setup()
    openPanel()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('面板外按下鼠标 → 关(不抢焦点);按在面板里不关;按在按钮上交给按钮自己的开关', () => {
    setup()
    const panel = openPanel()
    fireEvent.mouseDown(panel)
    expect(screen.queryByTestId('vw-model-panel')).not.toBeNull()
    fireEvent.mouseDown(document.body)
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()

    openPanel()
    fireEvent.mouseDown(trigger())
    expect(screen.queryByTestId('vw-model-panel')).not.toBeNull()
  })

  it('面板以外的滚动 → 关;面板自己右栏的滚动不关', () => {
    setup()
    const panel = openPanel()
    fireEvent.scroll(panel.querySelector('.vw-mp-rows') as HTMLElement)
    expect(screen.queryByTestId('vw-model-panel')).not.toBeNull()
    fireEvent.scroll(document.body)
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  it('窗口缩放 / 失焦 → 关', () => {
    setup()
    openPanel()
    fireEvent(window, new Event('resize'))
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()

    openPanel()
    fireEvent(window, new Event('blur'))
    expect(screen.queryByTestId('vw-model-panel')).toBeNull()
  })

  it('关闭后不再残留 window 监听:关掉之后的 Esc 不会再抢焦点', () => {
    setup()
    openPanel()
    fireEvent.click(trigger())
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(document.activeElement).not.toBe(trigger())
  })
})

describe('键盘', () => {
  it('打开后焦点进右栏当前那一行', () => {
    setup({ value: 'cn-seedance-2.0-mini' })
    const panel = openPanel()
    expect(document.activeElement).toBe(row(panel, 'cn-seedance-2.0-mini'))
  })

  it('左栏 ↑↓ 切渠道(环绕),→ 进右栏', () => {
    setup({ value: '2.0' })
    const panel = openPanel()
    const first = tab(panel, 'volcengine')
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(rows(panel)[0]).toBe('cn-seedance-2.0')
    expect(document.activeElement).toBe(tab(panel, 'roneyun-cn'))

    fireEvent.keyDown(tab(panel, 'roneyun-cn'), { key: 'ArrowUp' })
    fireEvent.keyDown(tab(panel, 'volcengine'), { key: 'ArrowUp' })
    // 第一栏再往上 = 环绕到最后一栏。
    expect(rows(panel)).toEqual(['kling4', 'kling4-omni'])

    fireEvent.keyDown(tab(panel, 'kling'), { key: 'ArrowRight' })
    expect(rows(panel)).toContain(String((document.activeElement as HTMLElement).dataset.model))
  })

  it('左栏 Home / End 跳到首 / 末渠道', () => {
    setup()
    const panel = openPanel()
    const t = tab(panel, 'volcengine')
    t.focus()
    fireEvent.keyDown(t, { key: 'End' })
    expect(rows(panel)).toEqual(['kling4', 'kling4-omni'])
    fireEvent.keyDown(tab(panel, 'kling'), { key: 'Home' })
    expect(rows(panel)[0]).toBe('2.0')
  })

  it('右栏 ↑↓ 移动(到头不环绕),Home / End 跳首尾,←→ 切到上 / 下一个渠道', () => {
    setup({ value: '2.0' })
    const panel = openPanel()
    const first = row(panel, '2.0')
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(row(panel, '2.0-fast'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' })
    expect(document.activeElement).toBe(row(panel, '2.5-flash'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Home' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(rows(panel)[0]).toBe('cn-seedance-2.0')
    // 切渠道后焦点落在新渠道右栏的第一行。
    expect(document.activeElement).toBe(row(panel, 'cn-seedance-2.0'))
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowLeft' })
    expect(rows(panel)[0]).toBe('2.0')
  })

  it('只有一个渠道时 ←→ 不切', () => {
    setup({ value: '2.0', models: ['2.0', '2.5'] })
    const panel = openPanel()
    fireEvent.keyDown(row(panel, '2.0'), { key: 'ArrowRight' })
    expect(rows(panel)).toEqual(['2.0', '2.5'])
  })

  it('只有当前行在 tab 序里(roving tabindex),其余 -1', () => {
    setup({ value: '2.0-mini' })
    const panel = openPanel()
    const indexes = Object.fromEntries(rows(panel).map((m) => [m, row(panel, m).getAttribute('tabindex')]))
    expect(indexes).toEqual({ '2.0': '-1', '2.0-fast': '-1', '2.0-mini': '0', '2.5': '-1', '2.5-flash': '-1' })
  })
})
