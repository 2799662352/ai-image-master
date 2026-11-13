// @vitest-environment jsdom
// send() 的 IPC 要等主进程「受理」这个回合才返回(全局串行的准入队列、新对话的 thread/start、
// 旧对话的线程恢复、附件落盘),窗口从几百毫秒到几秒不等。用户很自然会在这段时间里点去另一个对话。
//
// 以前 send() 在 await 返回后无条件 `set({ threadId: result.threadId })`:活动线程被改回发送方,
// 屏幕上的消息列表却还是用户新点开的那个对话 —— 从此发送方的所有事件和出图气泡都写进了
// 「用户正在看的另一个对话」,而那个对话自己的输出反而掉进后台分片。
// 现象:「别的对话生成的图出现在当前对话里,看你停在哪个对话」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import type { ArtifactItem, Message } from '../../../../../types/agent-timeline'

const sendMessage = vi.fn()
const listThreads = vi.fn()
const openThread = vi.fn()

type SendResult = { threadId: string; userMessageItems?: unknown[]; userMessageId?: string }

/** 把 sendMessage 换成手动放行的:send() 卡在 await,让「用户中途切走」成为确定的时序。 */
function deferSend(): { resolve: (r: SendResult) => void; reject: (e: Error) => void } {
  let resolve!: (r: SendResult) => void
  let reject!: (e: Error) => void
  sendMessage.mockImplementation(
    () =>
      new Promise<SendResult>((res, rej) => {
        resolve = res
        reject = rej
      }),
  )
  return { resolve: (r) => resolve(r), reject: (e) => reject(e) }
}

/** 给「下一次 sendMessage 调用」单独配一个手动放行的闸;连配两个就是两次发送各自独立。 */
function gateNextSend(): { resolve: (r: SendResult) => void; reject: (e: Error) => void } {
  let resolve!: (r: SendResult) => void
  let reject!: (e: Error) => void
  sendMessage.mockImplementationOnce(
    () =>
      new Promise<SendResult>((res, rej) => {
        resolve = res
        reject = rej
      }),
  )
  return { resolve: (r) => resolve(r), reject: (e) => reject(e) }
}

function textMsg(id: string, content: string): Message {
  return {
    id,
    role: 'user',
    createdAt: 1,
    items: [{ type: 'text', id: `${id}-t`, startedAt: 1, content }],
  }
}

function artifactsOf(messages: Message[]): ArtifactItem[] {
  return messages.flatMap((m) => m.items.filter((i): i is ArtifactItem => i.type === 'artifact'))
}

const state = () => useAgentChatStore.getState()

beforeEach(() => {
  sendMessage.mockReset()
  listThreads.mockReset().mockResolvedValue([])
  openThread.mockReset()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: { sendMessage, listThreads, openThread, onEvent: () => () => undefined },
  }
  useAgentChatStore.setState({
    threadId: undefined,
    messages: [],
    isRunning: false,
    input: 'make me a cat',
    attachments: [],
    pendingReferences: [],
    failedSendSnapshots: {},
    availableSkills: [],
    selectedModelId: 'gpt-5.5',
    // B 是用户中途点开的另一个对话:有现成的后台分片,switchThread 同步切过去。
    threadSlices: {
      B: { messages: [textMsg('b1', 'hello from B')], isRunning: false, tokenUsage: undefined, error: undefined },
    },
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
    notices: [],
    error: undefined,
  })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('send():IPC 在途时用户切走,返回后不能把活动线程抢回发送方', () => {
  it('已有对话 A 发消息 → 切到 B → IPC 返回:B 仍是活动对话,列表不变;A 的气泡在 A 的分片里变「已送达」', async () => {
    useAgentChatStore.setState({ threadId: 'A' })
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    void state().switchThread('B') // 用户此刻点开了 B
    expect(state().threadId).toBe('B')

    gate.resolve({ threadId: 'A' })
    await sending

    expect(state().threadId).toBe('B')
    expect(state().messages.map((m) => m.id)).toEqual(['b1'])
    expect(state().runningByThread.A).toBe(true) // 侧栏小圆点仍然亮着

    const aMsgs = state().threadSlices.A?.messages ?? []
    expect(aMsgs).toHaveLength(1)
    expect(aMsgs[0].role).toBe('user')
    expect(aMsgs[0].sendState).toBe('sent')
  })

  it('新对话 X 发消息 → 切到 B → IPC 返回:X 的出图气泡落进 X 的分片,B 的列表保持干净(用户看到的症状)', async () => {
    const gate = deferSend()

    const sending = state().send() // 新对话:threadId 为空
    await Promise.resolve()
    void state().switchThread('B')
    gate.resolve({ threadId: 'X' })
    await sending

    // 之后 X 的 agent 调 generate_image:请求带的线程 id 就是 X。
    const genId = state().beginImageGeneration('cat from X', 'X')
    state().resolveImageGeneration(genId, [], 'X')

    expect(state().threadId).toBe('B')
    expect(artifactsOf(state().messages)).toHaveLength(0)
    expect(artifactsOf(state().threadSlices.X?.messages ?? [])).toHaveLength(1)
    expect(state().runningByThread.X).toBe(true)
  })

  it('新对话 X 发消息 → 点「新对话」→ IPC 返回:停留在全新的空对话,不被拽进 X', async () => {
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    state().newThread()
    gate.resolve({ threadId: 'X' })
    await sending

    expect(state().threadId).toBeUndefined()
    expect(state().messages).toEqual([])
    expect(state().runningByThread.X).toBe(true)
  })

  it('对照:用户没切走 → 新对话照旧认领 result.threadId,气泡变「已送达」', async () => {
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    gate.resolve({ threadId: 'X', userMessageId: 'row-1' })
    await sending

    expect(state().threadId).toBe('X')
    const last = state().messages[state().messages.length - 1]
    expect(last.role).toBe('user')
    expect(last.sendState).toBe('sent')
    expect(last.dbRowId).toBe('row-1')
  })

  it('对照:IPC 在途时 thread_created 已先把新对话认领成 X,返回后仍在 X,不算「切走」', async () => {
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    state().applyEvent({ type: 'thread_created', threadId: 'X' } as never)
    expect(state().threadId).toBe('X')
    gate.resolve({ threadId: 'X' })
    await sending

    expect(state().threadId).toBe('X')
    expect(state().messages.some((m) => m.sendState === 'sent')).toBe(true)
  })

  it('新对话 X 离场后:X 的用户气泡补种进 X 的分片(事件流从不生成用户消息),排在已到的助手内容之前', async () => {
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    void state().switchThread('B')
    // 事件先于 IPC 返回:X 已经有后台分片,只含助手侧内容。
    useAgentChatStore.setState((s) => ({
      threadSlices: {
        ...s.threadSlices,
        X: {
          messages: [
            {
              id: 'x-a1',
              role: 'assistant',
              createdAt: 2,
              items: [{ type: 'text', id: 'x-a1-t', startedAt: 2, content: 'working on it' }],
            },
          ],
          isRunning: true,
        },
      },
    }))
    gate.resolve({ threadId: 'X', userMessageId: 'row-9' })
    await sending

    const xMsgs = state().threadSlices.X?.messages ?? []
    expect(xMsgs.map((m) => m.id)).toEqual([expect.any(String), 'x-a1'])
    expect(xMsgs[0].role).toBe('user')
    expect(xMsgs[0].sendState).toBe('sent')
    expect(xMsgs[0].dbRowId).toBe('row-9')
    expect(state().messages.map((m) => m.id)).toEqual(['b1'])
  })

  it('用户离场后 IPC 才返回:只摘掉这次发出去的引用,不清掉用户在 B 里新加的', async () => {
    const sentRef = {
      id: 'ref-sent',
      type: 'file',
      label: 'a.ts',
      source: { kind: 'localPath', path: 'D:/a.ts' },
      status: 'ready',
      openBehavior: 'code',
    } as const
    const draftRef = { ...sentRef, id: 'ref-draft-in-B', label: 'b.ts' }
    useAgentChatStore.setState({ threadId: 'A', pendingReferences: [sentRef] })
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    void state().switchThread('B')
    useAgentChatStore.setState((s) => ({ pendingReferences: [...s.pendingReferences, draftRef] }))
    gate.resolve({ threadId: 'A' })
    await sending

    expect(state().pendingReferences.map((r) => r.id)).toEqual(['ref-draft-in-B'])
  })

  it('新对话失败且用户已离场:不动 B,不留悬空快照,用一条全局提示告知', async () => {
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    void state().switchThread('B')
    gate.reject(new Error('gateway exploded'))
    await sending

    expect(state().threadId).toBe('B')
    expect(state().error).toBeUndefined()
    expect(state().messages.map((m) => m.id)).toEqual(['b1'])
    expect(Object.keys(state().failedSendSnapshots)).toEqual([])
    const notice = state().notices.find((n) => n.id.startsWith('send-failed-'))
    expect(notice?.message).toContain('gateway exploded')
    expect(notice?.threadId).toBeUndefined()
  })

  it('发送失败时用户已在 B:不碰 B 的 isRunning / error;A 的气泡在 A 的分片里标失败', async () => {
    useAgentChatStore.setState({
      threadId: 'A',
      threadSlices: {
        B: { messages: [textMsg('b1', 'hello from B')], isRunning: true, tokenUsage: undefined, error: undefined },
      },
    })
    const gate = deferSend()

    const sending = state().send()
    await Promise.resolve()
    void state().switchThread('B')
    expect(state().isRunning).toBe(true) // B 自己还在跑
    gate.reject(new Error('gateway exploded'))
    await sending

    expect(state().threadId).toBe('B')
    expect(state().isRunning).toBe(true)
    expect(state().error).toBeUndefined()
    expect(state().messages.map((m) => m.id)).toEqual(['b1'])

    const aMsgs = state().threadSlices.A?.messages ?? []
    expect(aMsgs[0]?.sendState).toBe('failed')
    expect(state().threadSlices.A?.isRunning).toBe(false)
    expect(state().threadSlices.A?.error).toBe('gateway exploded')
    // 已有对话的失败气泡保留快照,用户回到 A 后能点「重试」。
    expect(Object.keys(state().failedSendSnapshots)).toEqual([aMsgs[0].id])
    expect(state().runningByThread.A).toBeUndefined()
  })
})

// 单靠「当前没有 threadId 且在跑」认领 thread_created 是启发式:第一个新对话还没拿到 id 时
// 用户点了「新对话」又发了第二个,第一个的 thread_created 会被第二个认领。
// 主进程现在把发起该 send 的 clientMessageId 盖在 thread_created 上,渲染端按 id 认领。
describe('新对话按 clientMessageId 认领自己的 thread_created', () => {
  const sentIds = (): string[] =>
    sendMessage.mock.calls.map((c) => (c[0] as { clientMessageId?: string }).clientMessageId ?? '')

  it('send() 把乐观气泡的 id 作为 clientMessageId 发给主进程', async () => {
    const gate = gateNextSend()

    const sending = state().send()
    await Promise.resolve()
    const bubble = state().messages[state().messages.length - 1]
    expect(bubble.role).toBe('user')
    expect(sentIds()).toEqual([bubble.id])

    gate.resolve({ threadId: 'X' })
    await sending
  })

  it('两个新对话先后在途:第一个的 thread_created 不会被第二个认领,各归各的', async () => {
    const gate1 = gateNextSend()
    const gate2 = gateNextSend()

    const sending1 = state().send()
    await Promise.resolve()
    state().newThread() // 第一个还没拿到 id,用户开了第二个新对话
    useAgentChatStore.setState({ input: 'second chat' })
    const sending2 = state().send()
    await Promise.resolve()
    const [id1, id2] = sentIds()
    expect(id1).not.toBe(id2)

    // 第一个新对话的 thread_created 先到:当前视图是第二个,不能认领。
    state().applyEvent({ type: 'thread_created', threadId: 'X1', clientMessageId: id1 } as never)
    expect(state().threadId).toBeUndefined()
    expect(state().messages.map((m) => m.id)).toEqual([id2])

    // 第二个自己的 thread_created 才认领。
    state().applyEvent({ type: 'thread_created', threadId: 'X2', clientMessageId: id2 } as never)
    expect(state().threadId).toBe('X2')

    gate1.resolve({ threadId: 'X1' })
    gate2.resolve({ threadId: 'X2' })
    await Promise.all([sending1, sending2])

    // 第二个仍是活动对话,列表里只有它自己的气泡;第一个的气泡补进了 X1 自己的分片。
    expect(state().threadId).toBe('X2')
    expect(state().messages.map((m) => m.id)).toEqual([id2])
    expect(state().threadSlices.X1?.messages.map((m) => m.id)).toEqual([id1])
    expect(state().runningByThread.X1).toBe(true)
    expect(state().runningByThread.X2).toBe(true)
  })

  it('带 id 且气泡就在当前视图里 → 认领;没带 id(旧调用方)→ 沿用「在跑就认领」', async () => {
    const gate = gateNextSend()
    const sending = state().send()
    await Promise.resolve()
    const [id] = sentIds()
    state().applyEvent({ type: 'thread_created', threadId: 'X', clientMessageId: id } as never)
    expect(state().threadId).toBe('X')
    gate.resolve({ threadId: 'X' })
    await sending

    // 旧规则:没有 clientMessageId,视图在跑、没有 threadId。
    useAgentChatStore.setState({ threadId: undefined, messages: [], isRunning: true })
    state().applyEvent({ type: 'thread_created', threadId: 'LEGACY' } as never)
    expect(state().threadId).toBe('LEGACY')
  })

  it('带 id 但气泡不在当前视图里 → 即使视图在跑也不认领', () => {
    useAgentChatStore.setState({ threadId: undefined, messages: [textMsg('mine', 'x')], isRunning: true })
    state().applyEvent({ type: 'thread_created', threadId: 'OTHERS', clientMessageId: 'not-mine' } as never)
    expect(state().threadId).toBeUndefined()
  })
})
