import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'
import type { FileNode } from '../types'

// Regression: before the fix the file tree had no drag/drop drop-target. The
// user could pick up a file (only files were `draggable={true}`, dirs were
// blocked) but dropping it elsewhere in the tree did nothing because nothing
// in the tree implemented `onDrop`. The store now exposes a `moveByDnd` action
// that the tree's drop handler invokes after `parseFileDrop`:
//
//   - delegates to `fs.move` (which already exists in main and handles
//     EXDEV cross-drive, same-dir no-op, and dir-into-self protection)
//   - refreshes the destination dir on success
//   - refuses to move a directory into itself or one of its descendants
//     BEFORE round-tripping to main (cheap UI guard; main also enforces)

type ListedNode = Omit<FileNode, 'children' | 'childrenLoaded'> & { childrenLoaded?: false }

const electronAPI = {
  agent: { setAllowedRoots: vi.fn() },
  fs: {
    readText: vi.fn(),
    writeText: vi.fn(),
    listDir: vi.fn(),
    stat: vi.fn(),
    pickFolder: vi.fn(),
    watchStart: vi.fn(),
    watchStop: vi.fn(),
    onWatchEvent: vi.fn(() => () => undefined),
    move: vi.fn(),
    copy: vi.fn(),
  },
  attachments: {
    listTree: vi.fn().mockResolvedValue([]),
    onChanged: vi.fn(() => () => undefined),
  },
}

function tree(): FileNode[] {
  return [
    {
      path: 'D:/proj',
      name: 'proj',
      kind: 'dir',
      source: 'workspace',
      childrenLoaded: true,
      children: [
        {
          path: 'D:/proj/src',
          name: 'src',
          kind: 'dir',
          source: 'workspace',
          childrenLoaded: true,
          children: [
            { path: 'D:/proj/src/a.ts', name: 'a.ts', kind: 'file', source: 'workspace' },
          ],
        },
        {
          path: 'D:/proj/docs',
          name: 'docs',
          kind: 'dir',
          source: 'workspace',
          childrenLoaded: true,
          children: [],
        },
      ],
    },
  ]
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: electronAPI, configurable: true })
  Object.values(electronAPI.fs).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset()
  })
  electronAPI.fs.onWatchEvent.mockImplementation(() => () => undefined)
  electronAPI.agent.setAllowedRoots.mockReset()
  electronAPI.attachments.listTree.mockReset().mockResolvedValue([])
  electronAPI.attachments.onChanged.mockClear()
  __resetSubscriptionsForTesting()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
  useFileExplorerStore.setState({ workspaceRoot: 'D:/proj', workspaceTree: tree() })
})

describe('moveByDnd', () => {
  it('rejects moving a directory into itself', async () => {
    const res = await useFileExplorerStore.getState().moveByDnd(['D:/proj/src'], 'D:/proj/src')
    expect(res.ok).toBe(false)
    expect(electronAPI.fs.move).not.toHaveBeenCalled()
  })

  it('rejects moving a directory into one of its own descendants', async () => {
    const res = await useFileExplorerStore.getState().moveByDnd(['D:/proj/src'], 'D:/proj/src/nested')
    expect(res.ok).toBe(false)
    expect(electronAPI.fs.move).not.toHaveBeenCalled()
  })

  it('is a no-op when sources are already in the destination', async () => {
    // VSCode silently no-ops same-dir drops to avoid spurious "copy 2" suffixes;
    // we match that by short-circuiting in the store before calling main.
    const res = await useFileExplorerStore
      .getState()
      .moveByDnd(['D:/proj/src/a.ts'], 'D:/proj/src')
    expect(res.ok).toBe(true)
    expect(electronAPI.fs.move).not.toHaveBeenCalled()
  })

  it('calls fs.move and refreshes the destination on success', async () => {
    electronAPI.fs.move.mockResolvedValue({ ok: true, written: ['D:/proj/docs/a.ts'] })
    const refreshed: ListedNode[] = [
      { path: 'D:/proj/docs/a.ts', name: 'a.ts', kind: 'file', source: 'workspace', childrenLoaded: false },
    ]
    electronAPI.fs.listDir.mockResolvedValue(refreshed)

    const res = await useFileExplorerStore.getState().moveByDnd(['D:/proj/src/a.ts'], 'D:/proj/docs')
    expect(res.ok).toBe(true)
    expect(electronAPI.fs.move).toHaveBeenCalledWith(['D:/proj/src/a.ts'], 'D:/proj/docs')
    expect(electronAPI.fs.listDir).toHaveBeenCalledWith('D:/proj/docs')
    const docs = useFileExplorerStore
      .getState()
      .workspaceTree[0]!.children!.find((n) => n.name === 'docs')!
    expect(docs.children?.map((n) => n.name)).toEqual(['a.ts'])
  })

  it('surfaces failures from fs.move without mutating the tree', async () => {
    electronAPI.fs.move.mockResolvedValue({ ok: false, reason: 'EACCES' })

    const before = useFileExplorerStore.getState().workspaceTree
    const res = await useFileExplorerStore.getState().moveByDnd(['D:/proj/src/a.ts'], 'D:/proj/docs')

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('EACCES')
    expect(useFileExplorerStore.getState().workspaceTree).toBe(before)
  })
})
