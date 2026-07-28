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

/** 带「事后升级地址」能力的历史服务。 */
function mockHistoryServiceWithReplace() {
  const addToHistory = vi.fn().mockResolvedValue({ id: 42 })
  const replaceUrls = vi.fn().mockResolvedValue(true)
  ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, {
    init: vi.fn().mockResolvedValue(undefined),
    addToHistory,
    replaceUrls,
  })
  return { addToHistory, replaceUrls }
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

  it('生成失败的任务不写历史', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, status: 'failed', persistence: 'idle', error: 'boom' }),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(addToHistory).not.toHaveBeenCalled()
  })

  /**
   * 入库不等落盘结论。
   *
   * 落盘要先下载 mp4(两次尝试各 120s)再转存 COS(默认 10 分钟超时),最坏情况
   * 卡片会在「正在后台保存…」停十几分钟。此前的写入门要求落盘有结论,于是这段
   * 时间里历史一条都没有 —— 用户这时关掉应用,这次生成就只剩一张工作台卡片,
   * 而卡片上那条上游地址同样会过期。
   *
   * 改成 succeeded 即写、拿到更持久的地址再原地升级:既不丢账,也不会让历史
   * 长期停在会过期的临时地址上。
   */
  it('succeeded 但落盘仍在进行 → 立刻用上游地址写一条,不干等', async () => {
    const { addToHistory } = mockHistoryServiceWithReplace()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'running', videoUrl: 'https://ark-tmp/v.mp4' }),
    )

    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))
    expect(addToHistory.mock.calls[0][2]).toEqual(['https://ark-tmp/v.mp4'])
  })

  it('落盘随后成功 → 把同一条历史的地址换成 COS,不新增第二条', async () => {
    const { addToHistory, replaceUrls } = mockHistoryServiceWithReplace()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'running', videoUrl: 'https://ark-tmp/v.mp4' }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({
        clientId,
        persistence: 'done',
        videoUrl: 'https://ark-tmp/v.mp4',
        localPath: 'C:\\videos\\v.mp4',
        remoteUrl: 'https://cos.example/v.mp4',
      }),
    )

    await vi.waitFor(() => expect(replaceUrls).toHaveBeenCalledTimes(1))
    expect(replaceUrls).toHaveBeenCalledWith(42, ['https://cos.example/v.mp4'])
    expect(addToHistory).toHaveBeenCalledTimes(1)
  })

  it('落盘失败(没有更持久的地址)→ 不做无谓升级', async () => {
    const { addToHistory, replaceUrls } = mockHistoryServiceWithReplace()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'running', videoUrl: 'https://ark-tmp/v.mp4' }),
    )
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'failed', videoUrl: 'https://ark-tmp/v.mp4' }),
    )

    await new Promise((r) => setTimeout(r, 10))
    expect(replaceUrls).not.toHaveBeenCalled()
    expect(addToHistory).toHaveBeenCalledTimes(1)
  })

  /**
   * 落盘只是兜底,不是入库的前提。
   *
   * persistVideo 会先把 mp4 落本地再转存 COS;网络一抖,这一步整个失败
   * (persistence='failed'),而视频本身**已经生成成功**,上游那条临时地址此刻
   * 还能播。此前的写入门要求 persistence==='done',于是这种情况一条历史都不写,
   * 等上游地址过期(通常一天),这次生成就彻底找不回了 —— 用户付了钱、看过片,
   * 最后什么都没剩下。图片侧的兜底顺序是 COS → 本地 → 模型直出 URL,视频这里
   * 缺的就是最后一层。
   */
  it('生成成功但落盘失败 → 仍写历史,退到上游地址', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'failed', videoUrl: 'https://ark-tmp/v.mp4' }),
    )

    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))
    expect(addToHistory.mock.calls[0][2]).toEqual(['https://ark-tmp/v.mp4'])
    expect(useVideoWorkbenchStore.getState().cards[0].historyRecorded).toBe(true)
  })

  it('落盘失败且上游也没给地址 → 无从记录,不写', async () => {
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, persistence: 'failed' }),
    )

    await new Promise((r) => setTimeout(r, 10))
    expect(addToHistory).not.toHaveBeenCalled()
  })

  it('落盘成功时仍优先持久地址,不会退回临时地址', async () => {
    // 兜底不能反过来抢在前面:临时地址会过期,COS 不会。
    const addToHistory = mockHistoryService()
    const clientId = await submitOneCard()

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({
        clientId,
        videoUrl: 'https://ark-tmp/v.mp4',
        localPath: 'C:\\videos\\v.mp4',
        remoteUrl: 'https://cos.example/v.mp4',
      }),
    )

    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))
    expect(addToHistory.mock.calls[0][2]).toEqual(['https://cos.example/v.mp4'])
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
