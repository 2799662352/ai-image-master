import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../types/agent-reference'
import { useFileExplorerStore } from '../store'

const shellRef: AgentReference = {
  id: 'command:cmd_1',
  type: 'command',
  label: 'npm run test',
  source: { kind: 'codexItem', itemId: 'cmd_1' },
  status: 'success',
  openBehavior: 'shellOutput',
  preview: { command: 'npm run test', cwd: 'D:/repo', stdout: 'ok', stderr: '', exitCode: 0 },
}

const fileRef: AgentReference = {
  id: 'file:D:/repo/src/main.ts',
  type: 'file',
  label: 'main.ts',
  source: { kind: 'localPath', path: 'D:/repo/src/main.ts' },
  status: 'ready',
  openBehavior: 'code',
}

describe('file explorer reference tabs', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({
      tabs: [],
      activeTabId: null,
      conflict: null,
      pendingChatInsert: null,
    })
  })

  it('opens a synthetic reference tab for shell-output references', async () => {
    await useFileExplorerStore.getState().openReference(shellRef)
    const state = useFileExplorerStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]).toMatchObject({ kind: 'reference', referenceKey: shellRef.id })
    expect(state.tabs[0].path).toBe('')
    expect(state.activeTabId).toBe(state.tabs[0].id)
  })

  it('focuses an existing reference tab instead of duplicating it', async () => {
    await useFileExplorerStore.getState().openReference(shellRef)
    await useFileExplorerStore.getState().openReference(shellRef)
    const state = useFileExplorerStore.getState()
    expect(state.tabs).toHaveLength(1)
  })

  it('delegates local-path file references to openTab so FileViewer is reused', async () => {
    const openTab = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openTab } as never)
    await useFileExplorerStore.getState().openReference(fileRef)
    expect(openTab).toHaveBeenCalledWith('D:/repo/src/main.ts', 'workspace')
    expect(useFileExplorerStore.getState().tabs).toHaveLength(0)
  })

  it('blocks watcher matching from picking up reference tabs by path collision', async () => {
    await useFileExplorerStore.getState().openReference({
      ...shellRef,
      id: 'command:D:/repo/src/main.ts',
    })
    const tab = useFileExplorerStore.getState().tabs[0]
    expect(tab.path).toBe('')
    expect(tab.referenceKey).toBe('command:D:/repo/src/main.ts')
  })
})
