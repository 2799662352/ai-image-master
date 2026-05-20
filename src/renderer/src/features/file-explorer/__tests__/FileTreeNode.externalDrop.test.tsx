import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTreeNode } from '../FileTreeNode'
import { useFileExplorerStore } from '../store'
import type { FileNode } from '../types'

afterEach(cleanup)

beforeEach(() => {
  const importExternalByDnd = vi.fn(async () => ({ ok: true, written: ['C:/ws/photo.png'] }))
  useFileExplorerStore.setState({
    workspaceTree: [],
    attachmentsTree: [],
    selectedPaths: [],
    clipboard: null,
    pendingNewNode: null,
    importExternalByDnd,
  } as never)
  Object.defineProperty(window, 'electronAPI', {
    value: {
      getFilePath: vi.fn((file: File) => `C:/desktop/${file.name}`),
      fs: { stat: vi.fn(async () => ({ ok: true, size: 1, mime: 'image/png', mtime: 1 })) },
    },
    configurable: true,
  })
})

function makeExternalDt(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files: files as unknown as FileList,
    getData: () => '',
    setData: () => {},
    dropEffect: 'copy',
  } as unknown as DataTransfer
}

const folder: FileNode = {
  path: 'C:/ws',
  name: 'ws',
  kind: 'dir',
  source: 'workspace',
  childrenLoaded: true,
  children: [],
}

describe('FileTreeNode external drop', () => {
  it('invokes importExternalByDnd when an OS file is dropped on a folder node', async () => {
    render(<FileTreeNode node={folder} depth={0} />)
    const row = screen.getByText('ws').closest('[role="treeitem"]') as HTMLElement

    const dt = makeExternalDt([new File(['x'], 'photo.png', { type: 'image/png' })])
    fireEvent.dragOver(row, { dataTransfer: dt })
    fireEvent.drop(row, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    expect(useFileExplorerStore.getState().importExternalByDnd).toHaveBeenCalledWith(
      ['C:/desktop/photo.png'],
      'C:/ws',
    )
  })

  it('does not invoke moveByDnd or importExternalByDnd if neither MIME is present', async () => {
    const moveByDnd = vi.fn(async () => ({ ok: true }))
    useFileExplorerStore.setState({ moveByDnd } as never)
    render(<FileTreeNode node={folder} depth={0} />)
    const row = screen.getByText('ws').closest('[role="treeitem"]') as HTMLElement

    const dt = {
      types: ['text/plain'],
      files: [] as unknown as FileList,
      getData: (t: string) => (t === 'text/plain' ? 'hello' : ''),
      setData: () => {},
    } as unknown as DataTransfer
    fireEvent.dragOver(row, { dataTransfer: dt })
    fireEvent.drop(row, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    expect(useFileExplorerStore.getState().importExternalByDnd).not.toHaveBeenCalled()
    expect(moveByDnd).not.toHaveBeenCalled()
  })

  it('still uses moveByDnd path for internal MIME drops (regression guard)', async () => {
    const moveByDnd = vi.fn(async () => ({ ok: true }))
    useFileExplorerStore.setState({ moveByDnd } as never)
    render(<FileTreeNode node={folder} depth={0} />)
    const row = screen.getByText('ws').closest('[role="treeitem"]') as HTMLElement

    const internalDt = {
      types: ['application/x-catimation-file-paths'],
      files: [] as unknown as FileList,
      getData: (t: string) =>
        t === 'application/x-catimation-file-paths'
          ? JSON.stringify(['C:/ws/src/a.ts'])
          : '',
      setData: () => {},
    } as unknown as DataTransfer
    fireEvent.dragOver(row, { dataTransfer: internalDt })
    fireEvent.drop(row, { dataTransfer: internalDt })
    await new Promise((r) => setTimeout(r, 0))

    expect(moveByDnd).toHaveBeenCalledWith(['C:/ws/src/a.ts'], 'C:/ws')
    expect(useFileExplorerStore.getState().importExternalByDnd).not.toHaveBeenCalled()
  })
})
