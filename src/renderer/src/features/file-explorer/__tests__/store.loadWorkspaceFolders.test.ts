import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerStore } from '../store'

const FX_WORKSPACE_KEY = 'agent-chat:fx-workspace-root'

const order: string[] = []
let setAllowedRoots: ReturnType<typeof vi.fn>
let listDir: ReturnType<typeof vi.fn>

beforeEach(() => {
  order.length = 0
  setAllowedRoots = vi.fn(async (roots: string[]) => {
    order.push(`setAllowedRoots:${roots.join(',')}`)
    return roots
  })
  listDir = vi.fn(async (p: string) => {
    order.push(`listDir:${p}`)
    return [{ path: `${p}/a.txt`, name: 'a.txt', kind: 'file', source: 'workspace' }]
  })
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { setAllowedRoots },
      fs: {
        listDir,
        watchStart: vi.fn(async () => undefined),
        watchStop: vi.fn(),
        onWatchEvent: vi.fn(() => () => undefined),
      },
      attachments: { listTree: vi.fn().mockResolvedValue([]), onChanged: vi.fn(() => () => undefined) },
    },
    configurable: true,
  })
  globalThis.localStorage?.setItem(FX_WORKSPACE_KEY, JSON.stringify(['D:/proj']))
  useFileExplorerStore.setState({ workspaceTree: [], workspaceRoot: 'D:/proj' } as never)
})

afterEach(() => {
  globalThis.localStorage?.removeItem(FX_WORKSPACE_KEY)
})

describe('loadWorkspaceFolders (restart persistence)', () => {
  it('syncs allowed-roots BEFORE listing so the restored workspace passes the fs gate', async () => {
    await useFileExplorerStore.getState().loadWorkspaceFolders()

    // The persisted root must be registered with the main-process fs gate
    // before listDir runs — otherwise assertContained rejects it on a fresh
    // launch (allowedRoots is empty) and the panel shows "No folder open".
    const firstSync = order.findIndex((o) => o.startsWith('setAllowedRoots'))
    const firstList = order.findIndex((o) => o.startsWith('listDir'))
    expect(firstSync).toBeGreaterThanOrEqual(0)
    expect(firstList).toBeGreaterThanOrEqual(0)
    expect(firstSync).toBeLessThan(firstList)
    expect(setAllowedRoots).toHaveBeenCalledWith(['D:/proj'])

    // And the workspace actually loaded (not "No folder open").
    const s = useFileExplorerStore.getState()
    expect(s.workspaceTree.map((n) => n.path)).toEqual(['D:/proj'])
    expect(s.workspaceRoot).toBe('D:/proj')
  })
})
