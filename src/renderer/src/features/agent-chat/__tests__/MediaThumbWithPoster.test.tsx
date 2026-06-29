import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaThumbWithPoster } from '../MediaThumbWithPoster'
import {
  __resetVideoPosterCacheForTests,
  getCachedPoster,
  setCachedPoster,
} from '../videoPosterCache'

const COS_VIDEO =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4'
const PERSISTED_POSTER = `${COS_VIDEO}.poster.jpg`

type AnyGlobal = typeof globalThis & {
  electronAPI?: { attachments?: { ensureVideoPoster?: (u: string) => Promise<unknown> } }
}

afterEach(() => {
  cleanup()
  __resetVideoPosterCacheForTests()
  delete (globalThis as AnyGlobal).electronAPI
  vi.restoreAllMocks()
})

beforeEach(() => __resetVideoPosterCacheForTests())

function mockEnsure(impl: (u: string) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl)
  ;(globalThis as AnyGlobal).electronAPI = { attachments: { ensureVideoPoster: fn } }
  return fn
}

describe('MediaThumbWithPoster (shared video-poster surface)', () => {
  it('generates the poster once via IPC, caches it, and keeps the video src plain', async () => {
    const ensure = mockEnsure(async () => ({
      ok: true,
      posterUrl: PERSISTED_POSTER,
      generated: true,
    }))

    const { container } = render(
      <MediaThumbWithPoster src={COS_VIDEO} videoUri={COS_VIDEO} kind="video" name="clip.mp4" />,
    )
    const video = container.querySelector('video')
    expect(video?.getAttribute('src')).toBe(COS_VIDEO)
    expect(video?.getAttribute('src') ?? '').not.toContain('ci-process')

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('poster')).toBe(PERSISTED_POSTER)
    })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(COS_VIDEO)
    expect(getCachedPoster(COS_VIDEO)).toBe(PERSISTED_POSTER)
  })

  it('uses the cached poster synchronously without calling the IPC', () => {
    setCachedPoster(COS_VIDEO, PERSISTED_POSTER)
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))

    const { container } = render(
      <MediaThumbWithPoster src={COS_VIDEO} videoUri={COS_VIDEO} kind="video" />,
    )
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(PERSISTED_POSTER)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('prefers an explicit thumbnailUri and never calls the IPC', () => {
    const thumb = 'https://cdn.test/poster.jpg'
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))

    const { container } = render(
      <MediaThumbWithPoster
        src={COS_VIDEO}
        videoUri={COS_VIDEO}
        thumbnailUri={thumb}
        kind="video"
      />,
    )
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(thumb)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('emits no poster for a non-COS video and never calls the IPC', () => {
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))
    const { container } = render(
      <MediaThumbWithPoster
        src="https://example.com/a.mp4"
        videoUri="https://example.com/a.mp4"
        kind="video"
      />,
    )
    const video = container.querySelector('video')
    expect(video?.getAttribute('poster')).toBeNull()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('renders an image (no poster) and never calls the IPC', () => {
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))
    const { container } = render(
      <MediaThumbWithPoster src={COS_VIDEO} videoUri={COS_VIDEO} kind="image" name="a.png" />,
    )
    expect(container.querySelector('img')).toBeTruthy()
    expect(container.querySelector('video')).toBeNull()
    expect(ensure).not.toHaveBeenCalled()
  })
})
