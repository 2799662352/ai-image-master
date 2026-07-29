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
import { WORKBENCH_MAX_CARDS, getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

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
  it('聚合 boards 卡数与全局状态计数(boards 按 order 排)', () => {
    const boards = [
      { id: 'b2', name: '分镜', order: 1, createdAt: 2 },
      { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
    ]
    const cards = [
      buildCard({ prompt: 'a' }, 0, 'b1'),
      { ...buildCard({ prompt: 'b' }, 1, 'b1'), status: 'running' as const },
      { ...buildCard({ prompt: 'c' }, 0, 'b2'), status: 'succeeded' as const },
      { ...buildCard({ prompt: 'd' }, 1, 'b2'), status: 'failed' as const },
    ]
    const summary = snapshotWorkbench({ cards, boards, activeBoardId: 'b2' })
    expect(summary).toEqual({
      activeBoardId: 'b2',
      boards: [
        { id: 'b1', name: '页面 1', cardCount: 2 },
        { id: 'b2', name: '分镜', cardCount: 2 },
      ],
      statusCounts: { draft: 1, preparing: 0, queued: 0, running: 1, succeeded: 1, failed: 1 },
    })
  })

  it('空页计数为 0;未知状态不计入但不抛错', () => {
    const boards = [{ id: 'b1', name: '页面 1', order: 0, createdAt: 1 }]
    const summary = snapshotWorkbench({
      cards: [{ ...buildCard({ prompt: 'x' }, 0, 'b1'), status: 'weird' as never }],
      boards,
      activeBoardId: 'b1',
    })
    expect(summary.boards).toEqual([{ id: 'b1', name: '页面 1', cardCount: 1 }])
    expect(summary.statusCounts).toEqual({ draft: 0, preparing: 0, queued: 0, running: 0, succeeded: 0, failed: 0 })
  })
})

describe('autoImportPortrait 全局开关', () => {
  it('默认关闭;setAutoImportPortrait 写 localStorage 持久化', () => {
    localStorage.removeItem(AUTO_IMPORT_PORTRAIT_KEY)
    resetWorkbenchStoreForTest()
    expect(useVideoWorkbenchStore.getState().autoImportPortrait).toBe(false)

    useVideoWorkbenchStore.getState().setAutoImportPortrait(true)
    expect(useVideoWorkbenchStore.getState().autoImportPortrait).toBe(true)
    expect(localStorage.getItem(AUTO_IMPORT_PORTRAIT_KEY)).toBe('1')

    useVideoWorkbenchStore.getState().setAutoImportPortrait(false)
    expect(localStorage.getItem(AUTO_IMPORT_PORTRAIT_KEY)).toBe('0')
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

describe('超上限淘汰', () => {
  it('被淘汰的卡同步从内存摘掉,不会等到重启才消失', async () => {
    useVideoWorkbenchStore.getState().addCards(
      Array.from({ length: WORKBENCH_MAX_CARDS + 3 }, (_, i) => ({ prompt: `p${i}` })),
    )

    await vi.waitFor(() => {
      expect(useVideoWorkbenchStore.getState().cards).toHaveLength(WORKBENCH_MAX_CARDS)
    })
    const rows = await getWorkbenchDb().list()
    expect(rows).toHaveLength(WORKBENCH_MAX_CARDS)
  })
})
