/**
 * MediaThumbnail 候选源链 —— 「缩略图会破」的修复。
 *
 * 复现的几种真实场景:
 *  1. 主源(数据万象缩略 URL)退避重试用尽后 → 换裸 URL → 再换本地副本;
 *  2. 全链失败 → 画占位卡(不是浏览器的裂图 + alt),点「重载」从头再来;
 *     不点也会定时自动从主源再来一轮(网络恢复后图自己回来);
 *  3. 主源是已过期的预签名 COS 链接 → 一次请求都不发,直接用本地副本。
 * 主源的重试次数用 DEFAULT_REMOTE_RETRIES 常量,别在这里写死数字。
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaThumbnail } from '../MediaThumbnail'
import { DEFAULT_REARM_INTERVAL_MS, DEFAULT_REMOTE_RETRIES, useMediaCandidates } from '../useMediaCandidates'
import { resetMediaSrcCacheForTest } from '../useResolvedMediaSrc'

const EXPIRED_COS =
  'https://aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com/x.png?q-sign-algorithm=sha1&q-ak=AKID&q-sign-time=1700000000;1700003600&q-key-time=1700000000;1700003600&q-header-list=host&q-url-param-list=&q-signature=abc'

function installReadThumb(handler: (path: string) => { ok: true; base64: string; mime: string } | { ok: false; reason: string }) {
  const readMediaThumb = vi.fn(async ({ path }: { path: string }) => handler(path))
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { readMediaThumb, readThumb: vi.fn(async (path: string) => handler(path)) },
  }
  return readMediaThumb
}

beforeEach(() => {
  resetMediaSrcCacheForTest()
  if (typeof URL.createObjectURL !== 'function') {
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => `blob:mock/${Math.random()}`), configurable: true })
  }
  if (typeof URL.revokeObjectURL !== 'function') {
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
  }
})

afterEach(() => {
  cleanup()
  delete (globalThis as unknown as { electronAPI?: unknown }).electronAPI
  vi.useRealTimers()
})

/** Drain the IPC → blob promise chain (several microtask hops; timers may be faked). */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

/**
 * Fail the current <img> until the hook gives up on that remote candidate:
 * `DEFAULT_REMOTE_RETRIES` in-place retries (each one re-arms via a backoff
 * timer, which we fast-forward) plus the final error that advances the chain.
 * Timers are only advanced by the backoff amount so the 30s auto re-arm never
 * fires by accident here. Leaves fake timers ON so a caller can advance into
 * the re-arm window; afterEach restores real timers.
 */
async function exhaustRemote(getImg: () => HTMLImageElement | null) {
  vi.useFakeTimers()
  const start = getImg()?.getAttribute('src')
  for (let i = 0; i <= DEFAULT_REMOTE_RETRIES; i++) {
    const img = getImg()
    // Stop as soon as the chain moved on, so a freshly painted next candidate
    // is never hit by a stray error.
    if (!img || img.getAttribute('src') !== start) break
    fireEvent.error(img)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    await flush()
  }
  await flush()
}

describe('MediaThumbnail fallback chain', () => {
  it('keeps the 数据万象 thumbnail as the primary and retries it several times before touching a fallback', async () => {
    installReadThumb(() => ({ ok: true, base64: 'AAAA', mime: 'image/png' }))
    const { container } = render(
      <MediaThumbnail
        src="https://bucket.cos.ap-guangzhou.myqcloud.com/a.png?imageMogr2/thumbnail/512x512%3E"
        fallbackSrcs={['https://bucket.cos.ap-guangzhou.myqcloud.com/a.png']}
        kind="image"
        name="a.png"
      />,
    )
    const img = () => container.querySelector('img')
    const primary = img()!.getAttribute('src')
    expect(primary).toContain('imageMogr2')

    vi.useFakeTimers()
    for (let i = 0; i < DEFAULT_REMOTE_RETRIES; i++) {
      fireEvent.error(img()!)
      // Still the primary after every failure short of the limit — with a backoff
      // timer pending, not an immediate hammer.
      expect(img()!.getAttribute('src')).toBe(primary)
      await act(async () => {
        vi.advanceTimersByTime(20_000)
      })
      expect(img()!.getAttribute('src')).toBe(primary)
    }
    fireEvent.error(img()!)
    expect(img()!.getAttribute('src')).toBe('https://bucket.cos.ap-guangzhou.myqcloud.com/a.png')
  })

  it('walks primary → bare url → local copy as each remote candidate is exhausted', async () => {
    installReadThumb(() => ({ ok: true, base64: 'AAAA', mime: 'image/png' }))
    const { container } = render(
      <MediaThumbnail
        src="https://bucket.cos.ap-guangzhou.myqcloud.com/a.png?imageMogr2/thumbnail/512x512%3E"
        fallbackSrcs={['https://bucket.cos.ap-guangzhou.myqcloud.com/a.png', 'local-file:///D:/out/a.png']}
        kind="image"
        name="a.png"
      />,
    )
    const img = () => container.querySelector('img')
    expect(img()?.getAttribute('src')).toContain('imageMogr2')

    await exhaustRemote(img)
    expect(img()?.getAttribute('src')).toBe('https://bucket.cos.ap-guangzhou.myqcloud.com/a.png')

    await exhaustRemote(img)
    expect(img()?.getAttribute('src')).toMatch(/^blob:/)
    expect(screen.queryByTestId('media-thumbnail-broken')).toBeNull()
  })

  it('renders the placeholder (not a bare broken <img>) once every candidate failed, and 重载 restarts the chain', async () => {
    installReadThumb(() => ({ ok: false, reason: 'ENOENT: no such file' }))
    const onClick = vi.fn()
    const { container } = render(
      <MediaThumbnail
        src="https://x.test/a.png"
        fallbackSrcs={['local-file:///D:/gone.png']}
        kind="image"
        name="a.png"
        onClick={onClick}
      />,
    )
    await exhaustRemote(() => container.querySelector('img'))

    // Local copy is missing → IPC null → chain exhausted → placeholder, no <img>.
    expect(container.querySelector('img')).toBeNull()
    const broken = screen.getByTestId('media-thumbnail-broken')
    expect(broken.getAttribute('title')).toMatch(/过期|网络/)

    // 重载 is its own button: it must not bubble into the tile's onClick (lightbox).
    // (The interactive tile is itself role=button whose name is computed from its
    // content, so scope the query to the placeholder.)
    fireEvent.click(within(broken).getByRole('button', { name: '重载' }))
    expect(onClick).not.toHaveBeenCalled()
    await flush()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.test/a.png')
  })

  it('does not give up on the placeholder: after the re-arm interval it retries from the primary on its own', async () => {
    installReadThumb(() => ({ ok: false, reason: 'ENOENT' }))
    const { container } = render(
      <MediaThumbnail src="https://x.test/a.png" fallbackSrcs={['local-file:///D:/gone.png']} kind="image" name="a.png" />,
    )
    await exhaustRemote(() => container.querySelector('img'))
    expect(screen.getByTestId('media-thumbnail-broken')).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_REARM_INTERVAL_MS)
    })
    expect(screen.queryByTestId('media-thumbnail-broken')).toBeNull()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://x.test/a.png')
  })

  it('skips an expired presigned primary without a request and paints the local copy', async () => {
    const readMediaThumb = installReadThumb(() => ({ ok: true, base64: 'AAAA', mime: 'image/png' }))
    const { container } = render(
      <MediaThumbnail src={EXPIRED_COS} fallbackSrcs={['file:///D:/out/a.png']} kind="image" name="a.png" />,
    )
    await flush()
    expect(container.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    expect(readMediaThumb.mock.calls[0][0].path).toBe('D:/out/a.png')
  })

  it('shows the placeholder immediately when the only source is an expired presigned url', () => {
    render(<MediaThumbnail src={EXPIRED_COS} kind="image" name="a.png" />)
    expect(screen.getByTestId('media-thumbnail-broken')).toBeTruthy()
  })
})

describe('useMediaCandidates', () => {
  function Probe({ candidates, maxRetries }: { candidates: string[]; maxRetries: number }) {
    // rearmIntervalMs: 0 → these probes test the in-chain policy only; auto re-arm
    // is covered by the MediaThumbnail case above.
    const s = useMediaCandidates(candidates, 'image', { maxRetries, baseDelayMs: 10, rearmIntervalMs: 0 })
    return (
      <div>
        <output data-testid="src">{s.src ?? ''}</output>
        <output data-testid="key">{s.reloadKey}</output>
        <output data-testid="exhausted">{String(s.exhausted)}</output>
        <button type="button" onClick={s.onError}>
          err
        </button>
      </div>
    )
  }

  it('retries a remote source with backoff before advancing, and never retries a blob: source', async () => {
    vi.useFakeTimers()
    render(<Probe candidates={['https://a.test/1.png', 'blob:http://localhost/x', 'https://a.test/2.png']} maxRetries={1} />)
    const err = () => screen.getByRole('button', { name: 'err' })

    fireEvent.click(err()) // retry #1 scheduled (10ms) — same source, reloadKey bumps
    expect(screen.getByTestId('src').textContent).toBe('https://a.test/1.png')
    await act(async () => {
      vi.advanceTimersByTime(10)
    })
    expect(screen.getByTestId('key').textContent).toBe('1')

    fireEvent.click(err()) // retries used up → advance
    expect(screen.getByTestId('src').textContent).toBe('blob:http://localhost/x')

    fireEvent.click(err()) // blob: is not remote → no retry, advance at once
    expect(screen.getByTestId('src').textContent).toBe('https://a.test/2.png')
    expect(screen.getByTestId('exhausted').textContent).toBe('false')

    fireEvent.click(err())
    await act(async () => {
      vi.advanceTimersByTime(10)
    })
    fireEvent.click(err())
    expect(screen.getByTestId('exhausted').textContent).toBe('true')
    expect(screen.getByTestId('src').textContent).toBe('')
  })

  it('resets to the head of the chain when the candidates change (hot-swap to the permanent COS url)', () => {
    const { rerender } = render(<Probe candidates={['https://a.test/tmp.png', 'file:///D:/1.png']} maxRetries={0} />)
    fireEvent.click(screen.getByRole('button', { name: 'err' }))
    fireEvent.click(screen.getByRole('button', { name: 'err' }))
    rerender(<Probe candidates={['https://own-bucket.cos.ap-guangzhou.myqcloud.com/1.png']} maxRetries={0} />)
    expect(screen.getByTestId('src').textContent).toBe('https://own-bucket.cos.ap-guangzhou.myqcloud.com/1.png')
    expect(screen.getByTestId('exhausted').textContent).toBe('false')
  })
})
