import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'

let attachmentsChangedHandlers: Array<() => void> = []

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
  attachments: {
    listTree: vi.fn(),
    onChanged: vi.fn((cb: () => void) => {
      attachmentsChangedHandlers.push(cb)
      return () => {
        attachmentsChangedHandlers = attachmentsChangedHandlers.filter((h) => h !== cb)
      }
    }),
  },
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
  electronAPI.attachments.onChanged.mockClear()
  attachmentsChangedHandlers = []
  __resetSubscriptionsForTesting()
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

  it('ensureSubscriptions wires attachments.onChanged and re-fetches the tree on push events', async () => {
    // Regression: ATTACHMENTS panel stayed stale after AttachmentService
    // ingested a new chat upload because nothing pushed an invalidation to
    // the renderer. ensureSubscriptions must subscribe to the IPC channel
    // and refresh the tree via the existing listTree pull when a change
    // event fires. We use a 200ms trailing-edge debounce; the test waits
    // through that gate before asserting the second fetch.
    electronAPI.attachments.listTree
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { path: '/uploads/new.md', name: 'new.md', kind: 'file', source: 'attachments', childrenLoaded: false },
      ])

    useFileExplorerStore.getState().ensureSubscriptions()
    await useFileExplorerStore.getState().refreshAttachmentsTree()
    expect(electronAPI.attachments.listTree).toHaveBeenCalledTimes(1)

    // Simulate main → renderer push (AttachmentService.emit('attachment-added')
    // → webContents.send('attachments:changed'))
    expect(attachmentsChangedHandlers).toHaveLength(1)
    attachmentsChangedHandlers[0]?.()

    // Debounce window: wait it out + a small grace tick.
    await new Promise((resolve) => setTimeout(resolve, 250))

    expect(electronAPI.attachments.listTree).toHaveBeenCalledTimes(2)
    const tree = useFileExplorerStore.getState().attachmentsTree
    expect(tree[0]?.children?.[0]?.name).toBe('new.md')
  })

  it('ensureSubscriptions collapses bursts of attachments:changed into a single refetch', async () => {
    // Sequential ingest of N files fires N IPC events. Without debounce the
    // panel would re-query Prisma + readdir N times in a row; with debounce
    // we coalesce into one final refresh.
    electronAPI.attachments.listTree.mockResolvedValue([])

    useFileExplorerStore.getState().ensureSubscriptions()
    expect(attachmentsChangedHandlers).toHaveLength(1)

    const fire = attachmentsChangedHandlers[0]!
    fire()
    fire()
    fire()
    fire()
    fire()

    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(electronAPI.attachments.listTree).toHaveBeenCalledTimes(1)
  })

  it('ensureSubscriptions is idempotent — calling twice does not double-subscribe', () => {
    useFileExplorerStore.getState().ensureSubscriptions()
    useFileExplorerStore.getState().ensureSubscriptions()
    useFileExplorerStore.getState().ensureSubscriptions()
    expect(electronAPI.attachments.onChanged).toHaveBeenCalledTimes(1)
  })
})
