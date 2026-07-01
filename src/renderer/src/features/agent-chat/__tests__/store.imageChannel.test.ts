import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID } from '../imageChannels'

const STORAGE_KEY = 'catimation.agent.selectedImageChannel'

beforeEach(() => {
  localStorage.clear()
  useAgentChatStore.setState({ selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID })
})

describe('useAgentChatStore selectedImageChannel', () => {
  it('starts on the default (VIP) channel', () => {
    expect(useAgentChatStore.getState().selectedImageChannel).toBe('gpt-image-2-vip')
  })

  it('setSelectedImageChannel updates state and persists a valid channel', () => {
    useAgentChatStore.getState().setSelectedImageChannel('custom-imagemodel-gt')
    expect(useAgentChatStore.getState().selectedImageChannel).toBe('custom-imagemodel-gt')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('custom-imagemodel-gt')
  })

  it('ignores an invalid channel id (no state change, no persistence)', () => {
    useAgentChatStore.getState().setSelectedImageChannel('nope-not-real')
    expect(useAgentChatStore.getState().selectedImageChannel).toBe('gpt-image-2-vip')
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
