import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
}))

const { startWatching, disposeAll, _resetForTests, _watchedPathsForTests } = await import('../fsWatcher')

let root: string
beforeEach(async () => {
  _resetForTests()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'fswatch-rec-'))
})
afterEach(async () => {
  disposeAll()
  await fs.rm(root, { recursive: true, force: true })
})

/**
 * agent 把文件移进一个嵌套子目录后,文件树没更新。
 *
 * 监视一个目录必须是**递归**的:事件要覆盖整棵子树,而不只是根这一层。之前用
 * chokidar 时这一点靠它在 JS 里遍历目录树逐个注册来实现 —— 目录一大就慢,而且在
 * Windows 高负载 burst 下会撑爆 ReadDirectoryChangesW 的内核缓冲区静默丢事件。
 * agent 批量移动文件正好就是一次 burst。
 */
describe('工作区根的递归监视', () => {
  it('嵌套子目录里新增文件也会上报', async () => {
    const nested = path.join(root, 'a', 'b')
    await fs.mkdir(nested, { recursive: true })

    const events: { type: string; path: string }[] = []
    await startWatching(root, (e) => events.push(e))

    const moved = path.join(nested, 'clip.mp4')
    await fs.writeFile(moved, 'data')

    await vi.waitFor(
      () => expect(events.some((e) => e.path === moved && e.type === 'add')).toBe(true),
      { timeout: 8000, interval: 100 },
    )
  }, 20000)

  /**
   * `.git` / `node_modules` 必须真的被排除掉。
   *
   * parcel 的 ignore 把绝对路径和 glob 当两回事,而 glob 是按**相对于被监视根**的
   * 路径匹配的(README)。写错一个模式不会报错,只会**静默失效** —— 于是我们以为
   * 排除了,实际上还在监视,再回到高 CPU。所以这里不推理,直接拿真实监视器验。
   */
  it('.git 和 node_modules 里的改动不上报，同级的正常文件照常上报', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })

    const events: { type: string; path: string }[] = []
    await startWatching(root, (e) => events.push(e))

    await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref')
    await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x')
    const sentinel = path.join(root, 'visible.txt')
    await fs.writeFile(sentinel, 'x')

    // 等到哨兵文件到达,说明这一轮事件都已经吐完了,再断言被忽略的没混进来。
    await vi.waitFor(() => expect(events.some((e) => e.path === sentinel)).toBe(true), {
      timeout: 8000,
      interval: 100,
    })

    const leaked = events.filter((e) => /[\\/](\.git|node_modules)[\\/]/.test(e.path))
    expect(leaked.map((e) => e.path)).toEqual([])
  }, 20000)

  /**
   * 从一个大目录里打开单个文件,不能顺手把它的父目录整棵树拖进监视集合 ——
   * 那正是 VSCode 把非递归监视(fs.watch)和递归监视(parcel)分开的原因。
   */
  it('监视单个文件时只登记该文件本身，不登记它的父目录', async () => {
    const file = path.join(root, 'note.txt')
    await fs.writeFile(file, 'one')

    await startWatching(file, () => undefined)

    expect(_watchedPathsForTests()).toEqual([file])
  }, 20000)
})
