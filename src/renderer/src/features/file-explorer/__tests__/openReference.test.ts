import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { useFileExplorerStore } from '../store'

const filePath = 'D:/repo/a.md'

function mockElectronApi(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      fs: {
        readText: vi.fn().mockResolvedValue({ content: '# A', mtime: 123 }),
        writeText: vi.fn(),
        listDir: vi.fn(),
        stat: vi.fn().mockResolvedValue({ ok: true, size: 3, mime: 'text/markdown', mtime: 123 }),
        pickFolder: vi.fn(),
        watchStart: vi.fn().mockResolvedValue(undefined),
        watchStop: vi.fn(),
      },
      attachments: {
        listTree: vi.fn(),
      },
    },
  })
}

describe('openReference', () => {
  beforeEach(() => {
    localStorage.clear()
    mockElectronApi()
    useFileExplorerStore.setState({
      fxOpen: false,
      tabs: [],
      activeTabId: null,
      workspaceRoot: null,
      workspaceTree: [],
      attachmentsTree: [],
      treeLoading: false,
      conflict: null,
      pendingChatInsert: null,
    })
  })

  it('opens the right panel when opening a local file reference', async () => {
    const reference: AgentReference = {
      id: `file:${filePath}`,
      type: 'file',
      label: 'a.md',
      source: { kind: 'localPath', path: filePath },
      status: 'ready',
      openBehavior: 'markdown',
    }

    await useFileExplorerStore.getState().openReference(reference)

    const state = useFileExplorerStore.getState()
    expect(state.fxOpen).toBe(true)
    expect(state.activeTabId).toBeTruthy()
    expect(state.tabs[0]).toMatchObject({
      path: filePath,
      name: 'a.md',
    })
  })

  it('falls back to reference details when a local file reference cannot be opened', async () => {
    vi.mocked(window.electronAPI.fs.stat).mockResolvedValue({ ok: false })
    const reference: AgentReference = {
      id: `file:${filePath}`,
      type: 'file',
      label: 'a.md',
      source: { kind: 'localPath', path: filePath },
      status: 'ready',
      openBehavior: 'markdown',
    }

    await useFileExplorerStore.getState().openReference(reference)

    const state = useFileExplorerStore.getState()
    expect(state.fxOpen).toBe(true)
    expect(state.activeTabId).toBeTruthy()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({
      kind: 'reference',
      name: 'a.md',
      referenceKey: reference.id,
      reference,
    })
  })
})
