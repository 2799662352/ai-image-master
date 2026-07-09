/**
 * openAiChange — opens a synthetic "ai-change" compare tab for a FileChange
 * coming from a Codex fileEdit timeline item. Committed empty in the v4.2.7
 * wip; filled in as part of the baseline cleanup.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { FileChange } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../store'

function makeChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: 'D:/repo/src/foo.ts',
    operation: 'edit',
    diff: [
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
    ].join('\n'),
    added: 1,
    removed: 1,
    ...overrides,
  }
}

describe('openAiChange', () => {
  beforeEach(() => {
    localStorage.clear()
    useFileExplorerStore.setState({
      fxOpen: false,
      tabs: [],
      activeTabId: null,
      scrollActiveTabToken: 0,
    } as never)
  })

  it('opens a new ai-change tab with parsed before/after contents', async () => {
    await useFileExplorerStore.getState().openAiChange(makeChange())

    const state = useFileExplorerStore.getState()
    expect(state.fxOpen).toBe(true)
    expect(state.tabs).toHaveLength(1)
    const tab = state.tabs[0]
    expect(state.activeTabId).toBe(tab.id)
    expect(tab).toMatchObject({
      kind: 'ai-change',
      name: 'foo.ts',
      path: '', // synthetic tab — must not match filesystem watcher events
    })
    expect(tab.aiChange?.beforeContent).toBe('const a = 1\nconst b = 2')
    expect(tab.aiChange?.afterContent).toBe('const a = 1\nconst b = 3')
    expect(tab.aiChange?.parseError).toBeUndefined()
  })

  it('re-activates the existing tab for the same path+diff instead of duplicating', async () => {
    const change = makeChange()
    await useFileExplorerStore.getState().openAiChange(change)
    const firstId = useFileExplorerStore.getState().activeTabId
    const tokenBefore = useFileExplorerStore.getState().scrollActiveTabToken

    // Deactivate, then reopen the same change.
    useFileExplorerStore.setState({ activeTabId: null, fxOpen: false } as never)
    await useFileExplorerStore.getState().openAiChange(change)

    const state = useFileExplorerStore.getState()
    expect(state.tabs).toHaveLength(1)
    expect(state.activeTabId).toBe(firstId)
    expect(state.fxOpen).toBe(true)
    expect(state.scrollActiveTabToken).toBe(tokenBefore + 1)
  })

  it('opens separate tabs for different diffs of the same path', async () => {
    await useFileExplorerStore.getState().openAiChange(makeChange())
    await useFileExplorerStore.getState().openAiChange(
      makeChange({
        diff: [
          '--- a/src/foo.ts',
          '+++ b/src/foo.ts',
          '@@ -1 +1 @@',
          '-const a = 1',
          '+const a = 42',
        ].join('\n'),
      }),
    )

    expect(useFileExplorerStore.getState().tabs).toHaveLength(2)
  })

  it('records a parseError instead of contents for an unparseable diff', async () => {
    await useFileExplorerStore.getState().openAiChange(makeChange({ diff: '' }))

    const tab = useFileExplorerStore.getState().tabs[0]
    expect(tab.aiChange?.parseError).toBe('empty diff')
    expect(tab.aiChange?.beforeContent).toBeUndefined()
    expect(tab.aiChange?.afterContent).toBeUndefined()
  })
})
