/**
 * 删除会话必须同时清掉 codex 侧的 rollout。
 *
 * 之前 `AgentManager.deleteThread` 只删 Prisma 行,codex 的 `.jsonl` rollout
 * 永久留在 `$CODEX_HOME/sessions/` —— 既是磁盘泄漏,也让 `thread/list` 里仍能
 * 看到用户以为已经删掉的会话。`CodexProtocolClient.deleteThread`(thread/delete)
 * 早就写好了,只是没有任何调用者。
 *
 * 本地行删除是权威操作:codex 侧删除失败/不可用只记警告,绝不能把用户的删除按钮
 * 卡住。
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentManager } from '../AgentManager'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-delete-'))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
})

function fakeBackend(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(),
    cancel: vi.fn(),
    isHealthy: vi.fn().mockReturnValue(true),
    onMcpNotification: vi.fn(),
    deleteThread: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function fakeStore(codexThreadId: string | null) {
  return {
    getCodexThreadId: vi.fn().mockResolvedValue(codexThreadId),
    deleteThread: vi.fn().mockResolvedValue(undefined),
  }
}

function makeManager(backend: ReturnType<typeof fakeBackend>, store: ReturnType<typeof fakeStore>) {
  return new AgentManager({ userDataDir: tmpDir, backend: backend as any, store: store as any })
}

describe('AgentManager.deleteThread', () => {
  it('先删 codex rollout(用 codex thread id)再删本地行', async () => {
    const backend = fakeBackend()
    const store = fakeStore('thr_codex')
    const order: string[] = []
    backend.deleteThread.mockImplementation(async () => {
      order.push('codex')
    })
    store.deleteThread.mockImplementation(async () => {
      order.push('local')
    })

    await makeManager(backend, store).deleteThread('db-1')

    expect(backend.deleteThread).toHaveBeenCalledWith('thr_codex')
    expect(store.deleteThread).toHaveBeenCalledWith('db-1')
    // 顺序要紧:本地行一删,codex id 的持久化映射就查不到了。
    expect(order).toEqual(['codex', 'local'])
  })

  it('codex 侧删除失败不阻断本地删除(只记警告)', async () => {
    const backend = fakeBackend({
      deleteThread: vi.fn().mockRejectedValue(new Error('thread/delete unsupported')),
    })
    const store = fakeStore('thr_codex')

    await expect(makeManager(backend, store).deleteThread('db-1')).resolves.toBeUndefined()
    expect(store.deleteThread).toHaveBeenCalledWith('db-1')
    expect(console.warn).toHaveBeenCalled()
  })

  it('没有 codex 映射(会话从未发过消息)时不碰后端', async () => {
    const backend = fakeBackend()
    const store = fakeStore(null)

    await makeManager(backend, store).deleteThread('db-1')

    expect(backend.deleteThread).not.toHaveBeenCalled()
    expect(store.deleteThread).toHaveBeenCalledWith('db-1')
  })

  it('后端未启动(冷启动删历史)时不尝试 RPC', async () => {
    const backend = fakeBackend({ isHealthy: vi.fn().mockReturnValue(false) })
    const store = fakeStore('thr_codex')

    await makeManager(backend, store).deleteThread('db-1')

    expect(backend.deleteThread).not.toHaveBeenCalled()
    expect(store.deleteThread).toHaveBeenCalledWith('db-1')
  })

  it('后端不支持 thread/delete 时安静跳过', async () => {
    const backend = fakeBackend({ deleteThread: undefined })
    const store = fakeStore('thr_codex')

    await makeManager(backend, store).deleteThread('db-1')

    expect(store.deleteThread).toHaveBeenCalledWith('db-1')
  })

  it('无 store 时仍然抛错(调用方契约不变)', async () => {
    const backend = fakeBackend()
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: backend as any })
    await expect(mgr.deleteThread('db-1')).rejects.toThrow(/without store/)
  })
})
