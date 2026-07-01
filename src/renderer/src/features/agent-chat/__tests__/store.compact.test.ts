import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const THREAD = 'db-thread-1'

let compactApi: ReturnType<typeof vi.fn>

function installApi(agent: Record<string, unknown>) {
  ;(globalThis as unknown as { window: unknown }).window = { electronAPI: { agent } }
}

beforeEach(() => {
  compactApi = vi.fn().mockResolvedValue({ ok: true, data: { started: true } })
  installApi({ compactThread: compactApi })
  useAgentChatStore.setState({ threadId: THREAD, notices: [], error: undefined })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('store.compact — real manual compaction', () => {
  it('forwards the active DB thread id to the compact RPC and posts a "compacting" notice', async () => {
    await useAgentChatStore.getState().compact()
    expect(compactApi).toHaveBeenCalledWith(THREAD)
    const n = useAgentChatStore.getState().notices[0]
    expect(n?.message).toMatch(/压缩|compact/i)
  })

  it('no-ops with a hint when there is no thread yet', async () => {
    useAgentChatStore.setState({ threadId: undefined })
    await useAgentChatStore.getState().compact()
    expect(compactApi).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().notices[0]?.message).toMatch(/会话|compact/i)
  })

  it('warns when the backend lacks the compact API', async () => {
    installApi({})
    await useAgentChatStore.getState().compact()
    expect(useAgentChatStore.getState().notices[0]?.message).toMatch(/不支持|compact/i)
  })

  it('surfaces an error when the RPC returns ok:false', async () => {
    compactApi.mockResolvedValue({ ok: false, error: 'boom' })
    await useAgentChatStore.getState().compact()
    expect(useAgentChatStore.getState().error).toBe('boom')
  })
})
