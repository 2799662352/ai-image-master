// 工作台生成结果写「历史记录」单测:persistence=done 时经 HistoryDataService
// 写一条 codex-video;同任务多次 done 广播 / 重载后再广播都不重复入库。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import { resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'

function makeUpdate(patch: Partial<SeedanceTaskUpdate>): SeedanceTaskUpdate {
  return {
    taskId: 'task-1',
    prompt: '一只赛博猫在雨夜奔跑',
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    status: 'succeeded',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    persistence: 'done',
    source: 'workbench',
    ...patch,
  }
}

function mockHistoryService() {
  const addToHistory = vi.fn().mockResolvedValue({ id: 42 })
  ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, {
    init: vi.fn().mockResolvedValue(undefined),
    addToHistory,
  })
  return addToHistory
}

async function submitOneCard(prompt = '一只赛博猫在雨夜奔跑'): Promise<string> {
  ;(window as any).electronAPI = {
    videoWorkbench: { submit: vi.fn(async () => ({ success: true, taskId: 'task-1' })) },
  }
  useVideoWorkbenchStore.getState().addCards([{ prompt }])
  await useVideoWorkbenchStore.getState().startCards()
  return useVideoWorkbenchStore.getState().cards[0].clientId!
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  ServiceRegistry.clear()
  delete (window as any).electronAPI
})

describe('生成完成写历史记录', () => {
  it('succeeded + persistence=done → addToHistory 一条 codex-video,优先 COS 永久 URL', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({
        clientId,
        localPath: 'C:\\videos\\v.mp4',
        remoteUrl: 'https://cos.example/v.mp4',
      }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))
    expect(addToHistory).toHaveBeenCalledWith(
      'codex-video',
      '一只赛博猫在雨夜奔跑',
      ['https://cos.example/v.mp4'],
      '16:9',
      expect.stringContaining('seedance-2.0'),
    )
    // 卡片上落防重标记(持久化,重载可见)
    expect(useVideoWorkbenchStore.getState().cards[0].historyRecorded).toBe(true)
  })

  it('无 COS URL 时退回本地 file:// 路径', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, localPath: 'C:\\videos\\v.mp4' }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))
    expect(addToHistory.mock.calls[0][2]).toEqual(['file:///C:/videos/v.mp4'])
  })

  it('同任务重复 done 广播(remoteUrl 迟到重发)只写一条', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, localPath: 'C:\\videos\\v.mp4', remoteUrl: 'https://cos.example/v.mp4' }),
    )
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, localPath: 'C:\\videos\\v.mp4', remoteUrl: 'https://cos.example/v.mp4' }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(addToHistory).toHaveBeenCalledTimes(1)
  })

  it('重载后(卡片带 historyRecorded)再收 done 广播不重复入库', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, remoteUrl: 'https://cos.example/v.mp4' }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))

    // 模拟重载:store 重置但内存 db 保留(historyRecorded 已持久化)
    resetWorkbenchStoreForTest()
    await useVideoWorkbenchStore.getState().ensureHydrated()
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, remoteUrl: 'https://cos.example/v.mp4' }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(addToHistory).toHaveBeenCalledTimes(1)
  })

  it('persistence 未到 done(仍 running)不写历史;失败任务不写历史', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'running', videoUrl: 'https://tmp/v.mp4' }),
    )
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, status: 'failed', persistence: 'idle', error: 'boom' }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(addToHistory).not.toHaveBeenCalled()
  })

  it('HistoryDataService 未注册时静默跳过,不抛错不阻断卡片状态', async () => {
    const clientId = await submitOneCard()
    expect(() =>
      useVideoWorkbenchStore.getState().applyTaskUpdate(
        makeUpdate({ clientId, remoteUrl: 'https://cos.example/v.mp4' }),
      ),
    ).not.toThrow()
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('succeeded')
  })
})

describe('重新生成同一张卡', () => {
  it('重启时清掉上一轮结果与防重标记,第二轮结果照样入历史', async () => {
    const addToHistory = mockHistoryService()
    const firstClientId = await submitOneCard()
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({
        clientId: firstClientId,
        localPath: 'C:\\videos\\v1.mp4',
        remoteUrl: 'https://cos.example/v1.mp4',
        actualSeed: 111,
        completionTokens: 900,
      }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))

    const cardId = useVideoWorkbenchStore.getState().cards[0].id
    await useVideoWorkbenchStore.getState().startCards([cardId])

    // 上一轮的结果不能残留 —— 否则播放器会继续显示旧视频,
    // 且 historyRecorded 会把第二轮结果永久挡在历史页之外。
    const restarted = useVideoWorkbenchStore.getState().cards[0]
    expect(restarted.historyRecorded).toBeFalsy()
    expect(restarted.localPath).toBeUndefined()
    expect(restarted.remoteUrl).toBeUndefined()
    expect(restarted.actualSeed).toBeUndefined()
    expect(restarted.completionTokens).toBeUndefined()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({
        clientId: restarted.clientId!,
        localPath: 'C:\\videos\\v2.mp4',
        remoteUrl: 'https://cos.example/v2.mp4',
      }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(2))
    expect(addToHistory.mock.calls[1][2]).toEqual(['https://cos.example/v2.mp4'])
  })
})
