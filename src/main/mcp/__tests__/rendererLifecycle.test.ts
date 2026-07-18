import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { IMAGE_TASK_RENDERER_GONE_ERROR } from '../tools/imageTaskRegistry'
import { wireRendererLifecycle } from '../rendererLifecycle'

function makeDeps() {
  return {
    failAllRunningImageTasks: vi.fn().mockReturnValue(0),
    getRouter: vi.fn().mockReturnValue({ failAllPending: vi.fn().mockReturnValue(0) }),
  }
}

function makeContents(): EventEmitter {
  return new EventEmitter()
}

describe('wireRendererLifecycle', () => {
  it('fails running image tasks and pending renderer tools on render-process-gone', () => {
    const contents = makeContents()
    const deps = makeDeps()
    const router = { failAllPending: vi.fn().mockReturnValue(1) }
    deps.getRouter.mockReturnValue(router)
    wireRendererLifecycle(contents as never, deps)

    contents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(deps.failAllRunningImageTasks).toHaveBeenCalledWith(IMAGE_TASK_RENDERER_GONE_ERROR)
    expect(router.failAllPending).toHaveBeenCalledTimes(1)
    expect(String(router.failAllPending.mock.calls[0][0])).toContain('crashed')
  })

  it('settles on a main-frame reload (did-start-navigation, not same-document)', () => {
    const contents = makeContents()
    const deps = makeDeps()
    wireRendererLifecycle(contents as never, deps)

    // Electron >=25 structured event object carries the flags.
    contents.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: false, url: 'file:///index.html' },
    )

    expect(deps.failAllRunningImageTasks).toHaveBeenCalledWith(IMAGE_TASK_RENDERER_GONE_ERROR)
  })

  it('ignores in-page hash navigation (same-document)', () => {
    const contents = makeContents()
    const deps = makeDeps()
    wireRendererLifecycle(contents as never, deps)

    contents.emit(
      'did-start-navigation',
      { isMainFrame: true, isSameDocument: true, url: 'file:///index.html#generate' },
    )

    expect(deps.failAllRunningImageTasks).not.toHaveBeenCalled()
    expect(deps.getRouter).not.toHaveBeenCalled()
  })

  it('ignores subframe navigations', () => {
    const contents = makeContents()
    const deps = makeDeps()
    wireRendererLifecycle(contents as never, deps)

    contents.emit(
      'did-start-navigation',
      { isMainFrame: false, isSameDocument: false, url: 'https://example.com/frame' },
    )

    expect(deps.failAllRunningImageTasks).not.toHaveBeenCalled()
  })

  it('falls back to legacy positional args when the event object has no flags', () => {
    const contents = makeContents()
    const deps = makeDeps()
    wireRendererLifecycle(contents as never, deps)

    // Legacy signature: (event, url, isInPlace, isMainFrame, ...)
    contents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    expect(deps.failAllRunningImageTasks).toHaveBeenCalledTimes(1)

    // In-place (same-document) legacy navigation is skipped.
    contents.emit('did-start-navigation', {}, 'file:///index.html#tab', true, true)
    expect(deps.failAllRunningImageTasks).toHaveBeenCalledTimes(1)
  })

  it('survives a null router (MCP listener unavailable)', () => {
    const contents = makeContents()
    const deps = makeDeps()
    deps.getRouter.mockReturnValue(null)
    wireRendererLifecycle(contents as never, deps)

    expect(() => contents.emit('render-process-gone', {}, { reason: 'killed' })).not.toThrow()
    expect(deps.failAllRunningImageTasks).toHaveBeenCalledTimes(1)
  })

  it('is idempotent per webContents — wiring twice does not stack listeners', () => {
    const contents = makeContents()
    const deps = makeDeps()
    wireRendererLifecycle(contents as never, deps)
    wireRendererLifecycle(contents as never, deps)

    contents.emit('render-process-gone', {}, { reason: 'crashed' })

    expect(deps.failAllRunningImageTasks).toHaveBeenCalledTimes(1)
  })
})
