import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageChannelPicker } from '../ImageChannelPicker'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID, findImageChannel } from '../imageChannels'

beforeEach(() => {
  localStorage.clear()
  useAgentChatStore.setState({ selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID })
})

afterEach(() => {
  cleanup()
})

describe('ImageChannelPicker', () => {
  it('shows the current channel label (默认渠道)', () => {
    render(<ImageChannelPicker />)
    // 取默认渠道自己的短标签，而不是写死某个字面量 —— 默认值改过一次
    // （2026-09-01 VIP → 腾讯 image2），再改时这条不该又红。
    const label = findImageChannel(DEFAULT_IMAGE_CHANNEL_ID)!.label
    expect(screen.getByRole('button', { name: /出图渠道/ }).textContent).toContain(label)
  })

  it('opens the dropdown and lists all channels', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(screen.getByRole('button', { name: /出图渠道/ }))
    expect(screen.getByRole('option', { name: /VIP image2/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /GPT Image 2 官方/ })).toBeTruthy()
    // 两条腾讯渠道的名字互为前缀（「腾讯 image2」/「腾讯 image2 fast」），
    // 子串匹配会同时命中两个。锚到行尾才能各指各的。
    expect(screen.getByRole('option', { name: /腾讯 image2(?!\s*fast)/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /腾讯 image2 fast/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Nano Banana 2/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /万相 2\.7 pro/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Seedream 5\.0 Pro/ })).toBeTruthy()
  })

  it('picking a channel updates the store and closes the dropdown', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(screen.getByRole('button', { name: /出图渠道/ }))
    fireEvent.click(screen.getByRole('option', { name: /腾讯 image2(?!\s*fast)/ }))

    expect(useAgentChatStore.getState().selectedImageChannel).toBe('custom-imagemodel-gt')
    // Dropdown closed → options no longer rendered.
    expect(screen.queryByRole('option')).toBeNull()
  })

  it('does not open when disabled', () => {
    render(<ImageChannelPicker disabled />)
    fireEvent.click(screen.getByRole('button', { name: /出图渠道/ }))
    expect(screen.queryByRole('option')).toBeNull()
  })
})
