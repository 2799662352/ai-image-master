import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSubscriptionsForTesting,
  ensureWatchSubscription,
  useFileExplorerStore,
} from '../store'
import type { FileNode } from '../types'

/**
 * 文件树不能停在旧状态。
 *
 * 面板本来完全依赖 chokidar 推事件来刷新,而事件链路上任何一环出问题(事件没发、
 * 路径没被监视、目录还没展开过)都会让面板**静默地**显示过时内容 —— 用户看到的是
 * 「AI 把文件移进文件夹了,面板里什么都没变」,而且没有任何办法让它自己好。
 *
 * 这里不去赌是哪一环坏了(那需要能复现的样本),而是让过时状态**自愈**:窗口重新
 * 获得焦点时,把已经展开过的目录重列一遍。这也是 VS Code 的做法 —— 切回窗口时
 * 重新扫描,因为它同样不能假设外部改动都被监视到了。
 *
 * 只重列**已展开**的目录:没展开的看不见内容,重列它纯属浪费;而展开状态本身在
 * 重列时是靠 mergeListedChildren 保住的。
 */

const listDir = vi.fn()
let watchHandler: ((e: { type: string; path: string }) => void) | null = null

function dir(path: string, children?: FileNode[]): FileNode {
  return {
    path,
    name: path.split(/[\\/]/).pop()!,
    kind: 'dir',
    source: 'workspace',
    ...(children ? { childrenLoaded: true, children } : { childrenLoaded: false }),
  }
}
function file(path: string): FileNode {
  return { path, name: path.split(/[\\/]/).pop()!, kind: 'file', source: 'workspace' }
}

beforeEach(() => {
  listDir.mockReset()
  __resetSubscriptionsForTesting()
  Object.defineProperty(window, 'electronAPI', {
    value: {
      fs: {
        listDir,
        watchStart: vi.fn(),
        watchStop: vi.fn(),
        onWatchEvent: vi.fn((cb: (e: { type: string; path: string }) => void) => {
          watchHandler = cb
          return () => {
            watchHandler = null
          }
        }),
      },
      attachments: { listTree: vi.fn().mockResolvedValue([]), onChanged: vi.fn(() => () => undefined) },
    },
    configurable: true,
  })
})

/**
 * 嵌套目录里的变更也要刷新。
 *
 * 刷新走「找到最深的**已展开**祖先目录 → 只重列它」。两层以上嵌套时,这条链上有
 * 两处可能断:找祖先时的递归,和把结果写回树时的递归定位。
 */
describe('两层嵌套目录的变更', () => {
  it('文件被移进 /ws/a/b 时，该目录被重列', async () => {
    useFileExplorerStore.setState({
      workspaceTree: [dir('/ws', [dir('/ws/a', [dir('/ws/a/b', [file('/ws/a/b/old.png')])])])],
    })
    ensureWatchSubscription(() => useFileExplorerStore.getState())

    listDir.mockImplementation(async (p: string) =>
      p === '/ws/a/b' ? [file('/ws/a/b/old.png'), file('/ws/a/b/moved.docx')] : [],
    )

    watchHandler?.({ type: 'add', path: '/ws/a/b/moved.docx' })

    await vi.waitFor(() => {
      const b = useFileExplorerStore.getState().workspaceTree[0].children![0].children![0]
      expect(b.children?.map((c) => c.name)).toContain('moved.docx')
    })
    // 必须只重列最深的那一层，重列 /ws 会把 a、b 的展开内容抹掉。
    expect(listDir).toHaveBeenCalledWith('/ws/a/b')
  })
})

describe('窗口重获焦点时刷新已展开的目录', () => {
  it('外部新增的文件在切回窗口后出现', async () => {
    useFileExplorerStore.setState({
      workspaceTree: [dir('/ws', [dir('/ws/scene', [file('/ws/scene/a.png')])])],
    })
    ensureWatchSubscription(() => useFileExplorerStore.getState())

    // 面板不知情的情况下，磁盘上多了一个文件。
    listDir.mockImplementation(async (p: string) => {
      if (p === '/ws') return [dir('/ws/scene')]
      if (p === '/ws/scene') return [file('/ws/scene/a.png'), file('/ws/scene/moved.docx')]
      return []
    })

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => {
      const scene = useFileExplorerStore.getState().workspaceTree[0].children![0]
      expect(scene.children?.map((c) => c.name)).toContain('moved.docx')
    })
  })

  it('展开状态不会因为刷新而丢失', async () => {
    useFileExplorerStore.setState({
      workspaceTree: [dir('/ws', [dir('/ws/scene', [file('/ws/scene/a.png')])])],
    })
    ensureWatchSubscription(() => useFileExplorerStore.getState())
    listDir.mockImplementation(async (p: string) => {
      if (p === '/ws') return [dir('/ws/scene')]
      if (p === '/ws/scene') return [file('/ws/scene/a.png')]
      return []
    })

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws/scene'))

    const scene = useFileExplorerStore.getState().workspaceTree[0].children![0]
    expect(scene.childrenLoaded, '重列后仍应是展开态').toBe(true)
  })

  // 没展开的目录看不见内容，重列它纯属浪费 —— 一棵几百个文件夹的树会打出几百次 IPC。
  it('不去重列没展开过的目录', async () => {
    useFileExplorerStore.setState({
      workspaceTree: [dir('/ws', [dir('/ws/collapsed'), dir('/ws/open', [file('/ws/open/x.png')])])],
    })
    ensureWatchSubscription(() => useFileExplorerStore.getState())
    listDir.mockResolvedValue([])

    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(listDir).toHaveBeenCalledWith('/ws/open'))

    expect(listDir.mock.calls.map(([p]) => p)).not.toContain('/ws/collapsed')
  })
})
