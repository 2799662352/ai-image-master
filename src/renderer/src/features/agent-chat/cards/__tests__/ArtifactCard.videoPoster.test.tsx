import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactItem } from '../../../../../../types/agent-timeline'
import { ArtifactCard } from '../ArtifactCard'
import {
  __resetVideoPosterCacheForTests,
  getCachedPoster,
  setCachedPoster,
} from '../../videoPosterCache'

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

function videoItem(uri: string, thumbnailUri?: string): ArtifactItem {
  return {
    type: 'artifact',
    id: 'art_v1',
    startedAt: 1,
    endedAt: 2,
    status: 'done',
    artifacts: [
      {
        id: 'vid_1',
        kind: 'video',
        name: 'clip.mp4',
        mime: 'video/mp4',
        size: 10,
        uri,
        ...(thumbnailUri ? { thumbnailUri } : {}),
      },
    ],
  }
}

function mockEnsure(impl: (u: string) => Promise<unknown>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl)
  ;(globalThis as AnyGlobal).electronAPI = { attachments: { ensureVideoPoster: fn } }
  return fn
}

describe('ArtifactCard video bubble — persisted poster (bill-once)', () => {
  it('generates the poster once via IPC, caches it, and uses the static URL', async () => {
    const ensure = mockEnsure(async () => ({
      ok: true,
      posterUrl: PERSISTED_POSTER,
      generated: true,
    }))

    const { container } = render(<ArtifactCard item={videoItem(COS_VIDEO)} />)
    const video = container.querySelector('video')
    expect(video).toBeTruthy()
    // The video src stays the plain mp4 (never an imageMogr2 / ci-process URL).
    expect(video?.getAttribute('src')).toBe(COS_VIDEO)
    expect(video?.getAttribute('src') ?? '').not.toContain('ci-process')

    await waitFor(() => {
      expect(container.querySelector('video')?.getAttribute('poster')).toBe(PERSISTED_POSTER)
    })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure).toHaveBeenCalledWith(COS_VIDEO)
    // And it persisted to the client cache so future renders skip the IPC.
    expect(getCachedPoster(COS_VIDEO)).toBe(PERSISTED_POSTER)
  })

  it('uses the cached poster synchronously and does NOT call the IPC again', () => {
    setCachedPoster(COS_VIDEO, PERSISTED_POSTER)
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))

    const { container } = render(<ArtifactCard item={videoItem(COS_VIDEO)} />)
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(PERSISTED_POSTER)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('prefers an explicit thumbnailUri and never calls the IPC', () => {
    const thumb = 'https://cdn.test/poster.jpg'
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))

    const { container } = render(<ArtifactCard item={videoItem(COS_VIDEO, thumb)} />)
    expect(container.querySelector('video')?.getAttribute('poster')).toBe(thumb)
    expect(ensure).not.toHaveBeenCalled()
  })

  it('emits no poster for a non-COS video and never calls the IPC', () => {
    const ensure = mockEnsure(async () => ({ ok: true, posterUrl: 'x', generated: false }))
    const { container } = render(<ArtifactCard item={videoItem('https://example.com/a.mp4')} />)
    const video = container.querySelector('video')
    expect(video).toBeTruthy()
    expect(video?.getAttribute('poster')).toBeNull()
    expect(ensure).not.toHaveBeenCalled()
  })
})
