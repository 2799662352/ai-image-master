import { describe, expect, it } from 'vitest'
import { buildLightArtifacts } from '../buildLightArtifacts'

describe('buildLightArtifacts', () => {
  it('maps local saved paths to lightweight image refs (no base64)', () => {
    const refs = buildLightArtifacts(['D:\\imgs\\a.png', 'D:\\imgs\\b.png'], 'image', 'codex-img-1')
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ kind: 'image', mime: 'image/png', uri: 'D:\\imgs\\a.png' })
    expect(refs[0].uri.startsWith('data:')).toBe(false)
    expect(refs[0].id).toBe('codex-img-1-0')
    expect(refs[1].uri).toBe('D:\\imgs\\b.png')
    expect(refs[1].id).toBe('codex-img-1-1')
  })

  it('passes COS/http URLs through as the uri (lightbox keeps the original)', () => {
    const url = 'https://b.cos.ap-guangzhou.myqcloud.com/image-history/x.png'
    const refs = buildLightArtifacts([url], 'image')
    expect(refs[0].uri).toBe(url)
  })

  it('builds video refs when kind is video', () => {
    const refs = buildLightArtifacts(['D:\\v\\a.mp4'], 'video')
    expect(refs[0]).toMatchObject({ kind: 'video', mime: 'video/mp4' })
    expect(refs[0].name.endsWith('.mp4')).toBe(true)
  })

  it('skips empty/blank entries', () => {
    const refs = buildLightArtifacts(['', '   ', 'D:\\imgs\\a.png'], 'image')
    expect(refs).toHaveLength(1)
    expect(refs[0].uri).toBe('D:\\imgs\\a.png')
  })

  it('returns [] for no sources', () => {
    expect(buildLightArtifacts([], 'image')).toEqual([])
  })
})
