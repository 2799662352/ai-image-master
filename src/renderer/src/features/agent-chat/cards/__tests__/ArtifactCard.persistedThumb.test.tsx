/**
 * 出图气泡的缩略图候选链(2026-09-15 持久化缩略图上线后):
 *   桶里已存的 .thumb512.webp(普通对象)→ 实时 imageMogr2 → 裸 URL → 本地副本。
 * 老图没有持久化对象:它的 404 不许原地重试,一次错就换实时万象。
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactItem } from '../../../../../../types/agent-timeline'
import { ArtifactCard } from '../ArtifactCard'

const ORIGINAL = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/09/15/004f299ed8d3400a.png'
const PERSISTED = ORIGINAL.replace(/\.png$/, '.thumb512.webp')

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function imageItem(uri: string, fallbackUris?: string[]): ArtifactItem {
  return {
    type: 'artifact',
    id: 'art_i1',
    startedAt: 1,
    endedAt: 2,
    status: 'done',
    artifacts: [{ id: 'img_1', kind: 'image', name: 'codex-image-1.png', mime: 'image/png', size: 0, uri, ...(fallbackUris ? { fallbackUris } : {}) }],
  }
}

describe('ArtifactCard image bubble — persisted 数据万象 thumbnail first', () => {
  it('paints the persisted sibling object first for a dated image-history original', () => {
    const { container } = render(<ArtifactCard item={imageItem(ORIGINAL)} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PERSISTED)
  })

  it('a legacy original without the persisted object: ONE error → real-time imageMogr2 at once, then bare url after its retries', async () => {
    vi.useFakeTimers()
    const { container } = render(<ArtifactCard item={imageItem(ORIGINAL, ['file:///D:/out/1.png'])} />)
    const img = () => container.querySelector('img')!

    fireEvent.error(img())
    // No in-place retry for the persisted candidate — straight to 数据万象 real-time.
    expect(img().getAttribute('src')).toBe(`${ORIGINAL}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`)

    // The real-time thumbnail keeps its backoff retries (primary semantics).
    fireEvent.error(img())
    expect(img().getAttribute('src')).toContain('imageMogr2')
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(img().getAttribute('src')).toContain('imageMogr2')
  })

  it('does not invent a persisted sibling for sources outside the dated image-history layout', () => {
    const other = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/history/a.png'
    const { container } = render(<ArtifactCard item={imageItem(other)} />)
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`${other}?imageMogr2/thumbnail/512x512%3E/format/webp/quality/85/ignore-error/1`)
  })
})
