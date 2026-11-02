import { beforeEach, describe, expect, it } from 'vitest'
import {
  IMAGE_CHANNEL_PREFS_STORAGE_KEY,
  MAX_STORED_PINNED,
  MAX_STORED_RECENT,
  sanitizeImageChannelPrefs,
  useImageChannelPrefsStore,
} from '../imageChannelPrefs'

const stored = () => JSON.parse(localStorage.getItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY) ?? 'null')

beforeEach(() => {
  localStorage.clear()
  useImageChannelPrefsStore.getState().reload()
})

describe('sanitizeImageChannelPrefs', () => {
  it('任何不合法的输入都退成空偏好,不抛错', () => {
    for (const bad of [null, undefined, 42, 'x', [], { pinned: 'a', recent: { 0: 'b' } }]) {
      expect(sanitizeImageChannelPrefs(bad)).toEqual({ pinned: [], recent: [] })
    }
  })

  it('逐项校验:非字符串 / 空串 / 超长 / 重复的丢掉,并截断到上限', () => {
    const long = 'x'.repeat(200)
    const out = sanitizeImageChannelPrefs({
      pinned: ['a', 'a', '', 7, long, 'b'],
      recent: Array.from({ length: 30 }, (_, i) => `r${i}`),
    })
    expect(out.pinned).toEqual(['a', 'b'])
    expect(out.recent).toHaveLength(MAX_STORED_RECENT)
    expect(out.recent[0]).toBe('r0')
  })
})

describe('useImageChannelPrefsStore', () => {
  it('togglePin:钉上 → 落盘 → 再点取消', () => {
    const { togglePin } = useImageChannelPrefsStore.getState()
    togglePin('nai-diffusion-5-full')
    expect(useImageChannelPrefsStore.getState().pinned).toEqual(['nai-diffusion-5-full'])
    expect(stored().pinned).toEqual(['nai-diffusion-5-full'])
    togglePin('nai-diffusion-5-full')
    expect(useImageChannelPrefsStore.getState().pinned).toEqual([])
    expect(stored().pinned).toEqual([])
  })

  it('钉的数量封顶,再钉新的被忽略(已钉的仍可取消)', () => {
    const { togglePin } = useImageChannelPrefsStore.getState()
    for (let i = 0; i < MAX_STORED_PINNED + 5; i += 1) togglePin(`c${i}`)
    expect(useImageChannelPrefsStore.getState().pinned).toHaveLength(MAX_STORED_PINNED)
    togglePin('c0')
    expect(useImageChannelPrefsStore.getState().pinned).not.toContain('c0')
  })

  it('recordUse:最新在前、去重、封顶;连点同一个不重复写盘', () => {
    const { recordUse } = useImageChannelPrefsStore.getState()
    recordUse('a')
    recordUse('b')
    recordUse('a')
    expect(useImageChannelPrefsStore.getState().recent).toEqual(['a', 'b'])
    for (let i = 0; i < 20; i += 1) recordUse(`c${i}`)
    expect(useImageChannelPrefsStore.getState().recent).toHaveLength(MAX_STORED_RECENT)

    const before = localStorage.getItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY)
    localStorage.setItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY, 'sentinel')
    recordUse('c19')
    expect(localStorage.getItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY)).toBe('sentinel')
    expect(before).not.toBe('sentinel')
  })

  it('reload 从存储里读回;存储里是坏 JSON 也不崩', () => {
    localStorage.setItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY, JSON.stringify({ pinned: ['p'], recent: ['r'] }))
    useImageChannelPrefsStore.getState().reload()
    expect(useImageChannelPrefsStore.getState().pinned).toEqual(['p'])
    expect(useImageChannelPrefsStore.getState().recent).toEqual(['r'])

    localStorage.setItem(IMAGE_CHANNEL_PREFS_STORAGE_KEY, '{not json')
    useImageChannelPrefsStore.getState().reload()
    expect(useImageChannelPrefsStore.getState().pinned).toEqual([])
  })

  it('空 id / 超长 id 不入库', () => {
    const { togglePin, recordUse } = useImageChannelPrefsStore.getState()
    togglePin('')
    recordUse('')
    togglePin('x'.repeat(200))
    recordUse('x'.repeat(200))
    expect(useImageChannelPrefsStore.getState().pinned).toEqual([])
    expect(useImageChannelPrefsStore.getState().recent).toEqual([])
  })
})
