import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttachmentDirWatcher } from '../AttachmentDirWatcher'

// @parcel/watcher event/subscription shape (see index.d.ts in node_modules/@parcel/watcher).
interface ParcelEvent {
  type: 'create' | 'update' | 'delete'
  path: string
}
type ParcelSubscribeCallback = (err: Error | null, events: ParcelEvent[]) => unknown
interface ParcelAsyncSubscription {
  unsubscribe: () => Promise<void>
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function makeWin(): { isDestroyed: () => boolean; webContents: { send: ReturnType<typeof vi.fn> } } {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  }
}

describe('AttachmentDirWatcher (@parcel/watcher, VSCode-aligned)', () => {
  it('subscribes to the uploads dir via @parcel/watcher when started', async () => {
    const subscribeFn = vi.fn(async () => ({ unsubscribe: vi.fn() }) as ParcelAsyncSubscription)
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()

    expect(subscribeFn).toHaveBeenCalledTimes(1)
    expect(subscribeFn).toHaveBeenCalledWith('/uploads', expect.any(Function), expect.any(Object))
  })

  it('passes ignore patterns to parcel so AttachmentService _tmp_* noise never crosses the C++→JS boundary', async () => {
    // VSCode aligns with parcel by passing `excludes` patterns (.git/, node_modules/.cache/,
    // etc.) through the `ignore` option so the native layer filters them before any JS
    // work — same engine, same option, same intent.
    //
    // For us: AttachmentService.ingestOne writes `_tmp_<uuid>.<ext>` then renames to
    // `<sha>.<ext>`, surfacing as 3 parcel events (create tmp, delete tmp, create sha).
    // Only the final `<sha>.<ext>` create reflects panel-visible state. Filtering tmp
    // events at the C++ layer cuts event volume by ~2/3 during ingest bursts and
    // removes spurious "create-then-delete = no event" coalescing edge cases that
    // would otherwise hide legitimate creates.
    const subscribeFn = vi.fn(async () => ({ unsubscribe: vi.fn() }) as ParcelAsyncSubscription)

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [],
    })
    await watcher.start()

    const [, , opts] = subscribeFn.mock.calls[0]
    expect(opts).toBeDefined()
    expect(opts!.ignore).toContain('**/_tmp_*')
  })

  it('broadcasts attachments:changed after the 75ms aggregator window — mirrors VSCode FILE_CHANGES_HANDLER_DELAY', async () => {
    let captured: ParcelSubscribeCallback | null = null
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe: vi.fn() } as ParcelAsyncSubscription
    })
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()

    captured!(null, [{ type: 'create', path: '/uploads/abc.png' }])
    vi.advanceTimersByTime(74)
    expect(win.webContents.send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
    expect(win.webContents.send).toHaveBeenCalledWith('attachments:changed')
  })

  it('coalesces a parcel-batch + later callback into a single broadcast within 75ms window', async () => {
    // Parcel already coalesces inside one callback (its C++ debounce), but if
    // multiple callback firings happen within the 75ms window (e.g. two
    // separate ingest() runs), we still want one renderer broadcast.
    let captured: ParcelSubscribeCallback | null = null
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe: vi.fn() } as ParcelAsyncSubscription
    })
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()

    captured!(null, [
      { type: 'create', path: '/uploads/_tmp_a.png' },
      { type: 'delete', path: '/uploads/_tmp_a.png' },
      { type: 'create', path: '/uploads/sha-a.png' },
    ])
    vi.advanceTimersByTime(20)
    captured!(null, [{ type: 'create', path: '/uploads/sha-b.png' }])
    vi.advanceTimersByTime(20)
    captured!(null, [{ type: 'create', path: '/uploads/sha-c.png' }])

    vi.advanceTimersByTime(75)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)
  })

  it('ignores empty parcel event batches', async () => {
    let captured: ParcelSubscribeCallback | null = null
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe: vi.fn() } as ParcelAsyncSubscription
    })
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()

    captured!(null, [])
    vi.advanceTimersByTime(200)
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('logs parcel callback errors but stays alive — degraded watch, not crash', async () => {
    // VSCode parcelWatcher fires `_onDidWatchFail` on backend errors instead
    // of tearing down. We mirror that resilience.
    let captured: ParcelSubscribeCallback | null = null
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe: vi.fn() } as ParcelAsyncSubscription
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()

    captured!(new Error('ENOSPC inotify watches exhausted'), [])
    vi.advanceTimersByTime(200)
    expect(warn).toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()

    captured!(null, [{ type: 'create', path: '/uploads/y.png' }])
    vi.advanceTimersByTime(75)
    expect(win.webContents.send).toHaveBeenCalledTimes(1)

    warn.mockRestore()
  })

  it('skips destroyed windows so closed renderers never crash send()', async () => {
    let captured: ParcelSubscribeCallback | null = null
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe: vi.fn() } as ParcelAsyncSubscription
    })
    const live = makeWin()
    const dead = { isDestroyed: () => true, webContents: { send: vi.fn() } }

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [live as never, dead as never],
    })
    await watcher.start()

    captured!(null, [{ type: 'create', path: '/uploads/x.png' }])
    vi.advanceTimersByTime(75)

    expect(live.webContents.send).toHaveBeenCalledWith('attachments:changed')
    expect(dead.webContents.send).not.toHaveBeenCalled()
  })

  it('start() never throws when subscribe() rejects — AttachmentService.emit is the fallback', async () => {
    const subscribeFn = vi.fn(async () => {
      throw new Error('EACCES / sandbox blocked / backend boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [],
    })

    await expect(watcher.start()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('dispose() unsubscribes and cancels any pending broadcast', async () => {
    let captured: ParcelSubscribeCallback | null = null
    const unsubscribe = vi.fn(async () => {})
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe } as ParcelAsyncSubscription
    })
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()
    captured!(null, [{ type: 'create', path: '/uploads/x.png' }])
    await watcher.dispose()

    vi.advanceTimersByTime(200)

    expect(unsubscribe).toHaveBeenCalled()
    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('events after dispose() are ignored (no late firings)', async () => {
    let captured: ParcelSubscribeCallback | null = null
    const subscribeFn = vi.fn(async (_p: string, cb: ParcelSubscribeCallback) => {
      captured = cb
      return { unsubscribe: vi.fn() } as ParcelAsyncSubscription
    })
    const win = makeWin()

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [win as never],
    })
    await watcher.start()
    await watcher.dispose()

    captured!(null, [{ type: 'create', path: '/uploads/x.png' }])
    vi.advanceTimersByTime(200)

    expect(win.webContents.send).not.toHaveBeenCalled()
  })

  it('dispose() before start() resolves cleans up once subscription arrives (race-safe)', async () => {
    // Common app-shutdown race: dispose() called while subscribe() Promise is
    // still in flight. We must still unsubscribe when the Promise resolves,
    // otherwise we leak the native watcher.
    const unsubscribe = vi.fn(async () => {})
    let resolveSub: ((s: ParcelAsyncSubscription) => void) | null = null
    const subscribeFn = vi.fn(
      () =>
        new Promise<ParcelAsyncSubscription>(resolve => {
          resolveSub = resolve
        }),
    )

    const watcher = new AttachmentDirWatcher('/uploads', {
      subscribe: subscribeFn,
      getWindows: () => [],
    })

    const startPromise = watcher.start()
    await watcher.dispose()
    resolveSub!({ unsubscribe })
    await startPromise

    // Flush microtasks so the resolved subscription gets cleaned up.
    await vi.runAllTimersAsync()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
