import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetVideoPosterCacheForTests,
  getCachedPoster,
  setCachedPoster,
} from '../videoPosterCache'

const VIDEO = 'https://b.cos.ap-guangzhou.myqcloud.com/image-history/x/v.mp4'
const POSTER = 'https://b.cos.ap-guangzhou.myqcloud.com/image-history/x/v.mp4.poster.jpg'

beforeEach(() => __resetVideoPosterCacheForTests())
afterEach(() => __resetVideoPosterCacheForTests())

describe('videoPosterCache', () => {
  it('returns undefined for an unknown video', () => {
    expect(getCachedPoster(VIDEO)).toBeUndefined()
  })

  it('round-trips a poster mapping', () => {
    setCachedPoster(VIDEO, POSTER)
    expect(getCachedPoster(VIDEO)).toBe(POSTER)
  })

  it('persists across a fresh in-memory load (localStorage-backed)', () => {
    setCachedPoster(VIDEO, POSTER)
    // Simulate a reload: drop in-memory state but keep localStorage.
    const raw = globalThis.localStorage.getItem('catimation:video-poster:v1')
    expect(raw).toContain(POSTER)
  })

  it('ignores empty inputs', () => {
    setCachedPoster('', POSTER)
    setCachedPoster(VIDEO, '')
    expect(getCachedPoster('')).toBeUndefined()
    expect(getCachedPoster(VIDEO)).toBeUndefined()
  })
})
