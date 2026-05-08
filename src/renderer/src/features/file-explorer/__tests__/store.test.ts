import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFileExplorerStore } from '../store'

const electronAPI = {
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
    useFileExplorerStore.getState().closeTab(tabId)
    expect(useFileExplorerStore.getState().tabs.length).toBe(0)
    expect(electronAPI.fs.watchStop).toHaveBeenCalledWith('D:/y.ts')
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
