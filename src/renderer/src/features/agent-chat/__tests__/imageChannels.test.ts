import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_CHANNEL_ID,
  IMAGE_CHANNELS,
  findImageChannel,
  isMiauOnlyChannel,
  isSelectableImageChannel,
  resolveImageChannel,
} from '../imageChannels'

describe('imageChannels registry', () => {
  it('defaults to the VIP channel', () => {
    expect(DEFAULT_IMAGE_CHANNEL_ID).toBe('gpt-image-2-vip')
    expect(findImageChannel(DEFAULT_IMAGE_CHANNEL_ID)).toBeDefined()
  })

  it('lists channels in the requested order: VIP → 腾讯 → Nano2 → Wan2.7', () => {
    expect(IMAGE_CHANNELS.map((c) => c.id)).toEqual([
      'gpt-image-2-vip',
      'custom-imagemodel-gt',
      'gemini-3.1-flash-image',
      'wan2.7-image-pro',
    ])
  })

  it('marks only the gateway-proxied channels as Miau-only', () => {
    expect(isMiauOnlyChannel('custom-imagemodel-gt')).toBe(true)
    expect(isMiauOnlyChannel('wan2.7-image-pro')).toBe(true)
    expect(isMiauOnlyChannel('gpt-image-2-vip')).toBe(false)
    expect(isMiauOnlyChannel('gemini-3.1-flash-image')).toBe(false)
  })

  it('validates selectable ids', () => {
    expect(isSelectableImageChannel('gpt-image-2-vip')).toBe(true)
    expect(isSelectableImageChannel('nope')).toBe(false)
    expect(isSelectableImageChannel(undefined)).toBe(false)
    expect(isSelectableImageChannel(42)).toBe(false)
  })

  it('resolves valid ids as-is and falls back to VIP otherwise', () => {
    expect(resolveImageChannel('wan2.7-image-pro')).toBe('wan2.7-image-pro')
    expect(resolveImageChannel('made-up')).toBe('gpt-image-2-vip')
    expect(resolveImageChannel(null)).toBe('gpt-image-2-vip')
  })

  it('gives every channel a non-empty label / fullLabel / description', () => {
    for (const c of IMAGE_CHANNELS) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.fullLabel.length).toBeGreaterThan(0)
      expect(c.description.length).toBeGreaterThan(0)
    }
  })
})
