// 「允许 AI 自动生成」总闸。
//
// 背景:agent 经 MCP 能自己按下生成(video_workbench_start,以及
// video_workbench_add_tasks 带 autoStart),而生成是要花钱的。用户要一个能在
// 工作台上看见、也能一键关掉的闸门 —— 关掉之后 agent 照样能填卡、排版、改规格,
// 但**不准替用户点生成**。
//
// 闸门做在 store 而不是各个工具分支里:MCP 有两条自动启动入口,散在调用点上
// 迟早会漏掉第三条。用户自己点的 startCards 永远不过这道闸。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_AUTO_START_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'

function mockSubmit() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task-1' }))
  ;(window as any).electronAPI = { videoWorkbench: { submit } }
  return submit
}

beforeEach(() => {
  try {
    globalThis.localStorage?.removeItem(AGENT_AUTO_START_KEY)
  } catch {
    /* localStorage 不可用时用内存默认值 */
  }
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

describe('agentAutoStart 总闸', () => {
  it('默认开:不改任何设置时 agent 仍能启动(不改变现有行为)', async () => {
    const submit = mockSubmit()
    expect(useVideoWorkbenchStore.getState().agentAutoStart).toBe(true)
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    const res = await useVideoWorkbenchStore.getState().startCardsFromAgent(ids)
    expect(res.started).toEqual(ids)
    expect(res.blocked).toBeUndefined()
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('关掉后 agent 的启动一次提交都不发,并说明为什么', async () => {
    const submit = mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }, { prompt: '狗' }])

    const res = await useVideoWorkbenchStore.getState().startCardsFromAgent(ids)

    expect(submit).not.toHaveBeenCalled()
    expect(res.started).toEqual([])
    expect(res.blocked).toBe(true)
    expect(res.hint).toContain('全部生成')
    // 逐张给出原因,agent 才能照原样转述给用户
    expect(res.skipped.map((s) => s.cardId).sort()).toEqual([...ids].sort())
  })

  it('关掉后卡片状态不动 —— 不留下假的 preparing', async () => {
    mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCardsFromAgent(ids)
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('draft')
  })

  it('关掉后用户自己点生成照样能跑 —— 闸门只拦 agent', async () => {
    const submit = mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])

    const res = await useVideoWorkbenchStore.getState().startCards(ids)

    expect(res.started).toEqual(ids)
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('不带 ids 的 agent 启动被拦下时也标 blocked', async () => {
    const submit = mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    const res = await useVideoWorkbenchStore.getState().startCardsFromAgent()
    expect(res.blocked).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('开关落 localStorage,重建 store 后仍是关的', () => {
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    expect(globalThis.localStorage?.getItem(AGENT_AUTO_START_KEY)).toBe('0')
    resetWorkbenchStoreForTest()
    expect(useVideoWorkbenchStore.getState().agentAutoStart).toBe(false)
  })

  it('重新打开后 agent 又能启动', async () => {
    const submit = mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    useVideoWorkbenchStore.getState().setAgentAutoStart(true)
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])
    const res = await useVideoWorkbenchStore.getState().startCardsFromAgent(ids)
    expect(res.started).toEqual(ids)
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
