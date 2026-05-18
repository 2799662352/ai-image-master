import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'
import type { FileNode } from '../types'

// Regression: chokidar fires watch events for any descendant under a workspace
// root (including deeply-nested files like `D:/proj/角色/动作/foo.png`).
// Before the fix, the renderer reacted by calling `fs.listDir(root)` and
// REPLACING the whole `workspaceTree` root with its level-1 children. That
// silently discarded the children of every already-expanded subdirectory:
//
//   - "动作" had `childrenLoaded: true, children: [...]`
//     → after refresh: `childrenLoaded: false, children: undefined`
//   - User saw the subfolder visually collapse, and newly-created files
//     appeared to vanish (the create succeeded, watcher refresh wiped it).
//
// The fix is a merge-style refresh: when the watcher pushes an event we only
// re-list the directory that actually changed, and we preserve any existing
// `childrenLoaded` + `children` for subdirectories that are unrelated to the
// event path.

type WatchEvent = { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string; mtime?: number }

let watchHandler: ((e: WatchEvent) => void) | null = null

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
    onWatchEvent: vi.fn((cb: (e: WatchEvent) => void) => {
      watchHandler = cb
      return () => {
        watchHandler = null
      }
    }),
  },
  attachments: {
    listTree: vi.fn().mockResolvedValue([]),
    onChanged: vi.fn(() => () => undefined),
  },
}

function makeRoot(): FileNode {
  // D:/proj
  // ├── 角色/                       (expanded)
  // │   ├── 动作/                   (expanded — this is what we must NOT lose)
  // │   │   ├── walk.png
  // │   │   └── run.png
  // │   └── 头像/                   (NOT expanded)
  // └── README.md
  const dongzuo: FileNode = {
    path: 'D:/proj/角色/动作',
    name: '动作',
    kind: 'dir',
    source: 'workspace',
    childrenLoaded: true,
    children: [
      { path: 'D:/proj/角色/动作/walk.png', name: 'walk.png', kind: 'file', source: 'workspace' },
      { path: 'D:/proj/角色/动作/run.png', name: 'run.png', kind: 'file', source: 'workspace' },
    ],
  }
  const touxiang: FileNode = {
    path: 'D:/proj/角色/头像',
    name: '头像',
    kind: 'dir',
    source: 'workspace',
    childrenLoaded: false,
  }
  const juese: FileNode = {
    path: 'D:/proj/角色',
    name: '角色',
    kind: 'dir',
    source: 'workspace',
    childrenLoaded: true,
    children: [dongzuo, touxiang],
  }
  const readme: FileNode = {
    path: 'D:/proj/README.md',
    name: 'README.md',
    kind: 'file',
    source: 'workspace',
  }
  return {
    path: 'D:/proj',
    name: 'proj',
    kind: 'dir',
    source: 'workspace',
    childrenLoaded: true,
    children: [juese, readme],
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', { value: electronAPI, configurable: true })
  Object.values(electronAPI.fs).forEach((m) => {
    if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset()
  })
  // Re-install onWatchEvent so it captures the new handler reference set
  // during ensureSubscriptions() in this test (mockReset above clears the impl).
  electronAPI.fs.onWatchEvent.mockImplementation((cb: (e: WatchEvent) => void) => {
    watchHandler = cb
    return () => {
      watchHandler = null
    }
  })
  electronAPI.agent.setAllowedRoots.mockReset()
  electronAPI.attachments.listTree.mockReset().mockResolvedValue([])
  electronAPI.attachments.onChanged.mockClear()
  watchHandler = null
  __resetSubscriptionsForTesting()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
  useFileExplorerStore.setState({ workspaceRoot: 'D:/proj', workspaceTree: [makeRoot()] })
})

describe('watch refresh — merge existing expanded subdirs', () => {
  it('preserves expanded subdirectory children when a deep file changes', async () => {
    useFileExplorerStore.getState().ensureSubscriptions()
    expect(watchHandler).toBeTruthy()

    // The watcher event names a deep path (e.g. user just edited walk.png).
    // The renderer should re-list ONLY the directory containing the event
    // (D:/proj/角色/动作) — and on its way back up should keep every other
    // subdirectory's `childrenLoaded` + `children` untouched.
    electronAPI.fs.listDir.mockImplementation(async (p: string) => {
      if (p === 'D:/proj/角色/动作') {
        return [
          { path: 'D:/proj/角色/动作/walk.png', name: 'walk.png', kind: 'dir' === 'dir' ? 'file' : 'file', source: 'workspace', childrenLoaded: false },
          { path: 'D:/proj/角色/动作/run.png', name: 'run.png', kind: 'file', source: 'workspace', childrenLoaded: false },
          { path: 'D:/proj/角色/动作/jump.png', name: 'jump.png', kind: 'file', source: 'workspace', childrenLoaded: false },
        ]
      }
      throw new Error(`unexpected listDir call: ${p}`)
    })

    watchHandler!({ type: 'change', path: 'D:/proj/角色/动作/walk.png', mtime: Date.now() })

    // Flush the async refresh
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const tree = useFileExplorerStore.getState().workspaceTree
    const root = tree[0]!
    const juese = root.children!.find((n) => n.name === '角色')!
    expect(juese.childrenLoaded).toBe(true)
    expect(juese.children).toBeDefined()

    const dongzuo = juese.children!.find((n) => n.name === '动作')!
    expect(dongzuo.childrenLoaded).toBe(true)
    expect(dongzuo.children?.map((n) => n.name).sort()).toEqual(['jump.png', 'run.png', 'walk.png'])

    // 头像 was an unexpanded sibling — its lazy state must survive.
    const touxiang = juese.children!.find((n) => n.name === '头像')!
    expect(touxiang.childrenLoaded).toBe(false)
  })

  it('preserves an unrelated already-expanded subdir when a different sibling changes', async () => {
    useFileExplorerStore.getState().ensureSubscriptions()

    electronAPI.fs.listDir.mockImplementation(async (p: string) => {
      if (p === 'D:/proj') {
        // Root changed → return same level-1 children, but the merge step
        // must keep deep subtrees intact (动作 still expanded with 2 files).
        return [
          {
            path: 'D:/proj/角色',
            name: '角色',
            kind: 'dir',
            source: 'workspace',
            childrenLoaded: false,
          },
          {
            path: 'D:/proj/NEW.md',
            name: 'NEW.md',
            kind: 'file',
            source: 'workspace',
            childrenLoaded: false,
          },
        ]
      }
      throw new Error(`unexpected listDir call: ${p}`)
    })

    // A file added directly under the workspace root.
    watchHandler!({ type: 'add', path: 'D:/proj/NEW.md', mtime: Date.now() })

    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const tree = useFileExplorerStore.getState().workspaceTree
    const root = tree[0]!
    expect(root.children?.map((n) => n.name).sort()).toEqual(['NEW.md', '角色'])

    // 角色's already-loaded children must NOT be discarded.
    const juese = root.children!.find((n) => n.name === '角色')!
    expect(juese.childrenLoaded).toBe(true)
    const dongzuo = juese.children!.find((n) => n.name === '动作')!
    expect(dongzuo.childrenLoaded).toBe(true)
    expect(dongzuo.children?.map((n) => n.name).sort()).toEqual(['run.png', 'walk.png'])
  })

  it('handles a fresh add inside an already-expanded subdir without collapsing siblings', async () => {
    useFileExplorerStore.getState().ensureSubscriptions()

    electronAPI.fs.listDir.mockImplementation(async (p: string) => {
      if (p === 'D:/proj/角色/动作') {
        return [
          { path: 'D:/proj/角色/动作/walk.png', name: 'walk.png', kind: 'file', source: 'workspace', childrenLoaded: false },
          { path: 'D:/proj/角色/动作/run.png', name: 'run.png', kind: 'file', source: 'workspace', childrenLoaded: false },
          { path: 'D:/proj/角色/动作/idle.png', name: 'idle.png', kind: 'file', source: 'workspace', childrenLoaded: false },
        ]
      }
      throw new Error(`unexpected listDir call: ${p}`)
    })

    watchHandler!({ type: 'add', path: 'D:/proj/角色/动作/idle.png', mtime: Date.now() })
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))

    const tree = useFileExplorerStore.getState().workspaceTree
    const root = tree[0]!
    const dongzuo = root.children!.find((n) => n.name === '角色')!.children!.find((n) => n.name === '动作')!
    expect(dongzuo.children?.map((n) => n.name).sort()).toEqual(['idle.png', 'run.png', 'walk.png'])
  })
})
