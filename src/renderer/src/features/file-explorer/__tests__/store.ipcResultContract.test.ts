// 回归:`fs.readText` / `fs.writeText` 的结果契约被误读成判别联合。
//
// 运行时真相(fsIpc.handleReadText / handleWriteText + preload 的 safeInvoke —— 后者
// 只是 ipcRenderer.invoke,不把异常包成结果对象):
//   readText  成功 → { content, mtime }   失败 → **reject**
//   writeText 成功 → { mtime }            失败 → **reject**
//
// 两处消费代码却按 `{ ok, text, reason }` 来读。`.ok` 恒为 undefined,`!undefined`
// 恒为 true,于是**成功被当成失败**:
//   - compareSelection 每次都返回「读取左侧失败: undefined」,对比标签页从未打开过
//   - 冲突「用磁盘版本」(source:'apply')每次都提前 return,盘写成功了但横幅不消失
//
// 这两处此前零测试覆盖,所以 bug 只以 typecheck 报错的形式存在于 baseline 里。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'

const readText = vi.fn()
const writeText = vi.fn()

const electronAPI = {
  agent: { setAllowedRoots: vi.fn() },
  fs: {
    readText,
    writeText,
    listDir: vi.fn(),
    stat: vi.fn(),
    pickFolder: vi.fn(),
    watchStart: vi.fn(),
    watchStop: vi.fn(),
    onWatchEvent: vi.fn(() => () => undefined),
  },
  attachments: {
    listTree: vi.fn().mockResolvedValue([]),
    onChanged: vi.fn(() => () => undefined),
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetSubscriptionsForTesting()
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = electronAPI
  // readText 的真实成功形状 —— 注意没有 ok / text
  readText.mockImplementation(async (p: string) => ({ content: `内容 ${p}`, mtime: 1 }))
  writeText.mockResolvedValue({ mtime: 2 })
})

describe('compareSelection 消费 readText 的真实形状', () => {
  it('两个文件都读成功 → 建出对比标签页,内容取自 .content', async () => {
    useFileExplorerStore.setState({ selectedPaths: ['D:/a.txt', 'D:/b.txt'], tabs: [] })

    const res = await useFileExplorerStore.getState().compareSelection()

    expect(res.ok).toBe(true)
    const tab = useFileExplorerStore.getState().tabs.find((t) => t.kind === 'compare')
    expect(tab).toBeTruthy()
    expect(tab!.compare).toMatchObject({
      left: 'D:/a.txt',
      right: 'D:/b.txt',
      leftContent: '内容 D:/a.txt',
      rightContent: '内容 D:/b.txt',
    })
  })

  it('读取 reject 才算失败,且报出是哪一侧', async () => {
    readText.mockImplementation(async (p: string) => {
      if (p === 'D:/b.txt') throw new Error('File too large for inline edit')
      return { content: 'ok', mtime: 1 }
    })
    useFileExplorerStore.setState({ selectedPaths: ['D:/a.txt', 'D:/b.txt'], tabs: [] })

    const res = await useFileExplorerStore.getState().compareSelection()

    expect(res.ok).toBe(false)
    expect(res.reason).toContain('右侧')
    expect(res.reason).toContain('File too large')
    expect(useFileExplorerStore.getState().tabs).toHaveLength(0)
  })

  it('选中数不是 2 时不读盘', async () => {
    useFileExplorerStore.setState({ selectedPaths: ['D:/a.txt'], tabs: [] })
    const res = await useFileExplorerStore.getState().compareSelection()
    expect(res.ok).toBe(false)
    expect(readText).not.toHaveBeenCalled()
  })
})

describe('冲突解决(source: apply)消费 writeText 的真实形状', () => {
  const tabId = 'tab-1'

  function armConflict(): void {
    useFileExplorerStore.setState({
      tabs: [{
        id: tabId,
        path: 'D:/x.md',
        name: 'x.md',
        source: 'workspace',
        kind: 'text',
        state: null,
        diskContent: '盘上旧内容',
        diskMtime: 1,
        dirty: true,
      } as never],
      conflict: {
        tabId,
        source: 'apply',
        diskContent: 'AI 写的新内容',
      } as never,
    })
  }

  it('写盘成功 → 清掉冲突态并把内容落到标签页', async () => {
    armConflict()

    await useFileExplorerStore.getState().applyExternalChange(tabId, 'disk')

    expect(writeText).toHaveBeenCalledWith('D:/x.md', 'AI 写的新内容')
    const s = useFileExplorerStore.getState()
    expect(s.conflict).toBeNull()
    const tab = s.tabs.find((t) => t.id === tabId)!
    expect(tab.diskContent).toBe('AI 写的新内容')
    expect(tab.dirty).toBe(false)
  })

  it('写盘 reject 才保留冲突态供重试', async () => {
    writeText.mockRejectedValue(new Error('EACCES'))
    armConflict()

    await useFileExplorerStore.getState().applyExternalChange(tabId, 'disk')

    expect(useFileExplorerStore.getState().conflict).not.toBeNull()
  })
})
