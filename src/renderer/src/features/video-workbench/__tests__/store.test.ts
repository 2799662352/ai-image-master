// 工作台 store 单测:卡片状态机 / 提交编排 / 广播对齐。
// mock 哲学与音频页一致:IndexedDB 在 jsdom 缺失 → WorkbenchDb 自动内存降级;
// IPC 入口收敛在 window.electronAPI.videoWorkbench.submit,直接替换。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import {
  AUTO_IMPORT_PORTRAIT_KEY,
  buildCard,
  canStart,
  resetWorkbenchStoreForTest,
  snapshotCard,
  snapshotWorkbench,
  toMaterial,
  useVideoWorkbenchStore,
} from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'
import { specEquals } from '../cardSpec'

function mockSubmit(impl?: (payload: Record<string, unknown>) => Promise<unknown>) {
  const submit = vi.fn(
    impl ?? (async () => ({ success: true, taskId: 'task-1' })),
  )
  ;(window as any).electronAPI = { videoWorkbench: { submit } }
  return submit
}

function makeUpdate(patch: Partial<SeedanceTaskUpdate>): SeedanceTaskUpdate {
  return {
    taskId: 'task-1',
    prompt: 'p',
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    persistence: 'idle',
    source: 'workbench',
    ...patch,
  }
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

describe('addCards / buildCard 默认值', () => {
  it('空输入用 Seedance 默认规格,批量追加保持顺序', () => {
    const store = useVideoWorkbenchStore.getState()
    const ids = store.addCards([{}, { prompt: '猫', model: '2.0-fast', duration: 8 }])
    const cards = useVideoWorkbenchStore.getState().cards
    expect(ids).toHaveLength(2)
    expect(cards[0]).toMatchObject({
      status: 'draft',
      model: '2.0',
      resolution: '720p',
      ratio: '16:9',
      duration: 5,
      generateAudio: true,
      order: 0,
    })
    expect(cards[1]).toMatchObject({ prompt: '猫', model: '2.0-fast', duration: 8, order: 1 })
  })

  it('duration 越界收敛到 4–15,参考素材截断到上限', () => {
    const card = buildCard(
      {
        duration: 99,
        referenceImages: Array.from({ length: 12 }, (_, i) => `C:/img${i}.png`),
        referenceVideos: ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'],
      },
      0,
    )
    expect(card.duration).toBe(15)
    expect(card.referenceImages).toHaveLength(9)
    expect(card.referenceVideos).toHaveLength(3)
  })

  it('toMaterial 从路径/URL/asset 提取展示名', () => {
    expect(toMaterial('C:\\dir\\猫咪.png').name).toBe('猫咪.png')
    expect(toMaterial('https://cos.example.com/a/b/video.mp4?sig=1').name).toBe('video.mp4')
    expect(toMaterial('data:image/png;base64,AAA').name).toBe('(内嵌素材)')
    expect(toMaterial('asset://abcdef1234567890').src).toBe('asset://abcdef1234567890')
  })
})

describe('updateCard / removeCard / moveCard', () => {
  it('draft 卡可编辑;进行中的卡拒绝编辑', () => {
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([{ prompt: '旧' }])
    expect(store.updateCard(id, { prompt: '新', resolution: '1080p' })).toBe(true)
    expect(useVideoWorkbenchStore.getState().cards[0]).toMatchObject({ prompt: '新', resolution: '1080p' })

    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'running' as const } : c)),
    }))
    expect(useVideoWorkbenchStore.getState().updateCard(id, { prompt: '不该生效' })).toBe(false)
    expect(useVideoWorkbenchStore.getState().cards[0].prompt).toBe('新')
  })

  it('moveCard 重排并回写连续 order', () => {
    const store = useVideoWorkbenchStore.getState()
    const [a, b, c] = store.addCards([{ prompt: 'A' }, { prompt: 'B' }, { prompt: 'C' }])
    store.moveCard(c, 0)
    const cards = useVideoWorkbenchStore.getState().cards
    expect(cards.map((x) => x.id)).toEqual([c, a, b])
    expect(cards.map((x) => x.order)).toEqual([0, 1, 2])
  })

  it('moveMaterial 同类列表内换位;越界下标收敛;非法 fromIndex 不动', () => {
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([
      { referenceImages: ['C:/a.png', 'C:/b.png', 'C:/c.png'], referenceVideos: ['C:/v.mp4'] },
    ])
    store.moveMaterial(id, 'referenceImages', 0, 2)
    let card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.referenceImages.map((m) => m.name)).toEqual(['b.png', 'c.png', 'a.png'])
    // 视频列表不受影响
    expect(card.referenceVideos.map((m) => m.name)).toEqual(['v.mp4'])

    // toIndex 越界收敛到尾部
    store.moveMaterial(id, 'referenceImages', 0, 99)
    card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.referenceImages.map((m) => m.name)).toEqual(['c.png', 'a.png', 'b.png'])

    // 非法 fromIndex 原样不动
    store.moveMaterial(id, 'referenceImages', 9, 0)
    expect(useVideoWorkbenchStore.getState().cards[0].referenceImages.map((m) => m.name)).toEqual([
      'c.png',
      'a.png',
      'b.png',
    ])
  })

  it('removeCard 删除并压实 order', () => {
    const store = useVideoWorkbenchStore.getState()
    const [a, b, c] = store.addCards([{}, {}, {}])
    store.removeCard(b)
    const cards = useVideoWorkbenchStore.getState().cards
    expect(cards.map((x) => x.id)).toEqual([a, c])
    expect(cards.map((x) => x.order)).toEqual([0, 1])
  })
})

describe('startCards 提交编排', () => {
  it('并发提交全部可启动卡;空提示词草稿静默跳过;成功后落 taskId', async () => {
    const submit = mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    store.addCards([{ prompt: '猫在跳舞' }, {}])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toHaveLength(1)
    expect(result.skipped).toHaveLength(0)
    expect(submit).toHaveBeenCalledTimes(1)
    const payload = submit.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({ prompt: '猫在跳舞', model: '2.0', resolution: '720p' })
    expect(String(payload.clientId)).toMatch(/^wb-/)
    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.taskId).toBe('task-1')
    expect(card.status).toBe('queued')
  })

  it('显式指定空提示词卡时报告 skip 原因;提交失败落 failed + error', async () => {
    mockSubmit(async () => ({ success: false, error: 'SEEDANCE_KEY_MISSING' }))
    const store = useVideoWorkbenchStore.getState()
    const [a, b] = store.addCards([{ prompt: '猫' }, {}])
    const result = await useVideoWorkbenchStore.getState().startCards([a, b, 'ghost'])
    expect(result.started).toEqual([a])
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { cardId: b, reason: '提示词为空' },
        { cardId: 'ghost', reason: '卡片不存在' },
      ]),
    )
    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.status).toBe('failed')
    expect(card.error).toBe('SEEDANCE_KEY_MISSING')
  })

  it('preload 桥缺失时全部 skip 且不抛', async () => {
    const store = useVideoWorkbenchStore.getState()
    const [a] = store.addCards([{ prompt: '猫' }])
    const result = await store.startCards([a])
    expect(result.started).toHaveLength(0)
    expect(result.skipped[0].reason).toContain('未就绪')
  })

  it('进行中的卡不可重复启动(canStart 状态门)', () => {
    const card = buildCard({ prompt: 'x' }, 0)
    expect(canStart(card).ok).toBe(true)
    expect(canStart({ ...card, status: 'running' }).ok).toBe(false)
    expect(canStart({ ...card, status: 'failed' }).ok).toBe(true)
    expect(canStart({ ...card, status: 'succeeded' }).ok).toBe(true)
    expect(canStart({ ...card, prompt: ' ' }).ok).toBe(false)
  })
})

describe('applyTaskUpdate 广播对齐', () => {
  it('按 clientId 对齐卡片并推进状态;非 workbench 来源忽略', async () => {
    mockSubmit(async () => ({ success: true, taskId: 'task-1' }))
    const store = useVideoWorkbenchStore.getState()
    store.addCards([{ prompt: '猫' }])
    await useVideoWorkbenchStore.getState().startCards()
    const clientId = useVideoWorkbenchStore.getState().cards[0].clientId!

    // 非 workbench 来源(聊天 generate_video)绝不动工作台卡片
    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({ clientId, status: 'failed', error: '别人的任务', source: undefined }),
    )
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('queued')

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('running')

    useVideoWorkbenchStore.getState().applyTaskUpdate(
      makeUpdate({
        clientId,
        status: 'succeeded',
        videoUrl: 'https://upstream/v.mp4',
        localPath: 'C:\\videos\\v.mp4',
        remoteUrl: 'https://cos/v.mp4',
        persistence: 'done',
      }),
    )
    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.status).toBe('succeeded')
    expect(card.localPath).toBe('C:\\videos\\v.mp4')
    expect(card.remoteUrl).toBe('https://cos/v.mp4')
    expect(card.persistence).toBe('done')
  })

  it('广播先于 submit 返回到达也能对齐(clientId 提交前已定格)', async () => {
    // submit 挂起,先送广播再 resolve —— 模拟 IPC 返回慢于 webContents.send
    let release: (v: { success: true; taskId: string }) => void = () => {}
    mockSubmit(() => new Promise((r) => { release = r as typeof release }))
    const store = useVideoWorkbenchStore.getState()
    store.addCards([{ prompt: '猫' }])
    const pending = useVideoWorkbenchStore.getState().startCards()
    const clientId = useVideoWorkbenchStore.getState().cards[0].clientId!

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({ clientId, status: 'running' }))
    expect(useVideoWorkbenchStore.getState().cards[0].status).toBe('running')

    release({ success: true, taskId: 'task-1' })
    await pending
    // submit 返回不把已 running 的状态倒回 queued
    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.status).toBe('running')
    expect(card.taskId).toBe('task-1')
  })

  it('snapshotCard 截断长 prompt 并带引用计数', () => {
    const card = buildCard(
      { prompt: 'x'.repeat(300), referenceImages: ['a.png', 'b.png'] },
      3,
    )
    const snap = snapshotCard({ ...card, taskId: 't-9', localPath: 'C:/v.mp4' })
    expect(snap.prompt.length).toBeLessThanOrEqual(121)
    expect(snap.referenceCounts).toEqual({ images: 2, videos: 0, audios: 0 })
    expect(snap).toMatchObject({ cardId: card.id, order: 3, taskId: 't-9', localPath: 'C:/v.mp4' })
  })

  it('snapshotCard 带 boardId 与紧凑素材清单(名截 40 字符,不倒 URL 全文)', () => {
    const longName = `${'n'.repeat(60)}.png`
    const card = buildCard(
      {
        prompt: 'p',
        referenceImages: [{ name: longName, src: `D:/x/${longName}` }],
        referenceAudios: ['https://cdn.example.com/very/long/path/bgm-final-mix-v2.mp3?sig=abcdef123456'],
      },
      0,
      'board-1',
    )
    const snap = snapshotCard(card)
    expect(snap.boardId).toBe('board-1')
    expect(snap.references.images).toHaveLength(1)
    // 40 字符截断 + 省略号
    expect(snap.references.images[0].name.length).toBeLessThanOrEqual(41)
    expect(snap.references.images[0].name.endsWith('…')).toBe(true)
    // https 源只留文件名,不携带 URL 全文
    expect(snap.references.audios[0].name).toBe('bgm-final-mix-v2.mp3')
    expect(JSON.stringify(snap.references)).not.toContain('https://')
  })

  it('snapshotCard:asset:// 素材清单带简短 assetId 尾缀(人像库可反查)', () => {
    const card = buildCard(
      {
        prompt: 'p',
        referenceImages: [
          // 已回填真实名字的人像库素材 → 名字后补 @assetId 尾缀
          { name: '主角立绘', src: 'asset://portrait-42abc' },
          // 未回填的占位名(toMaterial 已含 id)→ 不重复加尾缀
          'asset://asset-1234567890',
        ],
      },
      0,
    )
    const snap = snapshotCard(card)
    expect(snap.references.images[0].name).toBe('主角立绘@portrait-42a')
    expect(snap.references.images[1].name).toContain('asset-123456')
    expect(snap.references.images[1].name.match(/asset-123456/g)).toHaveLength(1)
  })
})

describe('snapshotWorkbench 全局摘要', () => {
  const projects = [{ id: 'p1', name: '第一部', order: 0, createdAt: 1, updatedAt: 1 }]

  it('聚合 boards 卡数与全局状态计数(boards 按 order 排),带当前剧头', () => {
    const boards = [
      { id: 'b2', projectId: 'p1', name: '分镜', order: 1, createdAt: 2 },
      { id: 'b1', projectId: 'p1', name: '页面 1', order: 0, createdAt: 1 },
    ]
    const cards = [
      buildCard({ prompt: 'a' }, 0, 'b1'),
      { ...buildCard({ prompt: 'b' }, 1, 'b1'), status: 'running' as const },
      { ...buildCard({ prompt: 'c' }, 0, 'b2'), status: 'succeeded' as const },
      { ...buildCard({ prompt: 'd' }, 1, 'b2'), status: 'failed' as const },
    ]
    const summary = snapshotWorkbench({
      cards, boards, projects, activeProjectId: 'p1', activeBoardId: 'b2', selectedCardIds: [],
    })
    expect(summary).toEqual({
      project: { id: 'p1', name: '第一部', segments: 2, cards: 4 },
      activeBoardId: 'b2',
      boards: [
        { id: 'b1', name: '页面 1', cardCount: 2 },
        { id: 'b2', name: '分镜', cardCount: 2 },
      ],
      statusCounts: { draft: 1, preparing: 0, queued: 0, running: 1, succeeded: 1, failed: 1 },
      selectedCardIds: [],
    })
  })

  it('只统计当前剧:别的剧的分段与卡不进 boards / statusCounts', () => {
    const boards = [
      { id: 'b1', projectId: 'p1', name: '本剧', order: 0, createdAt: 1 },
      { id: 'x1', projectId: 'p2', name: '别剧', order: 0, createdAt: 1 },
    ]
    const cards = [
      buildCard({ prompt: 'a' }, 0, 'b1'),
      { ...buildCard({ prompt: 'z' }, 0, 'x1'), status: 'failed' as const },
    ]
    const summary = snapshotWorkbench({
      cards, boards, projects, activeProjectId: 'p1', activeBoardId: 'b1', selectedCardIds: [],
    })
    expect(summary.project).toEqual({ id: 'p1', name: '第一部', segments: 1, cards: 1 })
    expect(summary.boards.map((b) => b.id)).toEqual(['b1'])
    expect(summary.statusCounts.failed).toBe(0)
  })

  it('空页计数为 0;未知状态不计入但不抛错', () => {
    const boards = [{ id: 'b1', projectId: 'p1', name: '页面 1', order: 0, createdAt: 1 }]
    const summary = snapshotWorkbench({
      cards: [{ ...buildCard({ prompt: 'x' }, 0, 'b1'), status: 'weird' as never }],
      boards,
      projects,
      activeProjectId: 'p1',
      activeBoardId: 'b1',
      selectedCardIds: [],
    })
    expect(summary.boards).toEqual([{ id: 'b1', name: '页面 1', cardCount: 1 }])
    expect(summary.statusCounts).toEqual({ draft: 0, preparing: 0, queued: 0, running: 0, succeeded: 0, failed: 0 })
  })
})

describe('autoImportPortrait 全局开关', () => {
  it('默认开启;setAutoImportPortrait 写 localStorage 持久化', () => {
    localStorage.removeItem(AUTO_IMPORT_PORTRAIT_KEY)
    resetWorkbenchStoreForTest()
    expect(useVideoWorkbenchStore.getState().autoImportPortrait).toBe(true)

    useVideoWorkbenchStore.getState().setAutoImportPortrait(false)
    expect(useVideoWorkbenchStore.getState().autoImportPortrait).toBe(false)
    expect(localStorage.getItem(AUTO_IMPORT_PORTRAIT_KEY)).toBe('0')

    useVideoWorkbenchStore.getState().setAutoImportPortrait(true)
    expect(localStorage.getItem(AUTO_IMPORT_PORTRAIT_KEY)).toBe('1')
  })
})

describe('ensureHydrated', () => {
  // 死活判定归 reconcileInFlight 所有(它才问得到上游)。水合期抢先判死会让对账
  // 拿到空集、adopt() 永不执行 —— 整条重启接管链就废了。完整序列见
  // storeLifecycle.test.ts 的「重启接管的完整序列」。
  it('带 taskId 的在飞卡片原样读回,留给对账去问上游', async () => {
    const db = getWorkbenchDb()
    await db.put({ ...buildCard({ prompt: '断电前在跑' }, 0), id: 'c-run', status: 'running', taskId: 't1' })
    await db.put({ ...buildCard({ prompt: '完好' }, 1), id: 'c-done', status: 'succeeded', localPath: 'C:/v.mp4' })

    await useVideoWorkbenchStore.getState().ensureHydrated()
    const cards = useVideoWorkbenchStore.getState().cards
    expect(cards.find((c) => c.id === 'c-run')).toMatchObject({ status: 'running', taskId: 't1' })
    expect(cards.find((c) => c.id === 'c-done')).toMatchObject({ status: 'succeeded' })
  })

  it('没 taskId 的在飞卡片就地判死:上游从没收到过它,无从对账', async () => {
    const db = getWorkbenchDb()
    await db.put({ ...buildCard({ prompt: '没提交成功' }, 0), id: 'c-orphan', status: 'preparing' })

    await useVideoWorkbenchStore.getState().ensureHydrated()
    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === 'c-orphan')!
    expect(card.status).toBe('failed')
    expect(card.error).toBeTruthy()
  })
})

describe('addCards 锚点插入', () => {
  it('插到中间:顺序压实,后续卡顺延', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])
    const [mid] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['A', 'M', 'B'])
    expect(cards.map((c) => c.order)).toEqual([0, 1, 2])
    expect(cards.find((c) => c.id === mid)?.order).toBe(1)
  })

  it('beforeCardId 插到最前', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'T' }], { beforeCardId: a })

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['T', 'A'])
  })

  it('锚点在非活动页:新卡落在锚点那一页,不是 activeBoardId', () => {
    const [onFirst] = useVideoWorkbenchStore.getState().addCards([{ prompt: '第一页的卡' }])
    const firstBoardId = useVideoWorkbenchStore.getState().cards[0].boardId
    const secondBoardId = useVideoWorkbenchStore.getState().addBoard('第二页')
    useVideoWorkbenchStore.getState().switchBoard(secondBoardId)
    expect(useVideoWorkbenchStore.getState().activeBoardId).toBe(secondBoardId)

    const [inserted] = useVideoWorkbenchStore.getState().addCards(
      [{ prompt: '插进第一页' }],
      { afterCardId: onFirst },
    )

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === inserted)
    expect(card?.boardId).toBe(firstBoardId)
  })

  it('锚点不存在:抛错且什么都不写', () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    const countBefore = useVideoWorkbenchStore.getState().cards.length
    const structureBefore = useVideoWorkbenchStore.getState().structureRevision

    expect(() =>
      useVideoWorkbenchStore.getState().addCards([{ prompt: 'X' }], { afterCardId: '不存在' }),
    ).toThrow(/anchor card not found/)

    expect(useVideoWorkbenchStore.getState().cards).toHaveLength(countBefore)
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(structureBefore)
  })

  it('不传锚点仍追加到当前页末尾(回归守卫)', () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }, { prompt: 'B' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'C' }])

    const cards = [...useVideoWorkbenchStore.getState().cards].sort((x, y) => x.order - y.order)
    expect(cards.map((c) => c.prompt)).toEqual(['A', 'B', 'C'])
  })

  it('插入 bump revision 与 structureRevision', () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    const rev = useVideoWorkbenchStore.getState().revision
    const structure = useVideoWorkbenchStore.getState().structureRevision

    useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })

    expect(useVideoWorkbenchStore.getState().revision).toBe(rev + 1)
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(structure + 1)
  })

  it('插入后新卡落库的 order 是压实后的值,不是占位 0', async () => {
    const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])
    const [mid] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })

    const rows = await getWorkbenchDb().list()
    expect(rows.find((r) => r.id === mid)?.order).toBe(1)
  })

  it('被顶下去的兄弟卡也重新落库,重载后顺序不会错乱', async () => {
    // schedulePersist 有 500ms 防抖(store.ts PERSIST_DEBOUNCE_MS),要推进定时器才看得到写入。
    vi.useFakeTimers()
    try {
      const [a] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'A' }])
      const [b] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'B' }])
      // B 落库时 order 是 1;插入后应变成 2 并被补写。
      useVideoWorkbenchStore.getState().addCards([{ prompt: 'M' }], { afterCardId: a })
      await vi.advanceTimersByTimeAsync(600)

      const rows = await getWorkbenchDb().list()
      expect(rows.find((r) => r.id === b)?.order).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('版本历史', () => {
  function markRunning(id: string, taskId: string, patch: Record<string, unknown> = {}): void {
    useVideoWorkbenchStore.setState({
      cards: useVideoWorkbenchStore.getState().cards.map((c) =>
        c.id === id ? { ...c, taskId, status: 'running', ...patch } : c),
    })
  }

  it('成功一次产生 v1,规格快照与产出时一致', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '第一版', duration: 8 }])
    markRunning(id, 't1')

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v1.mp4',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions).toHaveLength(1)
    expect(card.versions![0]).toMatchObject({ seq: 1, localPath: 'C:/v1.mp4' })
    expect(card.versions![0].spec).toMatchObject({ prompt: '第一版', duration: 8 })
  })

  it('改提示词后重生:v1 保留旧提示词,v2 记新提示词', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '旧提示词' }])
    markRunning(id, 't1')
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v1.mp4',
    }))

    // 重生的典型动机就是改了提示词 —— 这一改必须只影响 v2。
    useVideoWorkbenchStore.getState().updateCard(id, { prompt: '新提示词' })
    markRunning(id, 't2', { historyRecorded: undefined, localPath: undefined })
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't2', status: 'succeeded', localPath: 'C:/v2.mp4',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions!.map((v) => v.spec.prompt)).toEqual(['旧提示词', '新提示词'])
    expect(card.versions!.map((v) => v.seq)).toEqual([1, 2])
    expect(card.versions!.map((v) => v.localPath)).toEqual(['C:/v1.mp4', 'C:/v2.mp4'])
  })

  it('持久地址后到时升级最新版本,而不是再追加一条', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    markRunning(id, 't1')
    // 先只有上游临时地址
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', videoUrl: 'https://tmp/v.mp4',
    }))
    // 落盘 + 转存完成后带来持久地址
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v.mp4', remoteUrl: 'https://cos/v.mp4',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions).toHaveLength(1)
    expect(card.versions![0]).toMatchObject({
      localPath: 'C:/v.mp4',
      remoteUrl: 'https://cos/v.mp4',
    })
  })

  it('失败的一轮不产生版本记录', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    markRunning(id, 't1')

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'failed', error: '上游拒绝',
    }))

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.versions ?? []).toHaveLength(0)
  })

  it('版本的素材快照只记名字,不复制字节', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([
      { prompt: 'p', referenceImages: ['data:image/png;base64,AAAABBBBCCCC'] },
    ])
    markRunning(id, 't1')

    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v.mp4',
    }))

    const version = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.versions![0]
    expect(version.spec.referenceBrief.images).toHaveLength(1)
    expect(JSON.stringify(version)).not.toContain('base64')
  })

  it('版本变化不算规格变化(versions 挂在 Card 上而非 Spec 上)', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    const before = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    const after = { ...before, versions: [] }
    expect(specEquals(before, after)).toBe(true)
  })

  it('snapshotCard 带出版本摘要,供 agent 引用具体某一版', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'p' }])
    markRunning(id, 't1')
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', remoteUrl: 'https://cos/v1.mp4',
    }))

    const snap = snapshotCard(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!)
    expect(snap.versions).toEqual([
      { seq: 1, remoteUrl: 'https://cos/v1.mp4', prompt: 'p' },
    ])
  })

  it('撤销只还原意图,不删版本记录', () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: '旧' }])
    useVideoWorkbenchStore.getState().updateCard(id, { prompt: '新' })
    markRunning(id, 't1')
    useVideoWorkbenchStore.getState().applyTaskUpdate(makeUpdate({
      taskId: 't1', status: 'succeeded', localPath: 'C:/v1.mp4',
    }))
    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.versions).toHaveLength(1)

    useVideoWorkbenchStore.getState().undo()

    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    // 提示词回到「旧」,但产物存档必须还在 —— 版本是结果不是意图。
    expect(card.prompt).toBe('旧')
    expect(card.versions).toHaveLength(1)
  })
})

describe('卡片总量不设上限', () => {
  it('加满 203 张卡不淘汰任何一张:内存与库都是全量', async () => {
    const total = 203
    useVideoWorkbenchStore.getState().addCards(
      Array.from({ length: total }, (_, i) => ({ prompt: `p${i}` })),
    )

    expect(useVideoWorkbenchStore.getState().cards).toHaveLength(total)
    await vi.waitFor(async () => {
      expect(await getWorkbenchDb().list()).toHaveLength(total)
    })
    // 最早那张必须还在 —— 旧的淘汰逻辑正是从这头开始删的。
    expect(useVideoWorkbenchStore.getState().cards[0].prompt).toBe('p0')
  })
})

describe('选中态', () => {
  function seed(n: number): string[] {
    return useVideoWorkbenchStore.getState().addCards(
      Array.from({ length: n }, (_, i) => ({ prompt: `p${i}` })),
    )
  }

  it('单击替换选中,Ctrl 切换,Shift 选区间', () => {
    const ids = seed(5)
    const s = () => useVideoWorkbenchStore.getState()

    s().selectCard(ids[1])
    expect(s().selectedCardIds).toEqual([ids[1]])

    s().selectCard(ids[3])
    expect(s().selectedCardIds).toEqual([ids[3]])

    s().selectCard(ids[0], 'toggle')
    expect(s().selectedCardIds).toEqual([ids[3], ids[0]])
    s().selectCard(ids[0], 'toggle')
    expect(s().selectedCardIds).toEqual([ids[3]])

    // 锚点 = 上一次 replace/toggle 命中的那张(ids[3]),区间到 ids[1]
    s().selectCard(ids[1], 'range')
    expect([...s().selectedCardIds].sort()).toEqual([ids[1], ids[2], ids[3]].sort())
  })

  it('没有锚点时 Shift 等同单击', () => {
    const ids = seed(3)
    useVideoWorkbenchStore.getState().selectCard(ids[2], 'range')
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([ids[2]])
  })

  it('选中不递增 revision / structureRevision', () => {
    const ids = seed(2)
    const before = useVideoWorkbenchStore.getState()
    const rev = before.revision
    const structRev = before.structureRevision
    before.selectCard(ids[0])
    const after = useVideoWorkbenchStore.getState()
    expect(after.revision).toBe(rev)
    expect(after.structureRevision).toBe(structRev)
  })

  it('切页清空选中', () => {
    const ids = seed(2)
    const store = useVideoWorkbenchStore.getState()
    store.selectCard(ids[0])
    const other = store.addBoard('第二页')
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])

    useVideoWorkbenchStore.getState().selectCard(
      useVideoWorkbenchStore.getState().addCards([{ prompt: 'x' }])[0],
    )
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toHaveLength(1)
    useVideoWorkbenchStore.getState().switchBoard(other)
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])
  })

  it('删卡把它从选中里剪掉', () => {
    const ids = seed(3)
    const store = useVideoWorkbenchStore.getState()
    store.selectCard(ids[0])
    store.selectCard(ids[1], 'toggle')
    useVideoWorkbenchStore.getState().removeCard(ids[0])
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([ids[1]])
  })

  it('removeCards 一次事务删多张,order 重新密排', () => {
    const ids = seed(4)
    useVideoWorkbenchStore.getState().removeCards([ids[0], ids[2]])
    const cards = useVideoWorkbenchStore.getState().cards
    expect(cards.map((c) => c.id)).toEqual([ids[1], ids[3]])
    expect(cards.map((c) => c.order)).toEqual([0, 1])
    expect(useVideoWorkbenchStore.getState().selectedCardIds).toEqual([])
  })

  it('removeCards 只让 structureRevision 走一格', () => {
    const ids = seed(3)
    const structRev = useVideoWorkbenchStore.getState().structureRevision
    useVideoWorkbenchStore.getState().removeCards([ids[0], ids[1]])
    expect(useVideoWorkbenchStore.getState().structureRevision).toBe(structRev + 1)
  })
})

describe('无参批量操作吃选中态', () => {
  it('有选中时 startCards() 只启动选中项', async () => {
    const submit = mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([
      { prompt: 'a' },
      { prompt: 'b' },
      { prompt: 'c' },
    ])
    useVideoWorkbenchStore.getState().selectCard(ids[1])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toEqual([ids[1]])
    expect(submit).toHaveBeenCalledTimes(1)
  })

  it('无选中时 startCards() 维持整页', async () => {
    mockSubmit()
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toHaveLength(2)
  })

  it('显式 cardIds 无视选中 —— MCP 路径不受用户选中影响', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    useVideoWorkbenchStore.getState().selectCard(ids[0])
    const result = await useVideoWorkbenchStore.getState().startCards([ids[1]])
    expect(result.started).toEqual([ids[1]])
  })

  it('选中项在别的页时仍只启动选中项', async () => {
    mockSubmit()
    const first = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }])
    const other = useVideoWorkbenchStore.getState().addBoard('第二页')
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'b' }])
    useVideoWorkbenchStore.getState().switchBoard(other)
    // 切页已清空选中,这里手动选回第一页那张,模拟「选中与活动页不一致」
    useVideoWorkbenchStore.getState().selectCard(first[0])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toEqual([first[0]])
  })

  it('选中一张空白草稿点⚡,如实报「提示词为空」而不是静默无事发生', async () => {
    mockSubmit()
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: '' }, { prompt: 'b' }])
    useVideoWorkbenchStore.getState().selectCard(ids[0])
    const result = await useVideoWorkbenchStore.getState().startCards()
    expect(result.started).toEqual([])
    expect(result.skipped).toEqual([{ cardId: ids[0], reason: '提示词为空' }])
  })
})

describe('摘要带出选中态', () => {
  it('snapshotWorkbench 回带 selectedCardIds', () => {
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    useVideoWorkbenchStore.getState().selectCard(ids[1])
    const summary = snapshotWorkbench(useVideoWorkbenchStore.getState())
    expect(summary.selectedCardIds).toEqual([ids[1]])
  })

  it('没有选中时是空数组而不是缺字段', () => {
    useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }])
    expect(snapshotWorkbench(useVideoWorkbenchStore.getState()).selectedCardIds).toEqual([])
  })

  it('回带的是副本 —— 之后改选中不会篡改已发出的摘要', () => {
    const ids = useVideoWorkbenchStore.getState().addCards([{ prompt: 'a' }, { prompt: 'b' }])
    useVideoWorkbenchStore.getState().selectCard(ids[0])
    const summary = snapshotWorkbench(useVideoWorkbenchStore.getState())
    useVideoWorkbenchStore.getState().selectCard(ids[1], 'toggle')
    expect(summary.selectedCardIds).toEqual([ids[0]])
  })
})

/**
 * 手动「重新保存」是降级路径的最后一环。
 *
 * 自动重试只覆盖到 21 分钟（任务之后从主进程内存表清掉），而上游地址有效期约一天。
 * 断网超过半小时的情况只能靠用户点一下 —— 没有这条路，视频就真的没了，
 * 唯一补救是花钱重生成一条已经生成好的片子。
 */
describe('resaveCard 手动重新保存', () => {
  it('用卡片上留着的 videoUrl 重下，成功后升级为 done 并写回路径', async () => {
    const repersist = vi.fn(async () => ({ ok: true, localPath: 'D:/save/v.mp4', remoteUrl: 'https://cos/v.mp4' }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { videoWorkbench: { repersist } }

    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'x' }])
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id
        ? { ...c, status: 'succeeded' as const, persistence: 'failed' as const, videoUrl: 'https://cdn/v.mp4' }
        : c)),
    }))

    const r = await useVideoWorkbenchStore.getState().resaveCard(id)
    expect(r.ok).toBe(true)
    expect(repersist).toHaveBeenCalledWith(expect.objectContaining({ videoUrl: 'https://cdn/v.mp4' }))
    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
    expect(card.persistence).toBe('done')
    expect(card.localPath).toBe('D:/save/v.mp4')
    expect(card.remoteUrl).toBe('https://cos/v.mp4')
  })

  it('没有 videoUrl 时如实拒绝，不让用户白点', async () => {
    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'x' }])
    const r = await useVideoWorkbenchStore.getState().resaveCard(id)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('只能重新生成')
  })

  it('重下失败时回到 failed，而不是卡在 running 上', async () => {
    const repersist = vi.fn(async () => ({ ok: false, error: 'ERR_CONNECTION_CLOSED' }))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { videoWorkbench: { repersist } }

    const [id] = useVideoWorkbenchStore.getState().addCards([{ prompt: 'x' }])
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, videoUrl: 'https://cdn/v.mp4' } : c)),
    }))
    const r = await useVideoWorkbenchStore.getState().resaveCard(id)
    expect(r.ok).toBe(false)
    expect(useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!.persistence).toBe('failed')
  })
})