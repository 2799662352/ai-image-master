import { describe, expect, it, vi } from 'vitest'
import {
  ensureVideoPoster,
  parseCosUrl,
  posterKeyFor,
  posterUrlFor,
  snapshotUrlFor,
  type EnsureVideoPosterDeps,
} from '../videoPoster'

const VIDEO =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4'
const POSTER =
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4.poster.jpg'

describe('parseCosUrl', () => {
  it('extracts bucket/region/key from a COS url', () => {
    expect(parseCosUrl(VIDEO)).toEqual({
      bucket: 'image-master-1345773498',
      region: 'ap-guangzhou',
      key: 'image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4',
    })
  })

  it('strips query and hash from the key', () => {
    expect(parseCosUrl(`${VIDEO}?ci-process=snapshot&time=1#x`)?.key).toBe(
      'image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4',
    )
  })

  it('returns null for non-COS urls', () => {
    expect(parseCosUrl('https://example.com/a.mp4')).toBeNull()
    expect(parseCosUrl('blob:abc')).toBeNull()
    expect(parseCosUrl('')).toBeNull()
  })
})

describe('poster key/url derivation', () => {
  it('derives a deterministic sibling poster object (no CI params)', () => {
    expect(posterKeyFor('image-history/x/v.mp4')).toBe('image-history/x/v.mp4.poster.jpg')
    expect(posterUrlFor(parseCosUrl(VIDEO)!)).toBe(POSTER)
  })

  it('builds the verified snapshot URL with defaults', () => {
    expect(snapshotUrlFor(VIDEO)).toBe(`${VIDEO}?ci-process=snapshot&time=1&format=jpg&width=512`)
  })

  it('honours custom width/time and strips any existing query', () => {
    expect(snapshotUrlFor(`${VIDEO}?foo=1`, 256, 0)).toBe(
      `${VIDEO}?ci-process=snapshot&time=0&format=jpg&width=256`,
    )
  })
})

function makeDeps(over: Partial<EnsureVideoPosterDeps> = {}): EnsureVideoPosterDeps {
  return {
    headExists: vi.fn(async () => false),
    fetchSnapshot: vi.fn(async () => ({
      ok: true,
      status: 200,
      body: Buffer.from([0xff, 0xd8, 0xff]),
      contentType: 'image/jpeg',
    })),
    upload: vi.fn(async () => POSTER),
    ...over,
  }
}

describe('ensureVideoPoster', () => {
  it('reuses an already-persisted poster WITHOUT billing (no snapshot, no upload)', async () => {
    const deps = makeDeps({ headExists: vi.fn(async () => true) })
    const res = await ensureVideoPoster(VIDEO, deps)
    expect(res).toEqual({ ok: true, posterUrl: POSTER, generated: false })
    expect(deps.fetchSnapshot).not.toHaveBeenCalled()
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('runs ONE snapshot + upload when the poster does not exist yet', async () => {
    const deps = makeDeps()
    const res = await ensureVideoPoster(VIDEO, deps)
    expect(res).toEqual({ ok: true, posterUrl: POSTER, generated: true })
    expect(deps.fetchSnapshot).toHaveBeenCalledOnce()
    expect(deps.fetchSnapshot).toHaveBeenCalledWith(
      `${VIDEO}?ci-process=snapshot&time=1&format=jpg&width=512`,
    )
    expect(deps.upload).toHaveBeenCalledOnce()
    expect(deps.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'image-master-1345773498',
        region: 'ap-guangzhou',
        key: 'image-history/media-relay/2026/06/29/5caba59c7886f0ce.mp4.poster.jpg',
        contentType: 'image/jpeg',
      }),
    )
  })

  it('rejects non-COS urls', async () => {
    const deps = makeDeps()
    const res = await ensureVideoPoster('https://example.com/a.mp4', deps)
    expect(res.ok).toBe(false)
    expect(deps.fetchSnapshot).not.toHaveBeenCalled()
  })

  it('does not upload when the snapshot HTTP fails', async () => {
    const deps = makeDeps({
      fetchSnapshot: vi.fn(async () => ({ ok: false, status: 404, body: Buffer.alloc(0) })),
    })
    const res = await ensureVideoPoster(VIDEO, deps)
    expect(res.ok).toBe(false)
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('does not upload when the snapshot returns a non-image body (XML error)', async () => {
    const deps = makeDeps({
      fetchSnapshot: vi.fn(async () => ({
        ok: true,
        status: 200,
        body: Buffer.from('<Error/>'),
        contentType: 'application/xml',
      })),
    })
    const res = await ensureVideoPoster(VIDEO, deps)
    expect(res.ok).toBe(false)
    expect(deps.upload).not.toHaveBeenCalled()
  })

  it('falls through to generation if the HEAD existence check throws', async () => {
    const deps = makeDeps({
      headExists: vi.fn(async () => {
        throw new Error('network')
      }),
    })
    const res = await ensureVideoPoster(VIDEO, deps)
    expect(res).toMatchObject({ ok: true, generated: true })
    expect(deps.upload).toHaveBeenCalledOnce()
  })
})
