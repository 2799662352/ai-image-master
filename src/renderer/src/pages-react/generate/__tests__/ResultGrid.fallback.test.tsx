/**
 * 生成页结果格的缩略图兜底链:
 *   数据万象缩略 URL(主源,多次退避重试)→ 裸 URL → 本地副本(meta.localPath)
 *   → 占位卡(定时自动从主源再来)+ 手动重载。
 * 对应用户反馈「生成页有时候缩略图会破(翻墙时可能没有)」:数据万象缩略 URL 为主,
 * 但不能失败两次就放弃。
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResultUploadMeta } from '../../../stores/useGenerateStore'
import { DEFAULT_REARM_INTERVAL_MS, DEFAULT_REMOTE_RETRIES } from '../../../components/shared/media/useMediaCandidates'
import { resetMediaSrcCacheForTest } from '../../../components/shared/media/useResolvedMediaSrc'
import { ResultGrid } from '../ResultGrid'

vi.mock('../../../components/shared/image-editors/ImageEditToolbar', () => ({ default: () => null }))
vi.mock('../../../components/shared/image-editors/ImageEditorModal', () => ({ default: () => null }))
vi.mock('../LayerStackViewer', () => ({ LayerStackViewer: () => null }))

const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/history/a.png'

function meta(over: Partial<ResultUploadMeta> = {}): ResultUploadMeta {
  return { id: 'r1', modelUrl: COS, uploadStatus: 'uploaded', cosUrl: COS, ...over }
}

function installReadThumb(ok: boolean) {
  const readMediaThumb = vi.fn(async (_args: { path: string; size?: number }) =>
    ok ? { ok: true as const, base64: 'AAAA', mime: 'image/png' } : { ok: false as const, reason: 'ENOENT' },
  )
  ;(globalThis as unknown as { electronAPI?: unknown }).electronAPI = { attachments: { readMediaThumb, readThumb: readMediaThumb } }
  return readMediaThumb
}

/** Drain the IPC → blob promise chain (several microtask hops; timers may be faked). */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve()
  })
}

/**
 * Fail the current remote candidate until the chain moves off it: at most
 * `DEFAULT_REMOTE_RETRIES` in-place retries plus the advancing error, stopping
 * as soon as the <img> src changes (or disappears) so a freshly painted next
 * candidate is never hit by a stray error. Leaves fake timers ON (afterEach
 * restores real timers) so a test can advance into the auto re-arm window.
 */
async function exhaustRemote() {
  vi.useFakeTimers()
  const start = document.querySelector('img')?.getAttribute('src')
  for (let i = 0; i <= DEFAULT_REMOTE_RETRIES; i++) {
    const img = document.querySelector('img')
    if (!img || img.getAttribute('src') !== start) break
    fireEvent.error(img)
    await act(async () => {
      vi.advanceTimersByTime(20_000) // past the longest backoff, short of the auto re-arm
    })
    await flush()
  }
  await flush()
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

describe('ResultGrid thumbnail fallback', () => {
  it('keeps the 数据万象 thumbnail as the primary through its retries, then the bare COS url, then the local copy', async () => {
    const readMediaThumb = installReadThumb(true)
    render(<ResultGrid urls={[COS]} meta={[meta({ localPath: 'D:\\gen\\a.png' })]} />)
    const src = () => document.querySelector('img')?.getAttribute('src')
    const primary = src()
    expect(primary).toContain('imageMogr2/thumbnail/1024x1024')

    // One failure (or two) is not a reason to leave the primary.
    vi.useFakeTimers()
    fireEvent.error(document.querySelector('img')!)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    fireEvent.error(document.querySelector('img')!)
    await act(async () => {
      vi.advanceTimersByTime(20_000)
    })
    expect(src()).toBe(primary)

    await exhaustRemote()
    expect(src()).toBe(COS)

    await exhaustRemote()
    expect(src()).toMatch(/^blob:/)
    expect(readMediaThumb).toHaveBeenCalledTimes(1)
    // 2 列布局的卡片较宽,本地副本也按 1024 读,不用 256 的聊天小图。
    expect(readMediaThumb.mock.calls[0][0]).toMatchObject({ size: 1024 })
  })

  it('paints the placeholder with 重载 only after the local copy also fails, and 重载 restarts from the CI thumbnail', async () => {
    installReadThumb(false)
    const onPreview = vi.fn()
    render(<ResultGrid urls={[COS]} meta={[meta({ localPath: 'D:\\gen\\gone.png', uploadStatus: 'failed' })]} onPreview={onPreview} />)

    await exhaustRemote() // CI thumbnail
    await exhaustRemote() // bare url; the local copy then fails via IPC → placeholder
    expect(document.querySelector('img')).toBeNull()
    const placeholder = screen.getByRole('img', { name: /加载失败/ })
    expect(placeholder.textContent).toContain('图片加载失败')

    fireEvent.click(screen.getByRole('button', { name: '重载' }))
    // 重载 must not also open the lightbox (the whole card is clickable).
    expect(onPreview).not.toHaveBeenCalled()
    await flush()
    expect(document.querySelector('img')?.getAttribute('src')).toContain('imageMogr2')
  })

  it('does not give up on the placeholder: auto re-arms from the 数据万象 thumbnail after the interval', async () => {
    installReadThumb(false)
    render(<ResultGrid urls={[COS]} meta={[meta({ localPath: 'D:\\gen\\gone.png', uploadStatus: 'failed' })]} />)
    await exhaustRemote()
    await exhaustRemote()
    expect(document.querySelector('img')).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_REARM_INTERVAL_MS)
    })
    expect(document.querySelector('img')?.getAttribute('src')).toContain('imageMogr2')
  })

  it('puts the persisted 1024 sibling object first for a dated image-history url, and one 404 hands over to imageMogr2 without retrying', async () => {
    installReadThumb(true)
    const dated = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/09/15/004f299ed8d3400a.png'
    render(<ResultGrid urls={[dated]} meta={[meta({ modelUrl: dated, cosUrl: dated, localPath: 'D:\\gen\\a.png' })]} />)
    const src = () => document.querySelector('img')?.getAttribute('src')
    expect(src()).toBe(dated.replace(/\.png$/, '.thumb1024.webp'))

    vi.useFakeTimers()
    fireEvent.error(document.querySelector('img')!)
    expect(src()).toBe(`${dated}?imageMogr2/thumbnail/1024x1024%3E/format/webp/quality/85/ignore-error/1`)
  })

  it('never requests an expired presigned model url — goes straight to the local copy', async () => {
    installReadThumb(true)
    const expired = 'https://aigc-output-image-1326893053.cos.ap-guangzhou.myqcloud.com/x.png?q-sign-time=1700000000;1700003600&q-signature=abc'
    render(<ResultGrid urls={[expired]} meta={[meta({ modelUrl: expired, cosUrl: undefined, uploadStatus: 'failed', localPath: 'D:\\gen\\x.png' })]} />)
    await flush()
    expect(document.querySelector('img')?.getAttribute('src')).toMatch(/^blob:/)
  })
})
