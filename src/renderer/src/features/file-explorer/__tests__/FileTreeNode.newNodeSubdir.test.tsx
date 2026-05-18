import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen, act, waitFor } from '@testing-library/react'
import { FileTree } from '../FileTree'
import { FileTreeNode } from '../FileTreeNode'
import { useFileExplorerStore, __resetSubscriptionsForTesting } from '../store'
import type { FileNode } from '../types'

// Repro: user reports "在主目录可以新建文件/文件夹，但是子目录不行".
// This test simulates the exact flow:
//   1. Render a subdir row (a child of some workspace root).
//   2. Right-click → expect '新建文件夹' menu item.
//   3. Click it → expect an inline NewNodeRow input to appear.
//   4. Type a name + Enter → expect fs.createFolder to be called with the
//      SUBDIR path (not the root), and the new entry to surface in the tree.
//
// If any step fails, that pinpoints which layer is broken in subdir context.

const createFolderMock = vi.fn()
const listDirMock = vi.fn()

beforeEach(() => {
  cleanup()
  createFolderMock.mockReset().mockResolvedValue({ ok: true, path: 'D:/proj/角色/动作/新文件夹' })
  listDirMock.mockReset().mockResolvedValue([
    {
      path: 'D:/proj/角色/动作/新文件夹',
      name: '新文件夹',
      kind: 'dir',
      source: 'workspace',
      childrenLoaded: false,
    },
  ])
  Object.defineProperty(window, 'electronAPI', {
    value: {
      fs: {
        listDir: listDirMock,
        readText: vi.fn(),
        writeText: vi.fn(),
        stat: vi.fn(),
        pickFolder: vi.fn(),
        watchStart: vi.fn(),
        watchStop: vi.fn(),
        onWatchEvent: vi.fn(() => () => undefined),
        createFile: vi.fn(),
        createFolder: createFolderMock,
        move: vi.fn(),
      },
      attachments: {
        listTree: vi.fn().mockResolvedValue([]),
        onChanged: vi.fn(() => () => undefined),
      },
    },
    configurable: true,
  })
  __resetSubscriptionsForTesting()
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)

  // Pre-seed a workspace tree that contains the exact shape the user has:
  // root  D:/proj  (childrenLoaded=true)
  //   └── 角色   (childrenLoaded=true)
  //         └── 动作 (childrenLoaded=true, empty)
  const dongzuo: FileNode = {
    path: 'D:/proj/角色/动作',
    name: '动作',
    kind: 'dir',
    source: 'workspace',
    childrenLoaded: true,
    children: [],
  }
  useFileExplorerStore.setState({
    workspaceRoot: 'D:/proj',
    workspaceTree: [
      {
        path: 'D:/proj',
        name: 'proj',
        kind: 'dir',
        source: 'workspace',
        childrenLoaded: true,
        children: [
          {
            path: 'D:/proj/角色',
            name: '角色',
            kind: 'dir',
            source: 'workspace',
            childrenLoaded: true,
            children: [dongzuo],
          },
        ],
      },
    ],
  })
})

describe('FileTreeNode — new node in a subdirectory', () => {
  it('right-click on an UNEXPANDED subdir → 新建文件夹 → input appears, even when the dir was previously collapsed', async () => {
    // This is the more realistic case: the user just opened the workspace
    // and is right-clicking on a subdir they haven't expanded yet. The
    // expectation is that 新建文件夹 still works — the dir auto-opens to
    // host the input.
    listDirMock.mockResolvedValue([])
    useFileExplorerStore.setState({
      workspaceRoot: 'D:/proj',
      workspaceTree: [
        {
          path: 'D:/proj',
          name: 'proj',
          kind: 'dir',
          source: 'workspace',
          childrenLoaded: true,
          children: [
            {
              path: 'D:/proj/角色',
              name: '角色',
              kind: 'dir',
              source: 'workspace',
              childrenLoaded: true,
              children: [
                {
                  path: 'D:/proj/角色/动作',
                  name: '动作',
                  kind: 'dir',
                  source: 'workspace',
                  childrenLoaded: false, // <-- the key difference: NOT yet expanded
                },
              ],
            },
          ],
        },
      ],
    })

    const root = useFileExplorerStore.getState().workspaceTree[0]!
    render(<FileTreeNode node={root} depth={0} />)

    expect(screen.getByText('动作')).toBeTruthy()

    await act(async () => {
      fireEvent.contextMenu(screen.getByText('动作'))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }))
    })

    const input = screen.queryByPlaceholderText('新文件夹名')
    expect(input).toBeTruthy()
  })

  it('right-click → 新建文件夹 → input appears under the SUBDIR (not the root)', async () => {
    // Render the WHOLE subtree starting from the root so we can find 动作 as
    // a descendant — matches what the user actually sees.
    const root = useFileExplorerStore.getState().workspaceTree[0]!
    render(<FileTreeNode node={root} depth={0} />)

    // Both 'root' and '角色' start expanded because their useState init reads
    // `childrenLoaded===true && children.length>0` from their seeded props. No
    // user click needed.
    expect(screen.getByText('角色')).toBeTruthy()
    expect(screen.getByText('动作')).toBeTruthy()

    // Right-click on 动作
    await act(async () => {
      fireEvent.contextMenu(screen.getByText('动作'))
    })

    const newFolderBtn = screen.getByRole('menuitem', { name: '新建文件夹' })
    expect(newFolderBtn).toBeTruthy()
    await act(async () => {
      fireEvent.click(newFolderBtn)
    })

    // The inline NewNodeRow input should now be visible under 动作.
    const input = screen.queryByPlaceholderText('新文件夹名')
    expect(input).toBeTruthy()

    // Type a name + Enter.
    await act(async () => {
      fireEvent.change(input!, { target: { value: '冲刺' } })
      fireEvent.keyDown(input!, { key: 'Enter' })
    })

    // fs.createFolder should be called with the SUBDIR path, not the root.
    expect(createFolderMock).toHaveBeenCalledWith('D:/proj/角色/动作', '冲刺')
  })

  it('after commit, the new folder is visible inside the subdir in the tree state AND the DOM', async () => {
    // The user's real complaint: "子目录下新建无效". This test goes one step
    // beyond `was createFolder called` and asserts the new entry is actually
    // wired into `workspaceTree` AND rendered in the DOM (production renders
    // FileTree, which subscribes to the store; this test must do the same to
    // catch real-world breakage, not artifacts of a stale prop reference).
    render(<FileTree />)

    expect(screen.getByText('动作')).toBeTruthy()

    fireEvent.contextMenu(screen.getByText('动作'))
    fireEvent.click(screen.getByRole('menuitem', { name: '新建文件夹' }))

    // The menu's onSelect → handleAction → startNewNode is fire-and-forget
    // from the click handler. Wait for the inline new-node input to appear.
    // PRE-FIX: a fallback NewNodeRow in FileTree (matching any subdir path
    // because its `every(n => n.path !== parentPath)` only checked root level)
    // would render at the panel bottom, steal focus, blur the real input, and
    // commitNewNode('') would clear pendingNewNode before the user could type
    // anything. The fix removes the redundant fallback. This assertion now
    // proves only ONE NewNodeRow exists, in the right place.
    const input = await waitFor(() => screen.getByPlaceholderText('新文件夹名'))
    const allInputs = document.querySelectorAll('input[placeholder="新文件夹名"]')
    expect(allInputs.length).toBe(1)

    fireEvent.change(input, { target: { value: '新文件夹' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Wait for commit + expandDir merge to flush into both store + DOM.
    await waitFor(() => expect(screen.queryByText('新文件夹')).toBeTruthy())

    const tree = useFileExplorerStore.getState().workspaceTree
    const dongzuo = tree[0]!.children!.find((n) => n.name === '角色')!.children!.find(
      (n) => n.name === '动作',
    )!
    expect(dongzuo.childrenLoaded).toBe(true)
    expect(dongzuo.children?.map((n) => n.name)).toContain('新文件夹')
  })
})
