// MCP 侧必须尊重「允许 AI 自动生成」总闸。
//
// 自动启动有**两条**入口:video_workbench_start,以及 video_workbench_add_tasks
// 带 autoStart:true。两条都要被同一道闸拦住 —— 只堵一条等于没堵,而这道闸管的是
// 用户的钱。填卡本身不受影响:关掉闸门后 agent 照样能把卡片排好,只是最后那一下
// 留给用户。

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useTabStore } from '../../../stores/useTabStore'
import { resetAssetPreviewCacheForTest } from '../../video-workbench/assetPreview'
import {
  AGENT_AUTO_START_KEY,
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../video-workbench/store'
import { resetWorkbenchDbForTest } from '../../video-workbench/WorkbenchDb'

function callTool(toolName: string, params: Record<string, unknown>): Promise<any> {
  return (
    new AgentToolExecutor() as unknown as {
      callVideoWorkbench: (n: string, p: Record<string, unknown>) => Promise<any>
    }
  ).callVideoWorkbench(toolName, params)
}

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
  resetAssetPreviewCacheForTest()
  useTabStore.setState({ activeTab: 'generate', previousTab: null })
})

afterEach(() => {
  delete (window as any).electronAPI
})

describe('总闸关闭时 MCP 不得自动生成', () => {
  it('video_workbench_start 被拦下,一次提交都不发', async () => {
    const submit = mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])

    const res = await callTool('video_workbench_start', { cardIds: ids })

    expect(submit).not.toHaveBeenCalled()
    expect(res.blocked).toBe(true)
    expect(res.started).toEqual([])
  })

  it('add_tasks 的 autoStart 同样被拦下,但卡片照样填好', async () => {
    const submit = mockSubmit()
    useVideoWorkbenchStore.getState().setAgentAutoStart(false)

    const res = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '赛博猫' }],
      autoStart: true,
      navigate: false,
    })

    expect(submit).not.toHaveBeenCalled()
    expect(res.cardIds).toHaveLength(1)
    expect(useVideoWorkbenchStore.getState().cards[0].prompt).toBe('赛博猫')
    expect(res.start.blocked).toBe(true)
  })

  it('开着时两条路都照旧能启动(不改变默认行为)', async () => {
    const submit = mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '猫' }])

    const started = await callTool('video_workbench_start', { cardIds: ids })
    expect(started.started).toEqual(ids)

    const added = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '狗' }],
      autoStart: true,
      navigate: false,
    })
    expect(added.start.started).toHaveLength(1)
    expect(submit).toHaveBeenCalledTimes(2)
  })
})
