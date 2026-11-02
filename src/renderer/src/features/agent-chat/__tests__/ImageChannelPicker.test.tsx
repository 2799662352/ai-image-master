import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageChannelPicker } from '../ImageChannelPicker'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID, IMAGE_CHANNELS, findImageChannel } from '../imageChannels'
import { useImageChannelPrefsStore } from '../imageChannelPrefs'

const trigger = () => screen.getByRole('button', { name: /^出图渠道：/ })
const tab = (name: RegExp) => screen.getByRole('tab', { name })
const option = (id: string) => document.querySelector<HTMLElement>(`[data-model-id="${id}"]`)
const visibleIds = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="tabpanel"] [data-icp-option]')).map((el) => el.dataset.modelId)

beforeEach(() => {
  localStorage.clear()
  useImageChannelPrefsStore.getState().reload()
  useAgentChatStore.setState({ selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID })
})

afterEach(() => {
  cleanup()
})

describe('ImageChannelPicker', () => {
  it('shows the current channel label (默认渠道)', () => {
    render(<ImageChannelPicker />)
    // 取默认渠道自己的短标签,而不是写死某个字面量 —— 默认值改过一次
    // (2026-09-01 VIP → 腾讯 image2),再改时这条不该又红。
    const label = findImageChannel(DEFAULT_IMAGE_CHANNEL_ID)!.label
    expect(trigger().textContent).toContain(label)
    // 默认渠道是常用渠道:触发按钮上没有「更多 / 官转」小标签
    expect(screen.queryByTestId('image-channel-trigger-badge')).toBeNull()
  })

  it('点开是两栏分区面板,停在当前渠道所在的「常用」,列出常用六个', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    expect(screen.getByRole('dialog', { name: '出图渠道' })).toBeTruthy()
    expect(tab(/^常用/).getAttribute('aria-selected')).toBe('true')
    expect(visibleIds()).toEqual([
      'doubao-seedream-5-0-pro-260628',
      'custom-imagemodel-gt',
      'custom-model-og-v2.5-f',
      'custom-model-og-v2.5-s',
      'gemini-nano-banana-2.1',
      'wan2.7-image-pro',
    ])
  })

  it('注册表里的每个渠道都能在面板某个分区里找到(没有渠道被藏起来)', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    const seen = new Set<string>()
    for (const t of screen.getAllByRole('tab')) {
      fireEvent.click(t)
      for (const id of visibleIds()) if (id) seen.add(id)
    }
    expect([...seen].sort()).toEqual(IMAGE_CHANNELS.map((c) => c.id).sort())
  })

  it('官转的 2.5 Flare / Sunburst 在「备用渠道」里,选中后写进 store 并收起', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    fireEvent.click(tab(/备用渠道/))
    expect(visibleIds()).toEqual(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    fireEvent.click(option('gpt-image-2.5-sunburst')!)

    expect(useAgentChatStore.getState().selectedImageChannel).toBe('gpt-image-2.5-sunburst')
    expect(screen.queryByRole('dialog')).toBeNull()
    // 选了备用渠道:触发按钮上带线路小标签,避免误触后不自知
    expect(screen.getByTestId('image-channel-trigger-badge').textContent).toBe('官转')
  })

  it('NovelAI 四个在「更多模型 · 风格化」,选中后触发按钮标「更多」', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    fireEvent.click(tab(/风格化/))
    for (const id of ['nai-diffusion-5-full', 'nai-diffusion-5-curated', 'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated']) {
      expect(visibleIds()).toContain(id)
    }
    fireEvent.click(option('nai-diffusion-5-full')!)
    expect(useAgentChatStore.getState().selectedImageChannel).toBe('nai-diffusion-5-full')
    expect(screen.getByTestId('image-channel-trigger-badge').textContent).toBe('更多')
  })

  it('再次打开时停在上次所选渠道的分区,并出现「最近使用」', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    fireEvent.click(tab(/风格化/))
    fireEvent.click(option('nai-diffusion-4-5-curated')!)

    fireEvent.click(trigger())
    expect(tab(/风格化/).getAttribute('aria-selected')).toBe('true')
    expect(screen.getAllByRole('tab')[0].textContent).toContain('最近使用')
  })

  it('选择另一个常用渠道:不出小标签', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    fireEvent.click(option('custom-model-og-v2.5-s')!)
    expect(useAgentChatStore.getState().selectedImageChannel).toBe('custom-model-og-v2.5-s')
    expect(screen.queryByTestId('image-channel-trigger-badge')).toBeNull()
  })

  it('Esc 收起并把焦点还给触发按钮', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(trigger())
    expect(screen.getByRole('dialog')).toBeTruthy()
    // 面板 autoFocus 把焦点放进了弹层
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('点弹层外面收起', () => {
    render(
      <div>
        <ImageChannelPicker />
        <span data-testid="outside">outside</span>
      </div>,
    )
    fireEvent.click(trigger())
    fireEvent.mouseDown(screen.getByTestId('outside'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('store 里存的是认不出的渠道:触发按钮退回清单首项,不崩', () => {
    useAgentChatStore.setState({ selectedImageChannel: 'ghost-channel' })
    render(<ImageChannelPicker />)
    expect(trigger().textContent).toContain(IMAGE_CHANNELS[0].label)
  })

  it('does not open when disabled', () => {
    render(<ImageChannelPicker disabled />)
    fireEvent.click(trigger())
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
