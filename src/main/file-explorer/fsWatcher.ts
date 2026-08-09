import chokidar, { type FSWatcher } from 'chokidar'
import { ipcMain, BrowserWindow } from 'electron'

export type WatchEvent = { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string; mtime?: number }

/**
 * 永不监视的目录。
 *
 * 监视是**递归**的,而用户打开的可能是任意目录。VS Code 出厂就带这组默认值
 * (`files.watcherExclude`),文档里明确写:不排除会在打开大目录时看到高 CPU ——
 * 它们文件极多、变动极频繁,而且没有一个是用户想在文件树里看到的。
 *
 * 注意 `.git` 此前只在**列举**时被过滤掉(fsIpc 的 readdir),**监视**时没有 ——
 * 于是它不出现在树上,却仍然在被逐个注册监视。
 */
const WATCH_IGNORED = [
  /(^|[\\/])\.git([\\/]|$)/,
  /(^|[\\/])node_modules([\\/]|$)/,
]

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
    ignored: WATCH_IGNORED,
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

/**
 * 广播必须是**模块级单例**,不能每次 watch-start 现建一个闭包。
 *
 * `listeners` 是个 Set,靠引用去重。现建的闭包每次都是新引用,于是每监视一个新路径
 * 就往 Set 里多塞一份;而 `stopWatching` 只清 `watched` 不清 `listeners`,只增不减。
 *
 * 而 `fs:watch-start` 是工作区打开时调一次、**之后每打开一个文本文件再调一次**。
 * 渲染端每收到一条事件就重列一次目录并整树重渲染 —— 打开 20 个文件后保存一次,
 * 就是 21 次 listDir + 21 次全树渲染,而且越用越慢。
 */
const broadcast = (event: WatchEvent): void => {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('fs:watch-event', event))
}

export function registerFsWatcherIpc(): void {
  ipcMain.handle('fs:watch-start', (_e, p: string) => {
    startWatching(p, broadcast)
  })
  ipcMain.handle('fs:watch-stop', (_e, p: string) => {
    stopWatching(p)
  })
}
