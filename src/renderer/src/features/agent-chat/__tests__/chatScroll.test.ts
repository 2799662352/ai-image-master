import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CHAT_SCROLL_STORAGE_KEY,
  CHAT_SCROLL_UNLOCK_THRESHOLD_PX,
  computeFollowBottom,
  distanceFromBottom,
  loadChatScrollByThread,
  persistChatScrollByThread,
  type ChatScrollByThread,
} from '../chatScroll'

describe('distanceFromBottom', () => {
  it('returns 0 when scrolled to bottom exactly', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(0)
  })

  it('returns positive when above bottom', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 400 })).toBe(400)
  })

  it('clamps to 0 when scroll is over-stretched (bounce / negative result)', () => {
    expect(distanceFromBottom({ scrollHeight: 1000, scrollTop: 700, clientHeight: 400 })).toBe(0)
  })
})

describe('computeFollowBottom', () => {
  it('returns true when distance equals 0 (locked at bottom)', () => {
    expect(computeFollowBottom(0)).toBe(true)
  })

  it('returns true at exactly the unlock threshold (boundary inclusive)', () => {
    expect(computeFollowBottom(CHAT_SCROLL_UNLOCK_THRESHOLD_PX)).toBe(true)
  })

  it('returns false one pixel past the unlock threshold', () => {
    expect(computeFollowBottom(CHAT_SCROLL_UNLOCK_THRESHOLD_PX + 1)).toBe(false)
  })

  it('returns false for large distances (free-scroll)', () => {
    expect(computeFollowBottom(500)).toBe(false)
  })
})

describe('localStorage round-trip', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear?.()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns empty object when nothing is stored', () => {
    expect(loadChatScrollByThread()).toEqual({})
  })

  it('persistChatScrollByThread + loadChatScrollByThread round-trip restores state', () => {
    const input: ChatScrollByThread = {
      'thread-a': { scrollTop: 1234, followBottom: false },
      'thread-b': { scrollTop: 0, followBottom: true },
    }
    persistChatScrollByThread(input)
    expect(loadChatScrollByThread()).toEqual(input)
  })

  it('survives a malformed/legacy payload (does not throw, returns {})', () => {
    globalThis.localStorage?.setItem(CHAT_SCROLL_STORAGE_KEY, '{not valid json')
    expect(() => loadChatScrollByThread()).not.toThrow()
    expect(loadChatScrollByThread()).toEqual({})
  })

  it('drops entries whose shape is wrong (defensive)', () => {
    globalThis.localStorage?.setItem(
      CHAT_SCROLL_STORAGE_KEY,
      JSON.stringify({
        'thread-good': { scrollTop: 50, followBottom: false },
        'thread-bad': { scrollTop: 'not a number', followBottom: true },
        'thread-also-bad': null,
      }),
    )
    expect(loadChatScrollByThread()).toEqual({
      'thread-good': { scrollTop: 50, followBottom: false },
    })
  })

  it('persist tolerates localStorage being unavailable (no throw)', () => {
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage disabled')
      },
    })
    try {
      expect(() => persistChatScrollByThread({ a: { scrollTop: 1, followBottom: true } })).not.toThrow()
      expect(loadChatScrollByThread()).toEqual({})
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
    }
  })
})
