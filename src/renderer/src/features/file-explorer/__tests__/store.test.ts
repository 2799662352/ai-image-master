import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFileExplorerStore } from '../store'

const electronAPI = {
  agent: {
    setAllowedRoots: vi.fn(),
  },
  fs: {
    readText: vi.fn(),
    writeText: vi.fn(),
    listDir: vi.fn(),
    stat: vi.fn(),
    pickFolder: vi.fn(),
    watchStart: vi.fn(),
    watchStop: vi.fn(),
    onWatchEvent: vi.fn(() => () => undefined),
  },
  attachments: { listTree: vi.fn() },
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: electronAPI,
    configurable: true,
  })
  Object.values(electronAPI.fs).forEach((m) => {
    if ('mockReset' in m) m.mockReset()
  })
  electronAPI.agent.setAllowedRoots.mockReset()
  electronAPI.attachments.listTree.mockReset()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

describe('useFileExplorerStore', () => {
  it('toggleFx flips fxOpen', () => {
    expect(useFileExplorerStore.getState().fxOpen).toBe(false)
    useFileExplorerStore.getState().toggleFx()
    expect(useFileExplorerStore.getState().fxOpen).toBe(true)
  })

  it('setFxTreeWidth clamps to [200, 360]', () => {
    useFileExplorerStore.getState().setFxTreeWidth(50)
    expect(useFileExplorerStore.getState().fxTreeWidth).toBe(200)
    useFileExplorerStore.getState().setFxTreeWidth(500)
    expect(useFileExplorerStore.getState().fxTreeWidth).toBe(360)
    useFileExplorerStore.getState().setFxTreeWidth(280)
    expect(useFileExplorerStore.getState().fxTreeWidth).toBe(280)
  })

  it('openTab reads file and adds tab; activates it', async () => {
    electronAPI.fs.readText.mockResolvedValue({ content: 'hello', mtime: 1234 })
    electronAPI.fs.stat.mockResolvedValue({ ok: true, size: 5, mime: 'text/plain', mtime: 1234 })
    electronAPI.fs.watchStart.mockResolvedValue(undefined)
    await useFileExplorerStore.getState().openTab('D:/a.txt', 'workspace')
    const s = useFileExplorerStore.getState()
    expect(s.tabs.length).toBe(1)
    expect(s.tabs[0].path).toBe('D:/a.txt')
    expect(s.tabs[0].kind).toBe('text')
    expect(s.activeTabId).toBe(s.tabs[0].id)
  })

  it('pickWorkspaceFolder appends multiple workspace roots and removeWorkspaceFolder removes one', async () => {
    electronAPI.fs.pickFolder.mockResolvedValueOnce('D:/one').mockResolvedValueOnce('D:/two')
    electronAPI.fs.listDir.mockResolvedValue([])
    electronAPI.agent.setAllowedRoots.mockResolvedValue([])

    await useFileExplorerStore.getState().pickWorkspaceFolder()
    await useFileExplorerStore.getState().pickWorkspaceFolder()

    expect(useFileExplorerStore.getState().workspaceTree.map((n) => n.path)).toEqual(['D:/one', 'D:/two'])
    useFileExplorerStore.getState().removeWorkspaceFolder('D:/one')
    expect(useFileExplorerStore.getState().workspaceTree.map((n) => n.path)).toEqual(['D:/two'])
  })

  it('syncs picked workspace roots before listing the new folder', async () => {
    const calls: string[] = []
    electronAPI.fs.pickFolder.mockResolvedValueOnce('D:/picked')
    electronAPI.agent.setAllowedRoots.mockImplementation(async () => {
      calls.push('setAllowedRoots')
      return ['D:/picked']
    })
    electronAPI.fs.listDir.mockImplementation(async () => {
      calls.push('listDir')
      return []
    })

    await useFileExplorerStore.getState().pickWorkspaceFolder()

    expect(calls.slice(0, 2)).toEqual(['setAllowedRoots', 'listDir'])
    expect(electronAPI.agent.setAllowedRoots).toHaveBeenCalledWith(['D:/picked'])
  })

  it('openTab on already-open path activates existing tab without re-reading', async () => {
    electronAPI.fs.readText.mockResolvedValue({ content: 'one', mtime: 1 })
    electronAPI.fs.stat.mockResolvedValue({ ok: true, size: 3, mime: 'text/plain', mtime: 1 })
    electronAPI.fs.watchStart.mockResolvedValue(undefined)
    await useFileExplorerStore.getState().openTab('D:/x.ts', 'workspace')
    await useFileExplorerStore.getState().openTab('D:/x.ts', 'workspace')
    expect(useFileExplorerStore.getState().tabs.length).toBe(1)
    expect(electronAPI.fs.readText).toHaveBeenCalledTimes(1)
  })

  it('closeTab removes from tabs and stops watching', async () => {
    electronAPI.fs.readText.mockResolvedValue({ content: 'x', mtime: 1 })
    electronAPI.fs.stat.mockResolvedValue({ ok: true, size: 1, mime: 'text/plain', mtime: 1 })
    electronAPI.fs.watchStart.mockResolvedValue(undefined)
    electronAPI.fs.watchStop.mockResolvedValue(undefined)
    await useFileExplorerStore.getState().openTab('D:/y.ts', 'workspace')
    const tabId = useFileExplorerStore.getState().tabs[0].id
    await useFileExplorerStore.getState().closeTab(tabId)
    expect(useFileExplorerStore.getState().tabs.length).toBe(0)
    expect(electronAPI.fs.watchStop).toHaveBeenCalledWith('D:/y.ts')
  })

  it('closeTab blocks dirty text tabs until caller chooses save or discard', async () => {
    electronAPI.fs.readText.mockResolvedValue({ content: 'before', mtime: 1 })
    electronAPI.fs.stat.mockResolvedValue({ ok: true, size: 6, mime: 'text/plain', mtime: 1 })
    electronAPI.fs.watchStart.mockResolvedValue(undefined)
    electronAPI.fs.watchStop.mockResolvedValue(undefined)
    electronAPI.fs.writeText.mockResolvedValue({ mtime: 2 })
    await useFileExplorerStore.getState().openTab('D:/dirty.ts', 'workspace')
    const tab = useFileExplorerStore.getState().tabs[0]
    useFileExplorerStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, dirty: true, state: null })),
    }))
    useFileExplorerStore.getState().setActiveDoc('after')

    const blocked = await useFileExplorerStore.getState().closeTab(tab.id)

    expect(blocked).toBe(false)
    expect(electronAPI.fs.writeText).not.toHaveBeenCalled()
    expect(useFileExplorerStore.getState().tabs).toHaveLength(1)

    const closed = await useFileExplorerStore.getState().closeTab(tab.id, { saveDirty: true })
    expect(closed).toBe(true)
    expect(electronAPI.fs.writeText).toHaveBeenCalledWith('D:/dirty.ts', 'after')
    expect(useFileExplorerStore.getState().tabs).toHaveLength(0)
  })

  it('saveActiveTab writes content and clears dirty', async () => {
    electronAPI.fs.readText.mockResolvedValue({ content: 'before', mtime: 1 })
    electronAPI.fs.stat.mockResolvedValue({ ok: true, size: 6, mime: 'text/plain', mtime: 1 })
    electronAPI.fs.watchStart.mockResolvedValue(undefined)
    electronAPI.fs.writeText.mockResolvedValue({ mtime: 2 })
    await useFileExplorerStore.getState().openTab('D:/z.ts', 'workspace')
    useFileExplorerStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({ ...t, dirty: true, diskContent: 'before' })),
    }))
    useFileExplorerStore.getState().setActiveDoc('after')
    await useFileExplorerStore.getState().saveActiveTab()
    expect(electronAPI.fs.writeText).toHaveBeenCalledWith('D:/z.ts', 'after')
    expect(useFileExplorerStore.getState().tabs[0].dirty).toBe(false)
  })

  it('appendToChatInput stores pending text for chat consumer', () => {
    useFileExplorerStore.getState().appendToChatInput('\n[file:foo.ts]')
    expect(useFileExplorerStore.getState().pendingChatInsert).toBe('\n[file:foo.ts]')
  })
})
