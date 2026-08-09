import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const send = vi.fn()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    },
  },
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send } }],
  },
}))

const { registerFsWatcherIpc, disposeAll, _resetForTests } = await import('../fsWatcher')

let dir: string
beforeEach(async () => {
  _resetForTests()
  handlers.clear()
  send.mockClear()
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fswatch-ipc-'))
})
afterEach(async () => {
  disposeAll()
  await fs.rm(dir, { recursive: true, force: true })
})

/**
 * 一次文件改动只能广播一次。
 *
 * `fs:watch-start` 在工作区打开时调一次,**之后每打开一个文本文件再调一次**。
 * 监听器存在一个 Set 里,所以只要 IPC 处理器每次都现建一个闭包,Set 就永远去不了
 * 重;而 `stopWatching` 只清 `watched` 不清 `listeners`,于是只增不减。
 *
 * 渲染端收到每条事件都会重列一次目录并整树重渲染。打开 20 个文件之后,保存一次
 * 就是 21 次 listDir + 21 次全树渲染 —— 而且越用越慢,正好对上用户说的
 * 「有时候直接卡死」。
 */
describe('fs:watch-start 广播', () => {
  it('监视多个路径后，一次改动只发一条事件', async () => {
    registerFsWatcherIpc()
    const start = handlers.get('fs:watch-start')!
    expect(start).toBeTypeOf('function')

    const a = path.join(dir, 'a.txt')
    const b = path.join(dir, 'b.txt')
    const c = path.join(dir, 'c.txt')
    await fs.writeFile(a, 'one')
    await fs.writeFile(b, 'one')
    await fs.writeFile(c, 'one')

    // 工作区根 + 两个打开的文件 = 三次 watch-start,和真实用法一致。
    start({}, a)
    start({}, b)
    start({}, c)
    await new Promise((r) => setTimeout(r, 400))

    await fs.writeFile(a, 'two')
    await vi.waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 50,
    })
    // 给重复广播留出到达的时间，否则「只发一条」可能只是还没到。
    await new Promise((r) => setTimeout(r, 400))

    const changes = send.mock.calls.filter(
      ([channel, event]) =>
        channel === 'fs:watch-event' &&
        (event as { type: string; path: string }).type === 'change' &&
        (event as { type: string; path: string }).path === a,
    )
    expect(changes.length, `一次改动被广播了 ${changes.length} 次`).toBe(1)
  }, 12000)
})
