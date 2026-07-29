import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useTabStore } from '../../../stores/useTabStore'
import { resetAssetPreviewCacheForTest } from '../../video-workbench/assetPreview'
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
  resetAssetPreviewCacheForTest()
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

  it('add_tasks 带 afterCardId:插到锚点之后而不是末尾', async () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])

    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'M' }],
      afterCardId: a,
      navigate: false,
    })

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['A', 'M', 'B'])
  })

  it('add_tasks 锚点不存在:回错且一张卡都不加', async () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])

    await expect(
      callTool('video_workbench_add_tasks', {
        tasks: [{ prompt: 'M' }],
        afterCardId: '不存在',
        navigate: false,
      }),
    ).rejects.toThrow(/anchor card not found/)

    expect(useVideoWorkbenchStore.getState().cards).toHaveLength(1)
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

  it('add_tasks:asset:// 引用带上人像库 previewUrl(缩略图直接有图),跨任务只查一次 list', async () => {
    const listAssets = vi.fn(async () => ({
      items: [
        { id: 'a1', kind: 'image', name: '主角立绘', assetId: 'a1', assetUrl: 'asset://a1', previewUrl: 'https://cdn/a1.jpg' },
        { id: 'a2', kind: 'audio', name: '配乐', assetId: 'a2', assetUrl: 'asset://a2', previewUrl: 'https://cdn/a2.jpg' },
      ],
      total: 2,
      page: 1,
      pageSize: 50,
      totalPages: 1,
    }))
    ;(window as any).electronAPI = { seedance: { listAssets } }
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [
        { prompt: '第一镜', referenceImages: ['asset://a1', 'D:\\local.png'] },
        { prompt: '第二镜', referenceImages: ['asset://a1'], referenceAudios: ['asset://a2'] },
      ],
      navigate: false,
    })
    expect(listAssets).toHaveBeenCalledTimes(1)
    const cards = useVideoWorkbenchStore.getState().cards
    const first = cards.find((c) => c.id === cardIds[0])!
    expect(first.referenceImages[0]).toEqual({
      name: '主角立绘',
      src: 'asset://a1',
      previewUrl: 'https://cdn/a1.jpg',
    })
    // 非 asset:// 源不受影响
    expect(first.referenceImages[1]).toMatchObject({ name: 'local.png', src: 'D:\\local.png' })
    const second = cards.find((c) => c.id === cardIds[1])!
    expect(second.referenceImages[0].previewUrl).toBe('https://cdn/a1.jpg')
    expect(second.referenceAudios[0]).toEqual({
      name: '配乐',
      src: 'asset://a2',
      previewUrl: 'https://cdn/a2.jpg',
    })
  })

  it('add_tasks:人像库不可用时 asset:// 保持原样(文件名占位,不阻断写卡)', async () => {
    const listAssets = vi.fn(async () => {
      throw new Error('no secret')
    })
    ;(window as any).electronAPI = { seedance: { listAssets } }
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '镜头', referenceImages: ['asset://ghost'] }],
      navigate: false,
    })
    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === cardIds[0])!
    expect(card.referenceImages[0]).toMatchObject({ src: 'asset://ghost' })
    expect(card.referenceImages[0].previewUrl).toBeUndefined()
  })

  it('update_task:补挂 asset:// 素材同样带 previewUrl', async () => {
    const listAssets = vi.fn(async () => ({
      items: [
        { id: 'a9', kind: 'image', name: '场景图', assetId: 'a9', assetUrl: 'asset://a9', previewUrl: 'https://cdn/a9.jpg' },
      ],
      total: 1,
      page: 1,
      pageSize: 50,
      totalPages: 1,
    }))
    ;(window as any).electronAPI = { seedance: { listAssets } }
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '待补素材' }],
      navigate: false,
    })
    await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      referenceImages: ['asset://a9'],
    })
    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === cardIds[0])!
    expect(card.referenceImages[0]).toEqual({
      name: '场景图',
      src: 'asset://a9',
      previewUrl: 'https://cdn/a9.jpg',
    })
  })

  it('status:返回 boards/activeBoardId,卡片带 boardId,可按 boardId 过滤', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第一页的卡' }],
      navigate: false,
    })
    const firstBoardId = useVideoWorkbenchStore.getState().activeBoardId
    const secondBoardId = useVideoWorkbenchStore.getState().addBoard('分镜页')
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第二页的卡' }], navigate: false })

    const all = await callTool('video_workbench_status', {})
    expect(all.total).toBe(2)
    expect(all.activeBoardId).toBe(secondBoardId)
    expect(all.boards).toEqual([
      { id: firstBoardId, name: expect.any(String), cardCount: 1 },
      { id: secondBoardId, name: '分镜页', cardCount: 1 },
    ])
    expect(all.cards.map((c: any) => c.boardId).sort()).toEqual([firstBoardId, secondBoardId].sort())
    // 卡片快照带紧凑素材清单字段
    expect(all.cards[0].references).toEqual({ images: [], videos: [], audios: [] })

    const filtered = await callTool('video_workbench_status', { boardId: firstBoardId })
    expect(filtered.total).toBe(1)
    expect(filtered.cards[0].cardId).toBe(cardIds[0])
  })

  it('status:boardId 不存在时抛可读错误(agent 可据 boards 自纠)', async () => {
    await expect(callTool('video_workbench_status', { boardId: 'ghost-board' })).rejects.toThrow(
      'board not found',
    )
  })

  it('写操作统一回带 workbench 全局摘要(boards + statusCounts + 选中态)', async () => {
    const added = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第一张' }, { prompt: '第二张' }],
      navigate: false,
    })
    const activeBoardId = useVideoWorkbenchStore.getState().activeBoardId
    expect(added.workbench).toEqual({
      activeBoardId,
      boards: [{ id: activeBoardId, name: expect.any(String), cardCount: 2 }],
      statusCounts: { draft: 2, preparing: 0, queued: 0, running: 0, succeeded: 0, failed: 0 },
      selectedCardIds: [],
    })

    // agent 建卡不该顺手改用户的选区;用户选了以后,下一次工具调用就该看见。
    // status 是读工具,不带 workbench 包装,选中态平铺在顶层。
    useVideoWorkbenchStore.getState().selectCard(added.cardIds[1])
    const afterSelect = await callTool('video_workbench_status', {})
    expect(afterSelect.selectedCardIds).toEqual([added.cardIds[1]])

    const updated = await callTool('video_workbench_update_task', {
      cardId: added.cardIds[0],
      prompt: '改写',
    })
    expect(updated.workbench.statusCounts.draft).toBe(2)

    const submit = vi.fn(async () => ({ success: true, taskId: 't-1' }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }
    const started = await callTool('video_workbench_start', { cardIds: [added.cardIds[0]] })
    expect(started.started).toEqual([added.cardIds[0]])
    const busy =
      started.workbench.statusCounts.preparing +
      started.workbench.statusCounts.queued +
      started.workbench.statusCounts.running
    expect(busy).toBe(1)

    const removed = await callTool('video_workbench_remove_tasks', { cardIds: [added.cardIds[1]] })
    expect(removed.workbench.boards[0].cardCount).toBe(1)
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
