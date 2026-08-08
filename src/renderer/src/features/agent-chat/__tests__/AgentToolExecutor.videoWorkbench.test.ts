import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useTabStore } from '../../../stores/useTabStore'
import { resetAssetPreviewCacheForTest } from '../../video-workbench/assetPreview'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
} from '../../video-workbench/store'
import { resetWorkbenchDbForTest } from '../../video-workbench/WorkbenchDb'
import {
  WORKBENCH_STATUS_MAX_PAGE_SIZE,
  WORKBENCH_STATUS_PAGE_SIZE,
} from '../../../../../types/videoWorkbench'

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

    // 默认只看**当前页**：用户就在这一页上，其余页只给 id/name/cardCount 让它知道
    // 还有什么，不倒卡片。
    const scoped = await callTool('video_workbench_status', {})
    expect(scoped.scope).toEqual({ boardId: secondBoardId })
    expect(scoped.total).toBe(1)
    expect(scoped.cards.map((c: any) => c.boardId)).toEqual([secondBoardId])
    expect(scoped.activeBoardId).toBe(secondBoardId)
    // boards 始终是全量目录：能看见别页存在、有几张，但不为此付出卡片的代价。
    expect(scoped.boards).toEqual([
      { id: firstBoardId, name: expect.any(String), cardCount: 1 },
      { id: secondBoardId, name: '分镜页', cardCount: 1 },
    ])
    // 卡片快照带紧凑素材清单字段
    expect(scoped.cards[0].references).toEqual({ images: [], videos: [], audios: [] })

    // 真要跨页时明说。
    const all = await callTool('video_workbench_status', { allBoards: true })
    expect(all.scope).toEqual({ allBoards: true })
    expect(all.total).toBe(2)
    expect(all.cards.map((c: any) => c.boardId).sort()).toEqual([firstBoardId, secondBoardId].sort())

    const filtered = await callTool('video_workbench_status', { boardId: firstBoardId })
    expect(filtered.total).toBe(1)
    expect(filtered.cards[0].cardId).toBe(cardIds[0])
  })

  /**
   * 页面摘要是渐进披露缺的那一层索引：status 只回当前页的卡，别页只剩 id/name/cardCount，
   * 而页名常常只是「页面 3」——光凭「20 张卡」判断不了要不要翻过去。
   */
  it('页面摘要:写完出现在 boards 里,别页不用拉卡片就能判断该不该翻', async () => {
    const first = useVideoWorkbenchStore.getState().activeBoardId
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '追车 1' }], navigate: false })
    const second = useVideoWorkbenchStore.getState().addBoard('页面 2')

    await callTool('video_workbench_set_board_summary', {
      boardId: first,
      summary: '追车戏 8 镜，全部夜景',
    })

    // 当前页是第二页，但第一页的摘要照样在目录里看得到 —— 不用切页、不用拉卡。
    const res = await callTool('video_workbench_status', {})
    expect(res.scope).toEqual({ boardId: second })
    expect(res.boards).toEqual([
      { id: first, name: expect.any(String), cardCount: 1, summary: '追车戏 8 镜，全部夜景' },
      { id: second, name: '页面 2', cardCount: 0 },
    ])
  })

  it('页面摘要:传空串清除,写摘要不作废 agent 手里的 IR 令牌', async () => {
    const boardId = useVideoWorkbenchStore.getState().activeBoardId
    const before = useVideoWorkbenchStore.getState().structureRevision

    await callTool('video_workbench_set_board_summary', { boardId, summary: '夜景外景' })
    // 摘要是路标不是编排意图：动了它就等于让 agent 手里那份 IR 白白作废。
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(before)

    await callTool('video_workbench_set_board_summary', { boardId, summary: '' })
    expect(useVideoWorkbenchStore.getState().boards[0].summary).toBeUndefined()
  })

  it('页面摘要:页不存在时抛可读错误并列出可用 id', async () => {
    await expect(
      callTool('video_workbench_set_board_summary', { boardId: 'ghost', summary: 'x' }),
    ).rejects.toThrow('board not found')
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

// 渐进式披露 —— codex 把每次工具输出静默截到 10K token,整份倒出去会丢数据。
describe('status 分页', () => {
  /** 铺 n 张卡(绕过 MCP 层的每次 5 张上限,这里测的是读的一侧)。 */
  function seed(n: number): string[] {
    return useVideoWorkbenchStore
      .getState()
      .addCards(Array.from({ length: n }, (_, i) => ({ prompt: `镜 ${i + 1}` })))
  }

  it('默认每页 12 张,total 报的是筛选后的全部而不是本页数量', async () => {
    seed(30)
    const page1 = await callTool('video_workbench_status', {})
    expect(page1.cards).toHaveLength(WORKBENCH_STATUS_PAGE_SIZE)
    // agent 必须知道自己只看到了一部分,否则会把 12 当成全部去做决定。
    expect(page1.total).toBe(30)
    expect(page1).toMatchObject({ page: 1, totalPages: 3, hasMore: true })
  })

  it('翻页拿到不重不漏的下一批,最后一页 hasMore 为 false', async () => {
    const ids = seed(30)
    const seen: string[] = []
    for (let page = 1; page <= 3; page++) {
      const res = await callTool('video_workbench_status', { page })
      seen.push(...res.cards.map((c: any) => c.cardId))
      expect(res.hasMore).toBe(page < 3)
    }
    expect(seen).toEqual(ids)
    expect(new Set(seen).size).toBe(30)
  })

  it('pageSize 可调但封顶,页码越界回落到最后一页而不是回空', async () => {
    seed(30)
    const big = await callTool('video_workbench_status', { pageSize: 999 })
    expect(big.cards).toHaveLength(Math.min(30, WORKBENCH_STATUS_MAX_PAGE_SIZE))

    // 越界回落而不是回空:agent 拿到空数组会以为卡片被删了。
    const beyond = await callTool('video_workbench_status', { page: 99, pageSize: 12 })
    expect(beyond.page).toBe(3)
    expect(beyond.cards).toHaveLength(6)
  })

  it('cardIds/boardId 过滤之后再分页 —— 先收窄比翻页省得多', async () => {
    const ids = seed(30)
    const res = await callTool('video_workbench_status', { cardIds: ids.slice(0, 3) })
    expect(res.total).toBe(3)
    expect(res.totalPages).toBe(1)
    expect(res.hasMore).toBe(false)
  })

  /**
   * 点名 cardIds 是「我就要这几张」的意思，不该再被当前页收窄 —— 否则 agent 拿着别页的
   * 卡 id 去查，会得到一个空结果，而它完全无从判断是卡没了还是被页过滤掉了。
   */
  it('点名 cardIds 时跨页取,不被当前页收窄', async () => {
    const firstPageIds = seed(2)
    useVideoWorkbenchStore.getState().addBoard('第二页')
    seed(1)

    const res = await callTool('video_workbench_status', { cardIds: firstPageIds })
    expect(res.total).toBe(2)
    expect(res.cards.map((c: any) => c.cardId).sort()).toEqual([...firstPageIds].sort())
  })
})

describe('export 默认只导当前页', () => {
  it('省略参数 = 只导当前页,不是整个工作台', async () => {
    const first = useVideoWorkbenchStore.getState().activeBoardId
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第一页' }], navigate: false })
    const second = useVideoWorkbenchStore.getState().addBoard('第二页')
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第二页' }], navigate: false })

    const ir = await callTool('video_workbench_export', {})
    expect(ir.boards).toHaveLength(1)
    expect(ir.boards[0].id).toBe(second)
    expect(ir.activeBoardId).toBe(second)
    // 令牌是整个工作台的,不是这一页的 —— 收窄范围不能连带把并发保护也削掉。
    expect(ir.structureRevision).toBe(useVideoWorkbenchStore.getState().structureRevision)
    expect(first).not.toBe(second)
  })

  it('allBoards:true 才导全部;显式 boardId 优先于它', async () => {
    const first = useVideoWorkbenchStore.getState().activeBoardId
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第一页' }], navigate: false })
    useVideoWorkbenchStore.getState().addBoard('第二页')

    const all = await callTool('video_workbench_export', { allBoards: true })
    expect(all.boards).toHaveLength(2)

    const pinned = await callTool('video_workbench_export', { boardId: first, allBoards: true })
    expect(pinned.boards).toHaveLength(1)
    expect(pinned.boards[0].id).toBe(first)
  })

  it('显式要一页却不存在才报错;隐式取当前页解析不出时退回整份', async () => {
    await expect(callTool('video_workbench_export', { boardId: 'ghost' })).rejects.toThrow('board not found')
  })
})
