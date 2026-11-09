import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ImageChannelPanel } from '../ImageChannelPanel'
import { placeImageChannels, type PlacedImageChannel } from '../imageChannelPlacement'
import { useImageChannelPrefsStore } from '../imageChannelPrefs'

const channels = placeImageChannels()

function renderPanel(selectedId: string | undefined, onSelect: (c: PlacedImageChannel) => void = () => {}) {
  return render(<ImageChannelPanel options={channels} selectedId={selectedId} onSelect={onSelect} />)
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name })
const option = (id: string) => document.querySelector<HTMLElement>(`[data-model-id="${id}"]`)
const visibleIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"] [data-icp-option]')).map((el) => el.dataset.modelId)

beforeEach(() => {
  localStorage.clear()
  useImageChannelPrefsStore.getState().reload()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('ImageChannelPanel · 分区与停靠', () => {
  it('分区栏:常用 / 备用渠道 / 全部模型下的各系列(没用过时没有「最近使用」)', () => {
    renderPanel('custom-imagemodel-gt')
    const names = screen.getAllByRole('tab').map((t) => t.querySelector('.icp-tab__name')?.textContent)
    expect(names).toEqual(['常用', '备用渠道', 'GPT Image 系列', 'Gemini 系列', '火山豆包', '阿里百炼', '风格化'])
    expect(screen.getByText('全部模型')).toBeTruthy()
  })

  it('按系列是完整的:常用 / 备用里的渠道在自己的系列里也有(Nano Banana 2.1 在 Gemini、腾讯 2.6 / 2.5 与官转在 GPT Image)', () => {
    renderPanel('custom-imagemodel-gt')

    fireEvent.click(tab(/^GPT Image 系列/))
    expect(visibleIds()).toEqual([
      'custom-imagemodel-gt',
      'custom-model-og-v2',
      'custom-model-og-v2.5-f',
      'custom-model-og-v2.5-s',
      'custom-model-og-v2.6-f',
      'custom-model-og-v2.6-s',
      'gpt-image-2.6-flare',
      'gpt-image-2.6-sunburst',
      'gpt-image-2.5-flare',
      'gpt-image-2.5-sunburst',
      'gpt-image-2.5-all',
      'gpt-image-2',
      'gpt-image-2-vip',
    ])

    fireEvent.click(tab(/^Gemini 系列/))
    expect(visibleIds()).toEqual(['gemini-3.1-flash-image', 'gemini-nano-banana-2.1'])

    fireEvent.click(tab(/^火山豆包/))
    expect(visibleIds()).toEqual(['doubao-seedream-5-0-pro-260628'])

    fireEvent.click(tab(/^阿里百炼/))
    expect(visibleIds()).toEqual(['wan2.7-image-pro', 'qwen-image-3.0-pro'])
  })

  it('每个渠道至少出现在一个系列里,系列合计正好等于全部渠道(常用 / 备用只是额外入口)', () => {
    renderPanel('custom-imagemodel-gt')
    const seen: string[] = []
    for (const t of screen.getAllByRole('tab')) {
      const name = t.querySelector('.icp-tab__name')?.textContent ?? ''
      if (['常用', '备用渠道', '最近使用'].includes(name)) continue
      fireEvent.click(t)
      seen.push(...(visibleIds() as string[]))
    }
    expect([...seen].sort()).toEqual(channels.map((c) => c.id).sort())
  })

  it('选中常用里的渠道:常用和它的系列两处都亮圆点,打开时停在常用', () => {
    renderPanel('gemini-nano-banana-2.1')
    expect(tab(/^常用/).getAttribute('aria-selected')).toBe('true')
    expect(within(tab(/^常用/)).getByTestId('image-channel-current-dot')).toBeTruthy()
    expect(within(tab(/^Gemini 系列/)).getByTestId('image-channel-current-dot')).toBeTruthy()
    expect(document.querySelectorAll('[data-testid="image-channel-current-dot"]')).toHaveLength(2)
    fireEvent.click(tab(/^Gemini 系列/))
    expect(option('gemini-nano-banana-2.1')?.getAttribute('aria-current')).toBe('true')
  })

  it('打开时停在当前渠道所在的分区,并用圆点标出', () => {
    renderPanel('nai-diffusion-4-5-full')
    expect(tab(/风格化/).getAttribute('aria-selected')).toBe('true')
    expect(visibleIds()).toContain('nai-diffusion-4-5-full')
    expect(within(tab(/风格化/)).getByTestId('image-channel-current-dot')).toBeTruthy()
    expect(document.querySelectorAll('[data-testid="image-channel-current-dot"]')).toHaveLength(1)
    expect(option('nai-diffusion-4-5-full')?.getAttribute('aria-current')).toBe('true')
  })

  it('没选 / 选的渠道不在清单里:停在常用', () => {
    renderPanel('ghost')
    expect(tab(/^常用/).getAttribute('aria-selected')).toBe('true')
  })

  it('点分区切换右栏;右栏标题与说明跟着变', () => {
    renderPanel('custom-imagemodel-gt')
    fireEvent.click(tab(/备用渠道/))
    // 备用 = 常用里腾讯渠道的官转同款,按常用顺序排:默认渠道腾讯 2.6-s 在第二位,它的官转排最前。
    expect(visibleIds()).toEqual(['gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    expect(screen.getByRole('tabpanel').textContent).toContain('备用渠道')
    fireEvent.click(tab(/风格化/))
    expect(screen.getByRole('tabpanel').textContent).toContain('全部模型 · 风格化')
    expect(visibleIds()).toHaveLength(6)
  })

  it('悬停分区:延迟约 90ms 后才切换(斜着划向右栏不误切),移开就取消', () => {
    vi.useFakeTimers()
    renderPanel('custom-imagemodel-gt')
    const target = tab(/备用渠道/)
    fireEvent.pointerEnter(target)
    act(() => {
      vi.advanceTimersByTime(40)
    })
    expect(target.getAttribute('aria-selected')).toBe('false')
    act(() => {
      vi.advanceTimersByTime(80)
    })
    expect(target.getAttribute('aria-selected')).toBe('true')

    const other = tab(/风格化/)
    fireEvent.pointerEnter(other)
    fireEvent.pointerLeave(other)
    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(other.getAttribute('aria-selected')).toBe('false')
  })

  it('窄容器(<440px):分区栏变成顶部横向标签', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320)
    renderPanel('custom-imagemodel-gt')
    expect(screen.getByTestId('image-channel-panel').className).toContain('icp--narrow')
    expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('宽容器:纵向分区栏', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(540)
    renderPanel('custom-imagemodel-gt')
    expect(screen.getByTestId('image-channel-panel').className).not.toContain('icp--narrow')
    expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('vertical')
  })
})

describe('ImageChannelPanel · 选择与偏好', () => {
  it('点渠道 → onSelect 收到该渠道,并记入最近使用', () => {
    const onSelect = vi.fn()
    renderPanel('custom-imagemodel-gt', onSelect)
    fireEvent.click(tab(/风格化/))
    fireEvent.click(option('nai-diffusion-5-full')!)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect.mock.calls[0][0].id).toBe('nai-diffusion-5-full')
    expect(useImageChannelPrefsStore.getState().recent).toEqual(['nai-diffusion-5-full'])
  })

  it('最近使用:出现在分区栏最前面,不含常用里的渠道', () => {
    useImageChannelPrefsStore.getState().recordUse('nai-diffusion-5-curated')
    useImageChannelPrefsStore.getState().recordUse('custom-imagemodel-gt')
    renderPanel('custom-imagemodel-gt')
    const first = screen.getAllByRole('tab')[0]
    expect(first.textContent).toContain('最近使用')
    fireEvent.click(first)
    expect(visibleIds()).toEqual(['nai-diffusion-5-curated'])
  })

  it('固定:系列里的渠道能钉进常用;钉过的在常用里出现且常驻取消按钮,在自己的系列里也还在', () => {
    renderPanel('custom-imagemodel-gt')
    fireEvent.click(tab(/风格化/))
    fireEvent.click(screen.getByRole('button', { name: '固定到常用：NovelAI V5 Full' }))
    expect(useImageChannelPrefsStore.getState().pinned).toEqual(['nai-diffusion-5-full'])
    // 钉到常用只是多一个入口:它仍在「风格化」里,按钮变成「取消固定」
    expect(visibleIds()).toContain('nai-diffusion-5-full')
    expect(screen.getByRole('button', { name: '取消固定：NovelAI V5 Full' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(tab(/^常用/))
    expect(visibleIds()).toContain('nai-diffusion-5-full')
    expect(screen.getByRole('button', { name: '取消固定：NovelAI V5 Full' }).getAttribute('aria-pressed')).toBe('true')
    // 团队常用不给「固定」按钮(常用区里没有,系列里也没有)
    expect(screen.queryByRole('button', { name: /固定到常用：腾讯 image2/ })).toBeNull()
    fireEvent.click(tab(/^GPT Image 系列/))
    expect(option('custom-imagemodel-gt')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /固定到常用：腾讯 image2$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /固定到常用：腾讯 GPT Image 2\.6 Sunburst/ })).toBeNull()
    // 系列里不是团队常用的(如 2.6 Flare、官转)仍可钉
    expect(screen.getByRole('button', { name: '固定到常用：腾讯 GPT Image 2.6 Flare' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '固定到常用：GPT Image 2.5 Flare' })).toBeTruthy()
  })

  it('取消固定:从常用里拿掉,系列里一直都在', () => {
    useImageChannelPrefsStore.getState().togglePin('nai-diffusion-5-full')
    renderPanel('custom-imagemodel-gt')
    fireEvent.click(screen.getByRole('button', { name: '取消固定：NovelAI V5 Full' }))
    expect(visibleIds()).not.toContain('nai-diffusion-5-full')
    fireEvent.click(tab(/风格化/))
    expect(visibleIds()).toContain('nai-diffusion-5-full')
    expect(screen.getByRole('button', { name: '固定到常用：NovelAI V5 Full' })).toBeTruthy()
  })

  it('常用满 10 个后,「固定」按钮置灰并说明原因', () => {
    for (const c of channels.filter((o) => o.placement.tier !== 'featured').slice(0, 4)) {
      useImageChannelPrefsStore.getState().togglePin(c.id)
    }
    renderPanel('custom-imagemodel-gt')
    fireEvent.click(tab(/风格化/))
    const pin = screen.getAllByRole('button', { name: /^固定到常用：/ })[0] as HTMLButtonElement
    expect(pin.disabled).toBe(true)
    expect(pin.title).toContain('常用最多 10 个')
  })

  it('有价格量级的分区底部给参考提示;没有的分区不给', () => {
    renderPanel('nai-diffusion-5-full')
    expect(screen.getByRole('tabpanel').textContent).toContain('≈¥0.6/张')
    expect(screen.getByRole('tabpanel').textContent).toContain('以实际计费为准')
    fireEvent.click(tab(/^常用/))
    expect(screen.getByRole('tabpanel').textContent).not.toContain('以实际计费为准')
  })
})

describe('ImageChannelPanel · 键盘', () => {
  it('分区栏 ↓↑ 切换分区,→ 进入右栏并落在当前渠道上', () => {
    renderPanel('custom-imagemodel-gt')
    const featured = tab(/^常用/)
    featured.focus()
    fireEvent.keyDown(featured, { key: 'ArrowDown' })
    expect(tab(/备用渠道/).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(tab(/备用渠道/))
    fireEvent.keyDown(tab(/备用渠道/), { key: 'ArrowUp' })
    expect(tab(/^常用/).getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(tab(/^常用/), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(option('custom-imagemodel-gt'))
  })

  it('分区栏 Home / End 跳到首 / 尾;到尾再 ↓ 回到开头', () => {
    renderPanel('custom-imagemodel-gt')
    fireEvent.keyDown(tab(/^常用/), { key: 'End' })
    expect(tab(/风格化/).getAttribute('aria-selected')).toBe('true')
    fireEvent.keyDown(tab(/风格化/), { key: 'ArrowDown' })
    expect(tab(/^常用/).getAttribute('aria-selected')).toBe('true')
  })

  it('右栏 ↑↓ 在渠道间移动并停在边界;←→ 切到上 / 下一个分区并聚焦首项', () => {
    renderPanel('custom-imagemodel-gt')
    const first = option('doubao-seedream-5-0-pro-260628')!
    const second = option('custom-model-og-v2.6-s')!
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(second)
    fireEvent.keyDown(second, { key: 'ArrowUp' })
    fireEvent.keyDown(first, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(tab(/备用渠道/).getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(option('gpt-image-2.6-sunburst'))
    fireEvent.keyDown(option('gpt-image-2.6-sunburst')!, { key: 'ArrowLeft' })
    expect(tab(/^常用/).getAttribute('aria-selected')).toBe('true')
  })

  it('右栏只有一个渠道可被 Tab 到(roving tabindex),当前渠道优先', () => {
    renderPanel('custom-imagemodel-gt')
    const tabbable = Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"] [data-icp-option]')).filter(
      (el) => el.tabIndex === 0,
    )
    expect(tabbable.map((el) => el.dataset.modelId)).toEqual(['custom-imagemodel-gt'])
  })

  it('autoFocus:挂载后焦点落在当前渠道上', () => {
    render(<ImageChannelPanel options={channels} selectedId="nai-diffusion-5-curated" onSelect={() => {}} autoFocus />)
    expect(document.activeElement).toBe(option('nai-diffusion-5-curated'))
  })
})
