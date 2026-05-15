import { BrowserWindow } from 'electron'
import parcelWatcher from '@parcel/watcher'

/**
 * Recursive directory watcher for the agent attachments uploads folder.
 *
 * Backed by @parcel/watcher — the same native watching engine VSCode uses:
 *   https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts
 *   https://github.com/parcel-bundler/watcher
 *
 *  - Cross-platform native backends with prebuilt binaries (no node-gyp at
 *    install time): ReadDirectoryChangesW on Windows, FSEvents on macOS,
 *    inotify on Linux, kqueue on FreeBSD. Optional dependencies ship the
 *    `.node` per platform, so electron-builder just `asarUnpack`s them.
 *  - C++ event throttling/coalescing — handles `git checkout` / `npm install`
 *    bursts that previously could exhaust chokidar's ReadDirectoryChangesW
 *    buffer on Windows and silently drop events (e.g. `robocopy /MT:32`).
 *  - Two-level coalescing aligned with VSCode's parcelWatcher.ts:
 *      1. Native C++ debounce inside parcel (per-callback batches).
 *      2. 75ms trailing-edge JS aggregator (`HANDLER_DELAY_MS`, mirrors
 *         VSCode's `FILE_CHANGES_HANDLER_DELAY = 75`) for the case where
 *         two ingest()s land in back-to-back callbacks.
 *  - Content-free renderer signal: send `attachments:changed` and let the
 *    renderer pull a fresh tree via `attachments:list-tree`. Same separation
 *    as VSCode's "watcher emits events, consumers pull state" pattern.
 *  - Graceful failure: if the native watcher can't start (sandbox, EACCES,
 *    macOS seatbelt, ENOSPC inotify), we log and the AttachmentService.emit
 *    in-process success signal remains as defense-in-depth.
 */

const HANDLER_DELAY_MS = 75 // matches VSCode parcelWatcher.FILE_CHANGES_HANDLER_DELAY

/**
 * AttachmentService.ingestOne writes `_tmp_<uuid>.<ext>` then renames to
 * `<sha>.<ext>` (see src/main/agent/AttachmentService.ts). Each ingest thus
 * surfaces as 3 parcel events: create tmp → delete tmp → create sha. Only the
 * final `<sha>.<ext>` create reflects panel-visible state.
 *
 * Filtering tmp events at the C++ layer via parcel's `ignore` option (same
 * mechanism VSCode uses for `.git/`, `node_modules/.cache/`, etc.) cuts event
 * volume by ~2/3 during ingest bursts and removes the create-then-delete
 * coalescing edge case in parcel's Debounce.cc where rapidly-renamed tmp
 * files could mask legitimate sha creates.
 *
 * Burst-protection note: parcel's own C++ Debounce already caps the silent
 * period at `MAX_WAIT_TIME = 500ms` (Debounce.cc) — even during sustained
 * 60-second robocopy storms, the callback fires at least every ~500ms. So
 * the 75ms JS aggregator below stays a simple sliding debounce; we do NOT
 * need an additional max-wait JS layer.
 */
const IGNORE_PATTERNS: readonly string[] = ['**/_tmp_*']

type ParcelEvent = parcelWatcher.Event
type ParcelSubscribeCallback = parcelWatcher.SubscribeCallback
type ParcelAsyncSubscription = parcelWatcher.AsyncSubscription
type ParcelSubscribeFn = (
  dir: string,
  cb: ParcelSubscribeCallback,
  opts?: parcelWatcher.Options,
) => Promise<ParcelAsyncSubscription>

export interface AttachmentDirWatcherDeps {
  subscribe?: ParcelSubscribeFn
  getWindows?: () => BrowserWindow[]
}

export class AttachmentDirWatcher {
  private aggregator: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private subscription: ParcelAsyncSubscription | null = null
  private readonly subscribeFn: ParcelSubscribeFn
  private readonly getWindows: () => BrowserWindow[]

  constructor(
    private readonly uploadsDir: string,
    deps: AttachmentDirWatcherDeps = {},
  ) {
    this.subscribeFn = deps.subscribe ?? parcelWatcher.subscribe
    this.getWindows = deps.getWindows ?? ((): BrowserWindow[] => BrowserWindow.getAllWindows())
  }

  async start(): Promise<void> {
    try {
      const sub = await this.subscribeFn(
        this.uploadsDir,
        (err, events) => this.onParcelCallback(err, events),
        { ignore: [...IGNORE_PATTERNS] },
      )
      // Handle the race where dispose() ran while subscribe() was in flight.
      // VSCode's parcelWatcher.ts uses the same "if stopped, immediately
      // unsubscribe" pattern in its onWatchFailed path.
      if (this.disposed) {
        await sub.unsubscribe().catch(() => {})
        return
      }
      this.subscription = sub
    } catch (err) {
      // VSCode parcelWatcher fires `_onDidWatchFail`; we just log so callers
      // know the FS watcher is degraded. The AttachmentService event path
      // (in-process success signal) keeps the renderer panel in sync for the
      // common case (chat uploads). External writes will only show up after
      // an explicit refresh, but that's the same fallback profile VSCode
      // documents for sandboxed/permission-blocked environments.
      console.warn('[AttachmentDirWatcher] failed to start parcel watcher:', err)
    }
  }

  private onParcelCallback(err: Error | null, events: ParcelEvent[]): void {
    if (this.disposed) return
    if (err) {
      // Backend error (e.g. inotify queue overflow, FSEvents stream dropped).
      // VSCode reacts by re-establishing the watcher; for our single-dir
      // scope, the next user action will trigger a refresh anyway, and
      // AttachmentService.emit covers in-process uploads. Log and continue
      // — never throw out of a native callback.
      console.warn('[AttachmentDirWatcher] parcel callback error:', err)
      return
    }
    if (!events || events.length === 0) return

    if (this.aggregator) clearTimeout(this.aggregator)
    this.aggregator = setTimeout(() => {
      this.aggregator = null
      if (this.disposed) return
      this.broadcast()
    }, HANDLER_DELAY_MS)
  }

  private broadcast(): void {
    for (const win of this.getWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('attachments:changed')
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.aggregator) {
      clearTimeout(this.aggregator)
      this.aggregator = null
    }
    const sub = this.subscription
    this.subscription = null
    if (sub) {
      try {
        await sub.unsubscribe()
      } catch {
        // unsubscribe is idempotent from our perspective; the native side may
        // already be torn down. Swallow so we don't crash app shutdown.
      }
    }
  }
}
