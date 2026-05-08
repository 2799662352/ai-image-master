import chokidar, { type FSWatcher } from 'chokidar'
import { ipcMain, BrowserWindow } from 'electron'

export type WatchEvent = { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string; mtime?: number }

let watcher: FSWatcher | null = null
const watched = new Set<string>()
const listeners = new Set<(e: WatchEvent) => void>()

function ensureWatcher(): FSWatcher {
  if (watcher) return watcher
  watcher = chokidar.watch([], {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    atomic: true,
    ignoreInitial: true,
  })
  watcher.on('add', (p) => emit({ type: 'add', path: p, mtime: Date.now() }))
  watcher.on('addDir', (p) => emit({ type: 'addDir', path: p, mtime: Date.now() }))
  watcher.on('change', (p) => emit({ type: 'change', path: p, mtime: Date.now() }))
  watcher.on('unlink', (p) => emit({ type: 'unlink', path: p }))
  watcher.on('unlinkDir', (p) => emit({ type: 'unlinkDir', path: p }))
  return watcher
}

function emit(e: WatchEvent): void {
  listeners.forEach((fn) => fn(e))
}

export function startWatching(p: string, listener: (e: WatchEvent) => void): void {
  listeners.add(listener)
  if (watched.has(p)) return
  ensureWatcher().add(p)
  watched.add(p)
}

export function stopWatching(p: string): void {
  if (!watched.has(p)) return
  watcher?.unwatch(p)
  watched.delete(p)
}

export function disposeAll(): void {
  void watcher?.close()
  watcher = null
  watched.clear()
  listeners.clear()
}

export function _resetForTests(): void {
  disposeAll()
}

export function registerFsWatcherIpc(): void {
  ipcMain.handle('fs:watch-start', (_e, p: string) => {
    startWatching(p, (event) => {
      BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('fs:watch-event', event))
    })
  })
  ipcMain.handle('fs:watch-stop', (_e, p: string) => {
    stopWatching(p)
  })
}
