import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup, screen } from '@testing-library/react'
import { FileTreeNode } from '../FileTreeNode'
import { useFileExplorerStore } from '../store'
import type { FileNode } from '../types'

// jsdom's DataTransfer is a stub; we build one that supports the three calls
// the production code makes: setData, getData, and a `types` getter (used by
// `onDragOver` to recognize our payload before highlighting the drop target).
function makeDataTransfer(preset: Record<string, string> = {}): DataTransfer {
  const store = new Map<string, string>(Object.entries(preset))
  return {
    setData: (k: string, v: string) => {
      store.set(k, v)
    },
    getData: (k: string) => store.get(k) ?? '',
    get types() {
      return Array.from(store.keys())
    },
    dropEffect: 'none',
    effectAllowed: 'none',
    setDragImage: () => undefined,
  } as unknown as DataTransfer
}

const FILE_TYPE = 'application/x-catimation-file-paths'

beforeEach(() => {
  cleanup()
  Object.defineProperty(window, 'electronAPI', {
    value: {
      fs: {
        listDir: vi.fn().mockResolvedValue([]),
        readText: vi.fn(),
        writeText: vi.fn(),
        stat: vi.fn(),
        pickFolder: vi.fn(),
        watchStart: vi.fn(),
        watchStop: vi.fn(),
        onWatchEvent: vi.fn(() => () => undefined),
        move: vi.fn().mockResolvedValue({ ok: true, written: [] }),
      },
      attachments: {
        listTree: vi.fn().mockResolvedValue([]),
        onChanged: vi.fn(() => () => undefined),
      },
    },
    configurable: true,
  })
  useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
})

const fileNode: FileNode = {
  path: 'D:/proj/src/a.ts',
  name: 'a.ts',
  kind: 'file',
  source: 'workspace',
}
const dirNode: FileNode = {
  path: 'D:/proj/docs',
  name: 'docs',
  kind: 'dir',
  source: 'workspace',
  childrenLoaded: true,
  children: [],
}
const attachmentsRoot: FileNode = {
  path: '__attachments__',
  name: 'Attachments',
  kind: 'dir',
  source: 'attachments',
  childrenLoaded: true,
  children: [],
}

describe('FileTreeNode — drag', () => {
  it('directory rows are draggable (was previously blocked)', () => {
    render(<FileTreeNode node={dirNode} depth={0} />)
    const row = screen.getByText('docs').closest('[role="treeitem"]') as HTMLElement
    expect(row.draggable).toBe(true)
  })

  it('the synthetic attachments root is NOT draggable', () => {
    render(<FileTreeNode node={attachmentsRoot} depth={0} />)
    const row = screen.getByText('Attachments').closest('[role="treeitem"]') as HTMLElement
    expect(row.draggable).toBe(false)
  })

  it('dragstart on a directory serializes its path into the data transfer', () => {
    render(<FileTreeNode node={dirNode} depth={0} />)
    const row = screen.getByText('docs').closest('[role="treeitem"]') as HTMLElement
    const dt = makeDataTransfer()
    fireEvent.dragStart(row, { dataTransfer: dt })
    expect(dt.getData(FILE_TYPE)).toBe(JSON.stringify(['D:/proj/docs']))
  })
})

describe('FileTreeNode — drop target', () => {
  it('dropping onto a directory invokes moveByDnd with that dir as destination', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true })
    useFileExplorerStore.setState({ moveByDnd: spy })

    render(<FileTreeNode node={dirNode} depth={0} />)
    const row = screen.getByText('docs').closest('[role="treeitem"]') as HTMLElement
    const dt = makeDataTransfer({ [FILE_TYPE]: JSON.stringify(['D:/proj/src/a.ts']) })
    fireEvent.dragOver(row, { dataTransfer: dt })
    fireEvent.drop(row, { dataTransfer: dt })

    // Wait one microtask flush for the async drop handler.
    await Promise.resolve()
    await Promise.resolve()

    expect(spy).toHaveBeenCalledWith(['D:/proj/src/a.ts'], 'D:/proj/docs')
  })

  it('dropping onto a file uses its parent directory as destination (VSCode parity)', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true })
    useFileExplorerStore.setState({ moveByDnd: spy })

    render(<FileTreeNode node={fileNode} depth={0} />)
    const row = screen.getByText('a.ts').closest('[role="treeitem"]') as HTMLElement
    const dt = makeDataTransfer({ [FILE_TYPE]: JSON.stringify(['D:/proj/docs/other.ts']) })
    fireEvent.dragOver(row, { dataTransfer: dt })
    fireEvent.drop(row, { dataTransfer: dt })

    await Promise.resolve()
    await Promise.resolve()

    expect(spy).toHaveBeenCalledWith(['D:/proj/docs/other.ts'], 'D:/proj/src')
  })

  it('does not call moveByDnd when the drop payload is empty', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true })
    useFileExplorerStore.setState({ moveByDnd: spy })

    render(<FileTreeNode node={dirNode} depth={0} />)
    const row = screen.getByText('docs').closest('[role="treeitem"]') as HTMLElement
    const dt = makeDataTransfer() // no FILE_TYPE entry
    fireEvent.dragOver(row, { dataTransfer: dt })
    fireEvent.drop(row, { dataTransfer: dt })

    await Promise.resolve()
    await Promise.resolve()

    expect(spy).not.toHaveBeenCalled()
  })

  it('does not target the attachments pseudo-root for drops', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true })
    useFileExplorerStore.setState({ moveByDnd: spy })

    render(<FileTreeNode node={attachmentsRoot} depth={0} />)
    const row = screen.getByText('Attachments').closest('[role="treeitem"]') as HTMLElement
    const dt = makeDataTransfer({ [FILE_TYPE]: JSON.stringify(['D:/proj/src/a.ts']) })
    fireEvent.drop(row, { dataTransfer: dt })

    await Promise.resolve()
    await Promise.resolve()

    expect(spy).not.toHaveBeenCalled()
  })
})
