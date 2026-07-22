import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useTabStore } from '../../../stores/useTabStore'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../video-workbench/store'
import { resetWorkbenchDbForTest } from '../../video-workbench/WorkbenchDb'

/**
 * codex MCP `video_workbench_*` 的渲染层处理:AI 与用户操作同一个
 * useVideoWorkbenchStore —— 这里验证「工具调用 → store 变更 → 页面可见」
 * 的人机协同契约,以及回给 main(videoWorkbenchTools banner)的结构体。
 */

function callTool(toolName: string, params: Record<string, unknown>): Promise<any> {
  return (
    new AgentToolExecutor() as unknown as {
      callVideoWorkbench: (n: string, p: Record<string, unknown>) => Promise<any>
    }
  ).callVideoWorkbench(toolName, params)
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  useTabStore.setState({ activeTab: 'generate', previousTab: null })
})

afterEach(() => {
  delete (window as any).electronAPI
})

describe('AgentToolExecutor.video_workbench_*', () => {
  it('add_tasks:批量填卡进 store(页面同源可见)并默认切到工作台 tab', async () => {
    const result = await callTool('video_workbench_add_tasks', {
      tasks: [
        { prompt: '赛博朋克雨夜街景', model: '2.0-fast', duration: 8 },
        { prompt: '机械猫慢镜头', resolution: '1080p' },
      ],
    })
    expect(result.cardIds).toHaveLength(2)
    expect(result.total).toBe(2)
    const cards = useVideoWorkbenchStore.getState().cards
    expect(cards[0]).toMatchObject({ prompt: '赛博朋克雨夜街景', model: '2.0-fast', duration: 8 })
    expect(cards[1]).toMatchObject({ prompt: '机械猫慢镜头', resolution: '1080p' })
    expect(useTabStore.getState().activeTab).toBe('videoWorkbench')
  })

  it('add_tasks navigate:false 不切 tab;autoStart 触发提交', async () => {
    const submit = vi.fn(async () => ({ success: true, taskId: 't-1' }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }
    const result = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '猫' }],
      navigate: false,
      autoStart: true,
    })
    expect(useTabStore.getState().activeTab).toBe('generate')
    expect(submit).toHaveBeenCalledTimes(1)
    expect(result.start.started).toHaveLength(1)
  })

  it('update_task 改写卡片并返回快照;status 返回全量/过滤快照', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '旧' }, { prompt: '另一张' }],
      navigate: false,
    })
    const updated = await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      prompt: '新提示词',
      ratio: '9:16',
    })
    expect(updated.card).toMatchObject({ cardId: cardIds[0], prompt: '新提示词', ratio: '9:16' })

    const all = await callTool('video_workbench_status', {})
    expect(all.total).toBe(2)
    const filtered = await callTool('video_workbench_status', { cardIds: [cardIds[1]] })
    expect(filtered.total).toBe(1)
    expect(filtered.cards[0].cardId).toBe(cardIds[1])
  })

  it('remove_tasks 删卡并返回剩余数;未知工具抛错', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'a' }, { prompt: 'b' }],
      navigate: false,
    })
    const removed = await callTool('video_workbench_remove_tasks', { cardIds: [cardIds[0]] })
    expect(removed).toMatchObject({ removed: [cardIds[0]], total: 1 })
    await expect(callTool('video_workbench_nope', {})).rejects.toThrow('Unknown video workbench tool')
  })
})
