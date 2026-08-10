import { promises as fsp, watch as nodeWatch, type FSWatcher as NodeFSWatcher } from 'node:fs'
import path from 'node:path'
import parcelWatcher from '@parcel/watcher'
import { ipcMain, BrowserWindow } from 'electron'

export type WatchEvent = { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string; mtime?: number }

/**
 * 工作区文件监视。
 *
 * 按 VSCode 的分工拆成两种监视器,而不是一种通吃:
 *
 *   - **目录**(工作区根)走 `@parcel/watcher` 的原生递归监视 —— Windows 用
 *     ReadDirectoryChangesW、macOS 用 FSEvents、Linux 用 inotify。一个根一个
 *     内核句柄,不在 JS 里遍历目录树。
 *   - **单个文件**(打开的标签页)走 node 内置的 `fs.watch` 非递归监视。文件顶多
 *     二十来个,一个文件一个句柄很便宜;而且不能对它的父目录做递归监视 ——
 *     从大目录里打开一个文件,会把整个目录树拖进监视集合。
 *
 * 这是 VSCode 的 ParcelWatcher(递归)+ NodeJSWatcher(非递归)的同款切分:
 *   https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts
 *
 * 之前这里是 chokidar 一把梭。当初选它的理由写在
 * `docs/superpowers/specs/2026-05-08-file-explorer-and-attachment-viewer-design.md`:
 * 「VSCode 用 @parcel/watcher 是因为要监视上百万文件的工作区,我们只监视 ≤20 个
 * 打开的标签页」。**这个前提后来不成立了** —— FILES 面板改成对工作区根做递归监视
 * 之后,chokidar 要在 JS 里把整个媒体工作区走一遍、逐个目录注册监视,于是:
 *
 *   1. 打开大目录时卡顿,且监视集合越用越大;
 *   2. 更要命的是**丢事件**。chokidar 在 Windows 高负载 burst 下会撑爆
 *      ReadDirectoryChangesW 的内核缓冲区并静默丢弃事件 —— 这一点我们在
 *      `docs/hot-update.md` 里为附件面板选 parcel 时就已经写下来了。agent 批量
 *      移动文件正好就是一次 burst,于是「文件移进去了但树不更新」。
 *
 * parcel 的 C++ 层自带 debounce 且 `MAX_WAIT_TIME = 500ms` 封顶,burst 期间也
 * 保证按时吐事件,不会丢。
 */

/** 与 VSCode 的 `FILE_CHANGES_HANDLER_DELAY` 对齐。 */
const HANDLER_DELAY_MS = 75

/**
 * 永不监视的目录。
 *
 * VS Code 出厂就带这组默认值(`files.watcherExclude`),文档里明确写:不排除会在
 * 打开大目录时看到高 CPU —— 它们文件极多、变动极频繁,而且没有一个是用户想在文件
 * 树里看到的。
 */
const IGNORE_NAMES: readonly string[] = ['.git', 'node_modules']

/**
 * parcel 的 `ignore` 把绝对路径和 glob 当两回事(README:用 is-glob 区分):
 *
 *   - **绝对路径**:该目录及其子孙**根本不会被监视** —— 省的是内核句柄。
 *   - **glob**:只在事件出口处过滤,该监视的照样监视。
 *
 * 所以两种都要给:根下那两个目录用绝对路径拿到真正的免监视,嵌套在深处的
 * (`packages/*​/node_modules`)拿不到绝对路径,用 glob 兜住事件。
 *
 * 只用 glob 会踩 codex 那个坑 —— openai/codex#23574:大工作区下光 inotify
 * 句柄就分配了约一百万个。
 */
function ignoreFor(root: string): string[] {
  return [
    ...IGNORE_NAMES.map((name) => path.join(root, name)),
    ...IGNORE_NAMES.map((name) => `**/${name}/**`),
  ]
}

type Handle =
  | { kind: 'dir'; sub: parcelWatcher.AsyncSubscription | null; disposed: boolean }
  | { kind: 'file'; watcher: NodeFSWatcher }

const handles = new Map<string, Handle>()
const listeners = new Set<(e: WatchEvent) => void>()
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 同一个 (类型, 路径) 在一个窗口内只广播一次。
 *
 * 一次写入在 `fs.watch` 上可能触发两次回调(Windows 老问题),parcel 也可能把
 * create 和紧随其后的 update 分在两个批次里。渲染端每收到一条事件就重列目录并
 * 重渲染整棵树,所以这里必须收敛 —— 这正是 chokidar 的 `awaitWriteFinish` 之前
 * 承担的职责。
 */
function emit(e: WatchEvent): void {
  const key = `${e.type}:${e.path}`
  const prev = pending.get(key)
  if (prev) clearTimeout(prev)
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      listeners.forEach((fn) => fn(e))
    }, HANDLER_DELAY_MS),
  )
}

/** parcel 只区分增/改/删,不区分文件和目录;渲染端也不需要区分。 */
function mapParcelType(type: parcelWatcher.Event['type']): WatchEvent['type'] {
  if (type === 'create') return 'add'
  if (type === 'delete') return 'unlink'
  return 'change'
}

async function watchDir(dir: string): Promise<void> {
  const handle: Handle = { kind: 'dir', sub: null, disposed: false }
  handles.set(dir, handle)
  try {
    const sub = await parcelWatcher.subscribe(
      dir,
      (err, events) => {
        if (err) {
          // 后端错误(inotify 队列溢出、FSEvents 流中断)。绝不从原生回调里抛出。
          // 面板可见/窗口获焦时的重列会把树拉回真实状态。
          console.warn('[fsWatcher] parcel callback error:', err)
          return
        }
        for (const ev of events) {
          emit({ type: mapParcelType(ev.type), path: ev.path, mtime: Date.now() })
        }
      },
      { ignore: ignoreFor(dir) },
    )
    // dispose 可能在 subscribe 还在飞的时候就跑了。
    if (handle.disposed) {
      await sub.unsubscribe().catch(() => {})
      return
    }
    handle.sub = sub
  } catch (err) {
    // 沙箱、EACCES、macOS seatbelt、inotify ENOSPC 都会走到这里。监视降级,但
    // 面板不该因此瘫痪 —— 重列路径仍然可用。
    console.warn('[fsWatcher] failed to watch directory:', dir, err)
    handles.delete(dir)
  }
}

function watchFile(file: string): void {
  try {
    const watcher = nodeWatch(file, (eventType) => {
      if (eventType === 'change') {
        emit({ type: 'change', path: file, mtime: Date.now() })
        return
      }
      // 'rename' 既可能是被删,也可能是被原子替换(编辑器保存的常见写法)。
      void fsp
        .stat(file)
        .then(() => emit({ type: 'change', path: file, mtime: Date.now() }))
        .catch(() => emit({ type: 'unlink', path: file }))
    })
    watcher.on('error', () => {
      // 文件被删掉后句柄失效是正常现象,不要让它冒到主进程。
    })
    handles.set(file, { kind: 'file', watcher })
  } catch (err) {
    console.warn('[fsWatcher] failed to watch file:', file, err)
  }
}

export async function startWatching(p: string, listener: (e: WatchEvent) => void): Promise<void> {
  listeners.add(listener)
  if (handles.has(p)) return
  let isDir: boolean
  try {
    isDir = (await fsp.stat(p)).isDirectory()
  } catch {
    return
  }
  if (handles.has(p)) return // stat 期间可能已被别的调用抢先注册
  if (isDir) {
    await watchDir(p)
  } else {
    watchFile(p)
  }
}

export function stopWatching(p: string): void {
  const handle = handles.get(p)
  if (!handle) return
  handles.delete(p)
  if (handle.kind === 'file') {
    handle.watcher.close()
    return
  }
  handle.disposed = true
  void handle.sub?.unsubscribe().catch(() => {})
}

export function disposeAll(): void {
  for (const p of [...handles.keys()]) stopWatching(p)
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
  listeners.clear()
}

export function _resetForTests(): void {
  disposeAll()
}

/**
 * 广播必须是**模块级单例**,不能每次 watch-start 现建一个闭包。
 *
 * `listeners` 是个 Set,靠引用去重。现建的闭包每次都是新引用,于是每监视一个新路径
 * 就往 Set 里多塞一份;而 `stopWatching` 只清 `handles` 不清 `listeners`,只增不减。
 *
 * 而 `fs:watch-start` 是工作区打开时调一次、**之后每打开一个文本文件再调一次**。
 * 渲染端每收到一条事件就重列一次目录并整树重渲染 —— 打开 20 个文件后保存一次,
 * 就是 21 次 listDir + 21 次全树渲染,而且越用越慢。
 */
const broadcast = (event: WatchEvent): void => {
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('fs:watch-event', event))
}

export function registerFsWatcherIpc(): void {
  ipcMain.handle('fs:watch-start', async (_e, p: string) => {
    await startWatching(p, broadcast)
  })
  ipcMain.handle('fs:watch-stop', (_e, p: string) => {
    stopWatching(p)
  })
}

/** 供测试断言监视集合,不参与运行时逻辑。 */
export function _watchedPathsForTests(): string[] {
  return [...handles.keys()]
}