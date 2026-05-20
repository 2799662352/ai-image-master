import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileExplorerStore } from '../store'
import type { FileNode } from '../types'

type ListedNode = Omit<FileNode, 'children' | 'childrenLoaded'> & { childrenLoaded?: false }

function tree(): FileNode[] {
  return [
    {
      path: 'C:/ws',
      name: 'ws',
      kind: 'dir',
      source: 'workspace',
      childrenLoaded: true,
      children: [],
    },
  ]
}

beforeEach(() => {
  const importExternal = vi.fn(async () => ({ ok: true, written: ['C:/ws/photo.png'] }))
  const listDir = vi.fn(async (): Promise<ListedNode[]> => [
    { path: 'C:/ws/photo.png', name: 'photo.png', kind: 'file', source: 'workspace' } as ListedNode,
  ])
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { setAllowedRoots: vi.fn() },
      fs: {
        importExternal,
        listDir,
        stat: vi.fn(async () => ({ ok: true, size: 1, mime: 'image/png', mtime: 1 })),
        watchStart: vi.fn(),
        watchStop: vi.fn(),
        onWatchEvent: vi.fn(() => () => undefined),
      },
      attachments: {
        listTree: vi.fn().mockResolvedValue([]),
        onChanged: vi.fn(() => () => undefined),
      },
    },
    configurable: true,
  })
  useFileExplorerStore.setState({
    workspaceTree: tree(),
    attachmentsTree: [],
    selectedPaths: [],
    clipboard: null,
    pendingNewNode: null,
  } as never)
})

describe('importExternalByDnd', () => {
  it('calls fs.importExternal and refreshes the dest dir on success', async () => {
    const res = await useFileExplorerStore
      .getState()
      .importExternalByDnd(['C:/desktop/photo.png'], 'C:/ws')

    expect(res.ok).toBe(true)
    expect(window.electronAPI.fs.importExternal).toHaveBeenCalledWith(
      ['C:/desktop/photo.png'],
      'C:/ws',
    )
    expect(window.electronAPI.fs.listDir).toHaveBeenCalledWith('C:/ws')
  })

  it('forwards IPC failure reason to caller', async () => {
    const fs = (window.electronAPI as unknown as { fs: { importExternal: ReturnType<typeof vi.fn> } }).fs
    fs.importExternal.mockResolvedValueOnce({ ok: false, reason: 'is_dir' })

    const res = await useFileExplorerStore
      .getState()
      .importExternalByDnd(['C:/desktop/folder'], 'C:/ws')

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('is_dir')
  })

  it('returns early with reason when sources is empty', async () => {
    const res = await useFileExplorerStore
      .getState()
      .importExternalByDnd([], 'C:/ws')

    expect(res.ok).toBe(false)
    expect(res.reason).toBe('nothing to import')
    expect(window.electronAPI.fs.importExternal).not.toHaveBeenCalled()
  })

  it('selects the last-written file on success', async () => {
    const fs = (window.electronAPI as unknown as { fs: { importExternal: ReturnType<typeof vi.fn> } }).fs
    fs.importExternal.mockResolvedValueOnce({
      ok: true,
      written: ['C:/ws/a.png', 'C:/ws/b.png'],
    })

    await useFileExplorerStore
      .getState()
      .importExternalByDnd(['C:/desktop/a.png', 'C:/desktop/b.png'], 'C:/ws')

    expect(useFileExplorerStore.getState().selectedPaths).toEqual(['C:/ws/b.png'])
  })
})
