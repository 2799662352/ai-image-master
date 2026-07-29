// 本地库抖动（PGlite 掉 socket → Prisma `P1017 Server has closed the connection`）
// 不该把用户的消息扣下来。
//
// 线上症状:`Error invoking remote method 'agent:send-message': PrismaClientKnownRequestError
// ... Server has closed the connection.` —— 消息压根没送到模型,用户只看到一个
// 打包后的 Prisma 堆栈,只能重启应用。
//
// 根因:assembleTurnInput 里持久化用户这一轮的 `store.addMessage` 是裸 await。
// 它左右两邻都已经是「best-effort」了(`setThreadRouting(...).catch()`、
// `updateLastMessageAt(...).catch()`,后者注释写着「failing to bump lastMessageAt
// should not block the turn」),同一条路上还有「失效引用跳过而不是拒发」
// 「附件逐项隔离」——唯独这一句没守这条教条。
//
// 它记的是账,不是这一轮成立的条件:落库只服务「重启后能读回历史」「自动标题需要
// ≥2 条消息」「edit-and-resend 需要行 id」。库抖一下就让整轮发不出去,代价远大于
// 少一行历史。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

interface BackendCall {
  threadId: string | undefined
  input: AgentInput
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-db-degraded-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(): IAgentBackend & { calls: BackendCall[] } {
  const calls: BackendCall[] = []
  return {
    calls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel() {},
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

/** Prisma 对 P1017 抛的就是这个形状(message 尾巴带这句话)。 */
function p1017(): Error {
  return new Error('Server has closed the connection. code: P1017')
}

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

describe('本地库抖动时仍然把消息发出去', () => {
  it('addMessage 抛 P1017:整轮照旧送达后端,不把消息扣下来', async () => {
    const backend = makeBackend()
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => { throw p1017() },
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (event) => events.push(event),
    })
    await mgr.setCodexApiKey('sk-test')

    const result = await mgr.sendMessage({
      threadId: 'thread-1',
      content: '15 秒竖屏电影短剧片段',
      attachments: [],
    })
    await flushMicrotasks()

    expect(result.threadId).toBe('thread-1')
    expect(backend.calls).toHaveLength(1)
    const text = backend.calls[0].input.items.find(
      (item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text',
    )
    expect(text?.text).toContain('15 秒竖屏电影短剧片段')
    // 没落库就没有行 id,如实不回带(renderer 的 edit-and-resend 会退化,但消息发出去了)
    expect(result.userMessageId).toBeUndefined()
  })

  it('落库失败要让用户知道 —— 静默丢历史比报错更糟', async () => {
    const backend = makeBackend()
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => { throw p1017() },
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (event) => events.push(event),
    })
    await mgr.setCodexApiKey('sk-test')

    await mgr.sendMessage({ threadId: 'thread-1', content: '你好', attachments: [] })
    await flushMicrotasks()

    const notice = events.find(
      (e): e is Extract<AgentStreamEvent, { type: 'notice' }> => e.type === 'notice',
    )
    expect(notice?.notice.level).toBe('warning')
    expect(notice?.notice.message).toContain('历史')
  })

  it('库好的时候照旧回带行 id —— 降级不能偷偷变成常态', async () => {
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'row-42' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
    })
    await mgr.setCodexApiKey('sk-test')

    const result = await mgr.sendMessage({
      threadId: 'thread-1',
      content: '你好',
      attachments: [],
    })
    await flushMicrotasks()

    expect(result.userMessageId).toBe('row-42')
    expect(backend.calls[0].input.clientUserMessageId).toBe('row-42')
  })

  it('新建会话时 createThread 抛 P1017 仍然明确失败 —— 没有 threadId 这轮无处安放', async () => {
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => { throw p1017() },
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
    })
    await mgr.setCodexApiKey('sk-test')

    // 刻意不降级:threadId 是事件流、附件外键、后续 turn 的挂靠点,伪造一个会把
    // 问题推到更难查的地方。这条用例是为了说明「哪些失败仍然该是致命的」。
    await expect(
      mgr.sendMessage({ content: '开个新会话', attachments: [] }),
    ).rejects.toThrow(/Server has closed the connection/)
    expect(backend.calls).toEqual([])
  })
})
