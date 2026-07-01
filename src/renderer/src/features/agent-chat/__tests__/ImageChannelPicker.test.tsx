import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ImageChannelPicker } from '../ImageChannelPicker'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID } from '../imageChannels'

beforeEach(() => {
  localStorage.clear()
  useAgentChatStore.setState({ selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID })
})

afterEach(() => {
  cleanup()
})

describe('ImageChannelPicker', () => {
  it('shows the current channel label (VIP by default)', () => {
    render(<ImageChannelPicker />)
    expect(screen.getByRole('button', { name: /出图渠道/ }).textContent).toContain('VIP')
  })

  it('opens the dropdown and lists all channels', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(screen.getByRole('button', { name: /出图渠道/ }))
    expect(screen.getByRole('option', { name: /VIP image2/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /腾讯 image2/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /Nano Banana 2/ })).toBeTruthy()
    expect(screen.getByRole('option', { name: /万相 2\.7 pro/ })).toBeTruthy()
  })

  it('picking a channel updates the store and closes the dropdown', () => {
    render(<ImageChannelPicker />)
    fireEvent.click(screen.getByRole('button', { name: /出图渠道/ }))
    fireEvent.click(screen.getByRole('option', { name: /腾讯 image2/ }))

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
