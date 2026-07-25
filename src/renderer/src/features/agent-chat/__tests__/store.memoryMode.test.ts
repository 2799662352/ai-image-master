// @vitest-environment jsdom
/**
 * Per-thread cross-session memory choice, renderer half. The authoritative
 * value lives on the thread row in the main-process DB, so the store's job is
 * narrow: forward the choice, refresh the list on success, and hand failures
 * back to the caller (the sidebar menu renders them in place) instead of
 * throwing into a click handler.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const declareThreadMemoryMode = vi.fn()
const listThreads = vi.fn()

beforeEach(() => {
  declareThreadMemoryMode.mockReset().mockResolvedValue({ ok: true, pushed: true })
  listThreads.mockReset().mockResolvedValue([
    { id: 'db-1', title: 'Chat', createdAt: '', updatedAt: '', memoryMode: 'disabled' },
  ])
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { declareThreadMemoryMode, listThreads, onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({ threadList: [], memoriesGloballyEnabled: undefined })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('setThreadMemoryMode', () => {
  it('forwards the choice and re-reads the list so the menu reflects the stored row', async () => {
    const res = await useAgentChatStore.getState().setThreadMemoryMode('db-1', 'disabled')

    expect(declareThreadMemoryMode).toHaveBeenCalledWith('db-1', 'disabled')
    expect(res).toEqual({ ok: true })
    expect(listThreads).toHaveBeenCalled()
    expect(useAgentChatStore.getState().threadList[0]?.memoryMode).toBe('disabled')
  })

  it('reports a backend refusal without refreshing or throwing', async () => {
    declareThreadMemoryMode.mockResolvedValue({ ok: false, error: 'memory feature is disabled' })

    const res = await useAgentChatStore.getState().setThreadMemoryMode('db-1', 'disabled')

    expect(res).toEqual({ ok: false, error: 'memory feature is disabled' })
    expect(listThreads).not.toHaveBeenCalled()
  })

  it('turns a thrown IPC error into a result the click handler can render', async () => {
    declareThreadMemoryMode.mockRejectedValue(new Error('ipc closed'))

    const res = await useAgentChatStore.getState().setThreadMemoryMode('db-1', 'enabled')

    expect(res).toEqual({ ok: false, error: 'ipc closed' })
  })

  it('explains itself on an older preload that lacks the method', async () => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = {
      agent: { listThreads, onEvent: () => () => undefined },
    }

    const res = await useAgentChatStore.getState().setThreadMemoryMode('db-1', 'enabled')

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/不支持/)
  })

  it('refuses a thread that has no id yet — nothing to attach the choice to', async () => {
    const res = await useAgentChatStore.getState().setThreadMemoryMode('', 'disabled')

    expect(res.ok).toBe(false)
    expect(declareThreadMemoryMode).not.toHaveBeenCalled()
  })
})

describe('setMemoriesGloballyEnabled', () => {
  it('mirrors the global switch so the sidebar can disable a meaningless toggle', () => {
    useAgentChatStore.getState().setMemoriesGloballyEnabled(false)
    expect(useAgentChatStore.getState().memoriesGloballyEnabled).toBe(false)

    useAgentChatStore.getState().setMemoriesGloballyEnabled(undefined)
    expect(useAgentChatStore.getState().memoriesGloballyEnabled).toBeUndefined()
  })
})
