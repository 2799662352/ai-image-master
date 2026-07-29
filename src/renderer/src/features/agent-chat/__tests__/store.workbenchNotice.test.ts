// @vitest-environment jsdom
//
// 视频工作台「批次跑完」的投递双通道:
//   turn 在跑 → steer 插进当前 turn(模型当场知道);
//   turn 闲着 → 入队,随该线程下一条用户消息以隐藏前缀送达。
// 两条路都不自动开 turn —— 不能因为一批视频跑完就替用户花 token。
// 这是取代「让模型轮询 video_workbench_status」的机制:轮询会把 turn 长期占在
// 工具调用里,用户就插不进话了(video_workbench_start 卡住的根因)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'

const sendMessage = vi.fn()
const steer = vi.fn()

const NOTICE = '[视频工作台] 批次渲染完成：2 张成功（共 2 张）。'

beforeEach(() => {
  sendMessage.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  steer.mockReset().mockResolvedValue({ threadId: 'thread-1' })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    agent: {
      sendMessage,
      steer,
      listThreads: vi.fn().mockResolvedValue([]),
      onEvent: () => () => undefined,
    },
  }
  useAgentChatStore.setState({
    threadId: 'thread-1',
    messages: [],
    isRunning: false,
    input: '刚才那批怎么样',
    attachments: [],
    pendingReferences: [],
    pendingCanvasContext: null,
    pendingWorkbenchNoticesByThread: {},
    availableSkills: [],
    selectedModelId: 'gpt-5.5',
    threadSlices: {},
    runningByThread: {},
    threadList: [],
    chatScrollByThread: {},
  })
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('工作台批次完成通知', () => {
  it('线程闲着:入队等下一句,绝不自动开 turn', () => {
    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE, 'thread-1')

    expect(sendMessage).not.toHaveBeenCalled()
    expect(steer).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread['thread-1']).toEqual([NOTICE])
  })

  it('随下一条消息作为隐藏前缀送达,之后出队;可见气泡保持干净', async () => {
    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE, 'thread-1')
    await useAgentChatStore.getState().send()

    const payload = sendMessage.mock.calls[0][0] as { content: string }
    expect(payload.content.startsWith('[视频工作台]')).toBe(true)
    expect(payload.content).toContain('刚才那批怎么样')

    // 用户看到的仍然只是他自己那句话。
    const userMsg = useAgentChatStore.getState().messages.find((m) => m.role === 'user')
    const text = userMsg?.items.find((i) => i.type === 'text') as { content?: string } | undefined
    expect(text?.content).toBe('刚才那批怎么样')

    // 出队,不会随下一条消息再送一遍。
    expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread['thread-1']).toEqual([])
  })

  it('线程正在跑:steer 插进当前 turn,不入队,也不动用户正在打的草稿', () => {
    useAgentChatStore.setState({ runningByThread: { 'thread-1': true }, isRunning: true })

    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE, 'thread-1')

    expect(steer).toHaveBeenCalledTimes(1)
    expect(steer.mock.calls[0][0]).toMatchObject({ threadId: 'thread-1', content: NOTICE })
    expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread['thread-1']).toBeUndefined()
    // 草稿原样留着 —— 系统通知不该伪造成用户发言,也不该吃掉他的输入。
    expect(useAgentChatStore.getState().input).toBe('刚才那批怎么样')
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })

  it('steer 竞态失败(turn 刚好结束)→ 退回队列,等下一条消息带走', async () => {
    useAgentChatStore.setState({ runningByThread: { 'thread-1': true }, isRunning: true })
    steer.mockRejectedValueOnce(new Error('no active turn'))

    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE, 'thread-1')

    await vi.waitFor(() =>
      expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread['thread-1']).toEqual([NOTICE]),
    )
  })

  it('发送失败:通知退回队首,不因为一次 IPC 失败就丢掉', async () => {
    sendMessage.mockRejectedValueOnce(new Error('IPC down'))
    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE, 'thread-1')

    await useAgentChatStore.getState().send()

    expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread['thread-1']).toEqual([NOTICE])
  })

  it('按线程分桶:别的线程的通知不会搭上这个线程的车', async () => {
    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE, 'thread-other')
    await useAgentChatStore.getState().send()

    const payload = sendMessage.mock.calls[0][0] as { content: string }
    expect(payload.content).toBe('刚才那批怎么样')
    expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread['thread-other']).toEqual([NOTICE])
  })

  it('从未开过聊天(无线程可归属)→ 丢掉,不炸', () => {
    useAgentChatStore.setState({ threadId: undefined })
    useAgentChatStore.getState().notifyWorkbenchBatchDone(NOTICE)

    expect(steer).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().pendingWorkbenchNoticesByThread).toEqual({})
  })
})
