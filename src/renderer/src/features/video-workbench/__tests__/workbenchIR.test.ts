// 看板 JSON IR 的纯逻辑单测:导出的纯度/占位、apply 的冲突检测、merge/replace
// 语义、逐项跳过原因、批量落盘增量。全部喂普通对象,不碰 store 也不碰 IndexedDB。

import { describe, expect, it } from 'vitest'
import type {
  VideoWorkbenchCard,
  VideoWorkbenchCardStatus,
  WorkbenchIR,
} from '../../../../../types/videoWorkbench'
import { WORKBENCH_IR_VERSION } from '../../../../../types/videoWorkbench'
import { normalizeSpec } from '../cardSpec'
import {
  type WorkbenchIRSource,
  exportWorkbenchIR,
  planApplyIR,
} from '../workbenchIR'
import { WORKBENCH_MAX_CARDS } from '../WorkbenchDb'

function card(patch: Partial<VideoWorkbenchCard> & { id: string; boardId: string }): VideoWorkbenchCard {
  return {
    order: 0,
    status: 'draft' as VideoWorkbenchCardStatus,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...normalizeSpec({ prompt: patch.prompt ?? '' }),
    ...patch,
  }
}

function source(patch: Partial<WorkbenchIRSource> = {}): WorkbenchIRSource {
  return {
    boards: [{ id: 'b1', name: '页面 1', order: 0, createdAt: 1_000 }],
    cards: [],
    activeBoardId: 'b1',
    revision: 0,
    structureRevision: 0,
    ...patch,
  }
}

/** 从导出结果里取一份可回写的 IR(模拟 agent 的 round-trip)。 */
function roundTrip(src: WorkbenchIRSource): WorkbenchIR {
  return JSON.parse(JSON.stringify(exportWorkbenchIR(src))) as WorkbenchIR
}

describe('exportWorkbenchIR', () => {
  it('页与卡按 order 排,数组顺序即最终顺序(IR 里没有 order 字段)', () => {
    const src = source({
      boards: [
        { id: 'b2', name: '第二页', order: 1, createdAt: 1 },
        { id: 'b1', name: '第一页', order: 0, createdAt: 1 },
      ],
      cards: [
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: '第二镜' }),
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: '第一镜' }),
        card({ id: 'c3', boardId: 'b2', order: 0, prompt: '别页' }),
      ],
    })
    const ir = exportWorkbenchIR(src)
    expect(ir.boards.map((b) => b.name)).toEqual(['第一页', '第二页'])
    expect(ir.boards[0].cards.map((c) => c.prompt)).toEqual(['第一镜', '第二镜'])
    expect(ir.boards[1].cards.map((c) => c.id)).toEqual(['c3'])
    expect(JSON.stringify(ir)).not.toContain('"order"')
  })

  it('带 irVersion 与两级并发令牌(整份 structureRevision + 按卡 rev)', () => {
    const ir = exportWorkbenchIR(
      source({
        structureRevision: 7,
        cards: [card({ id: 'c1', boardId: 'b1', rev: 3 }), card({ id: 'c2', boardId: 'b1', order: 1 })],
      }),
    )
    expect(ir.irVersion).toBe(WORKBENCH_IR_VERSION)
    expect(ir.structureRevision).toBe(7)
    expect(ir.activeBoardId).toBe('b1')
    // 老库卡片缺 rev → 导出成 0
    expect(ir.boards[0].cards.map((c) => c.rev)).toEqual([3, 0])
  })

  it('运行时结果只作只读注解进 result,不混进意图字段', () => {
    const src = source({
      cards: [card({
        id: 'c1',
        boardId: 'b1',
        status: 'succeeded',
        taskId: 't-1',
        localPath: 'D:/v.mp4',
        remoteUrl: 'https://cos/v.mp4',
        videoUrl: 'https://ark/tmp.mp4',
        actualSeed: 42,
        completionTokens: 1234,
        historyRecorded: true,
        persistence: 'done',
      })],
    })
    const exported = exportWorkbenchIR(src).boards[0].cards[0]
    expect(exported.result).toEqual({
      status: 'succeeded',
      taskId: 't-1',
      localPath: 'D:/v.mp4',
      remoteUrl: 'https://cos/v.mp4',
    })
    // videoUrl / actualSeed / completionTokens / historyRecorded / persistence 都不该出现。
    expect(Object.keys(exported)).not.toContain('videoUrl')
    expect(Object.keys(exported)).not.toContain('actualSeed')
    expect(Object.keys(exported)).not.toContain('historyRecorded')
    expect(JSON.stringify(exported)).not.toContain('completionTokens')
  })

  it('data: URL 素材换成 wbref 占位;短 src 原样;previewUrl 不进 IR', () => {
    const src = source({
      cards: [card({
        id: 'c1',
        boardId: 'b1',
        referenceImages: [
          { name: '(内嵌素材)', src: 'data:image/png;base64,AAAA' },
          { name: '立绘', src: 'asset://a1', previewUrl: 'https://cdn/a1.jpg' },
          { name: 'local.png', src: 'D:/local.png' },
        ],
      })],
    })
    const images = exportWorkbenchIR(src).boards[0].cards[0].referenceImages!
    expect(images).toEqual([
      { name: '(内嵌素材)', src: 'wbref://c1/referenceImages/0' },
      { name: '立绘', src: 'asset://a1' },
      { name: 'local.png', src: 'D:/local.png' },
    ])
  })

  it('base64 不出现在导出体积里(哪怕素材很大)', () => {
    const big = `data:image/png;base64,${'A'.repeat(50_000)}`
    const src = source({ cards: [card({ id: 'c1', boardId: 'b1', referenceVideos: [{ name: 'v', src: big }] })] })
    const json = JSON.stringify(exportWorkbenchIR(src))
    expect(json).not.toContain('AAAA')
    expect(json.length).toBeLessThan(2_000)
  })
})

describe('planApplyIR / 拒绝路径', () => {
  it('irVersion 不认识时拒绝,不做尽力而为的猜测', () => {
    const plan = planApplyIR(source(), { ...roundTrip(source()), irVersion: 99 })
    expect(plan.result.ok).toBe(false)
    expect(plan.next).toBeUndefined()
    expect(plan.result.skipped[0].reason).toContain('irVersion')
  })

  it('structureRevision 过期时整份拒绝并回报冲突,什么都不写', () => {
    const src = source({
      structureRevision: 5,
      cards: [card({ id: 'c1', boardId: 'b1', prompt: '旧' })],
    })
    const ir = roundTrip(src)
    ir.structureRevision = 3 // agent 手里是旧令牌:这期间有卡被增删或挪过位
    ir.boards[0].cards[0].prompt = '新'
    const plan = planApplyIR(src, ir)
    expect(plan.result.ok).toBe(false)
    expect(plan.result.conflict).toEqual({ expected: 3, actual: 5 })
    expect(plan.next).toBeUndefined()
    expect(plan.result.structureRevision).toBe(5)
  })

  it('force 可以越过两级校验', () => {
    const src = source({
      structureRevision: 5,
      cards: [card({ id: 'c1', boardId: 'b1', prompt: '旧', rev: 9 })],
    })
    const ir = roundTrip(src)
    ir.structureRevision = 3
    ir.boards[0].cards[0].rev = 1
    ir.boards[0].cards[0].prompt = '新'
    const plan = planApplyIR(src, ir, { force: true })
    expect(plan.result.ok).toBe(true)
    expect(plan.result.cards.updated).toEqual(['c1'])
  })

  it('单张卡的 rev 过期只跳过那一张,其余照写(用户打字不该废掉整份 apply)', () => {
    const src = source({
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: '用户刚改的', rev: 4 }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: '没人碰', rev: 0 }),
      ],
    })
    const ir = roundTrip(src)
    ir.boards[0].cards[0].rev = 1 // agent 导出时是 1,用户之后又改过
    ir.boards[0].cards[0].prompt = 'agent 想写的'
    ir.boards[0].cards[1].prompt = 'agent 改了这张'

    const plan = planApplyIR(src, ir)

    expect(plan.result.ok).toBe(true)
    expect(plan.result.conflict).toBeUndefined()
    expect(plan.result.cards.updated).toEqual(['c2'])
    // 跳过项要带上这张卡**现在的样子**：agent 才能不用再 export 一次就判断
    // 「用户到底改了什么、该重写还是该问」。冲突是可恢复的，不是死路。
    expect(plan.result.skipped).toHaveLength(1)
    const skip = plan.result.skipped[0]
    expect(skip.cardId).toBe('c1')
    expect(skip.reason).toContain('被用户改过')
    expect(skip.current).toEqual({
      prompt: '用户刚改的',
      model: '2.0',
      resolution: '720p',
      ratio: '16:9',
      duration: 5,
      // 抄这个 rev 回去即可覆盖，不必重新 export 整板。
      rev: 4,
    })
    const byId = new Map(plan.next!.cards.map((c) => [c.id, c]))
    expect(byId.get('c1')!.prompt).toBe('用户刚改的')
    expect(byId.get('c2')!.prompt).toBe('agent 改了这张')
    // 被跳过的那张不该重写落盘
    expect(plan.persist!.cards.map((c) => c.id)).toEqual(['c2'])
  })

  it('rev 过期但只改位置:位置照样生效(位置由 structureRevision 担保)', () => {
    const src = source({
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A', rev: 4 }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B', rev: 0 }),
      ],
    })
    const ir = roundTrip(src)
    ir.boards[0].cards = [ir.boards[0].cards[1], ir.boards[0].cards[0]]
    ir.boards[0].cards[1].rev = 1 // c1 的 rev 过期,但 IR 没改它的规格

    const plan = planApplyIR(src, ir)

    expect(plan.result.ok).toBe(true)
    // 规格没变 → 根本走不到 rev 校验,不产生 skip
    expect(plan.result.skipped).toEqual([])
    const byId = new Map(plan.next!.cards.map((c) => [c.id, c]))
    expect(byId.get('c2')!.order).toBe(0)
    expect(byId.get('c1')!.order).toBe(1)
  })

  it('改一张卡的规格只 bump 该卡的 rev,不动 structureRevision', () => {
    const src = source({
      structureRevision: 5,
      cards: [card({ id: 'c1', boardId: 'b1', prompt: '旧', rev: 2 })],
    })
    const ir = roundTrip(src)
    ir.boards[0].cards[0].prompt = '新'

    const plan = planApplyIR(src, ir)

    expect(plan.result.structureRevision).toBe(5)
    expect(plan.next!.cards[0].rev).toBe(3)
    // 「有改动」计数器照涨 —— 它管撤销栈
    expect(plan.next!.revision).toBe(1)
  })

  it('新增/删除卡才 bump structureRevision', () => {
    const src = source({
      structureRevision: 5,
      cards: [card({ id: 'c1', boardId: 'b1', prompt: 'A' })],
    })
    const added = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 5,
      boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c1', prompt: 'A' }, { prompt: '新卡' }] }],
    })
    expect(added.result.structureRevision).toBe(6)
    expect(added.next!.cards.find((c) => c.prompt === '新卡')!.rev).toBe(0)
  })

  it('v1 的旧 IR 被拒绝并要求重新 export(令牌语义变了,不能尽力而为)', () => {
    const src = source({ cards: [card({ id: 'c1', boardId: 'b1' })] })
    const legacy = { ...roundTrip(src), irVersion: 1 } as unknown as Parameters<typeof planApplyIR>[1]
    const plan = planApplyIR(src, legacy)
    expect(plan.result.ok).toBe(false)
    expect(plan.result.skipped[0].reason).toContain('irVersion')
  })

  it('boards 为空 / 全是坏页时拒绝(否则等于清空工作台)', () => {
    expect(planApplyIR(source(), { irVersion: WORKBENCH_IR_VERSION, structureRevision: 0, boards: [] }).result.ok).toBe(false)
    const allBad = planApplyIR(source(), {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [{ name: '  ', cards: [] }],
    })
    expect(allBad.result.ok).toBe(false)
    expect(allBad.result.skipped.map((s) => s.reason).join()).toContain('没有一页可用')
  })

  it('版本进导出侧结果注解,但 apply 一律忽略(结果不是意图)', () => {
    const src = source({
      cards: [{
        ...card({ id: 'c1', boardId: 'b1', prompt: 'p' }),
        versions: [{
          id: 'ver1',
          seq: 1,
          createdAt: 1,
          remoteUrl: 'https://cos/v1.mp4',
          spec: {
            prompt: 'p',
            model: '2.0',
            resolution: '720p',
            ratio: '16:9',
            duration: 5,
            generateAudio: true,
            mode: 'multimodal_ref',
            webSearch: false,
            referenceBrief: { images: [], videos: [], audios: [] },
          },
        }],
      }],
    })

    const ir = roundTrip(src)
    expect(ir.boards[0].cards[0].result!.versions).toHaveLength(1)

    // 把注解改掉再 apply —— 不该有任何效果。
    ir.boards[0].cards[0].result!.versions = []
    const plan = planApplyIR(src, ir)
    expect(plan.next!.cards[0].versions).toHaveLength(1)
  })

  it('超过卡片上限不再拒绝:照写,超出部分由 evict 兜底淘汰', () => {
    const src = source()
    const ir = roundTrip(src)
    ir.boards[0].cards = Array.from({ length: WORKBENCH_MAX_CARDS + 1 }, (_, i) => ({ prompt: `镜 ${i}` }))
    const plan = planApplyIR(src, ir)
    expect(plan.result.ok).toBe(true)
    expect(plan.result.skipped.map((s) => s.reason).join()).not.toContain('超过上限')
    expect(plan.next!.cards).toHaveLength(WORKBENCH_MAX_CARDS + 1)
  })

  it('未知 id 报错而不是静默新建', () => {
    const src = source()
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [
        { id: 'b1', name: '页面 1', cards: [{ id: 'ghost', prompt: '鬼' }] },
        { id: 'bghost', name: '鬼页', cards: [] },
      ],
    })
    expect(plan.result.ok).toBe(true)
    expect(plan.result.cards.created).toEqual([])
    expect(plan.result.skipped.map((s) => s.reason).join('|')).toContain('卡片不存在: ghost')
    expect(plan.result.skipped.map((s) => s.reason).join('|')).toContain('页不存在: bghost')
  })

  it('同一 id 在 IR 里出现多次:第一处生效,其余记 skip', () => {
    const src = source({ cards: [card({ id: 'c1', boardId: 'b1', prompt: '原' })] })
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [{
        id: 'b1',
        name: '页面 1',
        cards: [{ id: 'c1', prompt: '第一处' }, { id: 'c1', prompt: '第二处' }],
      }],
    })
    expect(plan.next!.cards.filter((c) => c.id === 'c1')).toHaveLength(1)
    expect(plan.next!.cards[0].prompt).toBe('第一处')
    expect(plan.result.skipped.map((s) => s.reason).join()).toContain('同一张卡出现多次')
  })
})

describe('planApplyIR / 声明式改写', () => {
  it('改 prompt 记 updated,并按 IR 顺序重排 order', () => {
    const src = source({
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A' }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B' }),
      ],
    })
    const ir = roundTrip(src)
    ir.boards[0].cards.reverse()
    ir.boards[0].cards[0].prompt = 'B+'
    const plan = planApplyIR(src, ir)
    expect(plan.result.ok).toBe(true)
    expect(plan.result.cards.updated).toEqual(['c2'])
    expect(plan.result.cards.moved).toEqual(expect.arrayContaining(['c1', 'c2']))
    const byId = new Map(plan.next!.cards.map((c) => [c.id, c]))
    expect(byId.get('c2')!.order).toBe(0)
    expect(byId.get('c1')!.order).toBe(1)
    // 挪过位 = 结构变动
    expect(plan.result.structureRevision).toBe(1)
  })

  it('省略字段 = 回默认值(声明而非 patch)', () => {
    const src = source({
      cards: [card({ id: 'c1', boardId: 'b1', prompt: '猫', resolution: '1080p', duration: 12, seed: 7 })],
    })
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c1', prompt: '猫' }] }],
    })
    const next = plan.next!.cards[0]
    expect(next.resolution).toBe('720p')
    expect(next.duration).toBe(5)
    expect(next.seed).toBeUndefined()
  })

  it('原样 round-trip 不产生任何改动,也不 bump 任何令牌', () => {
    const src = source({
      structureRevision: 4,
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A', referenceImages: [{ name: 'x', src: 'data:image/png;base64,QQ' }] }),
        card({ id: 'c2', boardId: 'b2', order: 0, prompt: 'B', seed: 9 }),
      ],
    })
    const plan = planApplyIR(src, roundTrip(src))
    expect(plan.result).toMatchObject({
      ok: true,
      boards: { created: [], renamed: [], removed: [] },
      cards: { created: [], updated: [], moved: [], removed: [] },
      skipped: [],
      structureRevision: 4,
    })
    expect(plan.persist!.cards).toEqual([])
    expect(plan.persist!.boards).toEqual([])
  })

  it('wbref 占位保住内嵌字节,还能抄到另一张卡上复用', () => {
    const embedded = 'data:image/png;base64,QUJD'
    const src = source({
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A', referenceImages: [{ name: '内嵌', src: embedded }] }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B' }),
      ],
    })
    const ir = roundTrip(src)
    ir.boards[0].cards[1].referenceImages = [{ name: '复用', src: 'wbref://c1/referenceImages/0' }]
    const plan = planApplyIR(src, ir)
    const byId = new Map(plan.next!.cards.map((c) => [c.id, c]))
    expect(byId.get('c1')!.referenceImages[0].src).toBe(embedded)
    expect(byId.get('c2')!.referenceImages[0].src).toBe(embedded)
    expect(plan.result.cards.updated).toEqual(['c2'])
  })

  it('解析不出的 wbref 占位被丢掉并记 skip(不留死链)', () => {
    const src = source({ cards: [card({ id: 'c1', boardId: 'b1', prompt: 'A' })] })
    const ir = roundTrip(src)
    ir.boards[0].cards[0].referenceImages = [{ name: '幽灵', src: 'wbref://cX/referenceImages/3' }]
    const plan = planApplyIR(src, ir)
    expect(plan.next!.cards[0].referenceImages).toEqual([])
    expect(plan.result.skipped.map((s) => s.reason).join()).toContain('素材占位无法解析')
  })

  it('新建卡与新建页:无 id 即新建,顺序按数组', () => {
    const src = source()
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [
        { id: 'b1', name: '页面 1', cards: [] },
        { name: '第二幕', cards: [{ prompt: '镜 1' }, { prompt: '镜 2' }] },
      ],
    })
    expect(plan.result.boards.created).toHaveLength(1)
    expect(plan.result.cards.created).toHaveLength(2)
    const newBoardId = plan.result.boards.created[0]
    const onNew = plan.next!.cards.filter((c) => c.boardId === newBoardId).sort((a, b) => a.order - b.order)
    expect(onNew.map((c) => c.prompt)).toEqual(['镜 1', '镜 2'])
    expect(plan.next!.boards.map((b) => b.order)).toEqual([0, 1])
    expect(plan.persist!.cards).toHaveLength(2)
  })

  it('改页名记 renamed;IR 的页顺序决定页签顺序', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
    })
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [
        { id: 'b2', name: '开场', cards: [] },
        { id: 'b1', name: '页面 1', cards: [] },
      ],
    })
    expect(plan.result.boards.renamed).toEqual(['b2'])
    expect(plan.next!.boards.map((b) => [b.id, b.order, b.name])).toEqual([
      ['b2', 0, '开场'],
      ['b1', 1, '页面 1'],
    ])
    expect(plan.persist!.boards.map((b) => b.id).sort()).toEqual(['b1', 'b2'])
  })

  it('跨页搬卡:boardId 与 order 一起改写,两页 order 都压实', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A' }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B' }),
        card({ id: 'c3', boardId: 'b2', order: 0, prompt: 'C' }),
      ],
    })
    const ir = roundTrip(src)
    ir.boards[1].cards.unshift(ir.boards[0].cards.pop()!) // c2 → b2 首位
    const plan = planApplyIR(src, ir)
    const byId = new Map(plan.next!.cards.map((c) => [c.id, c]))
    expect(byId.get('c2')).toMatchObject({ boardId: 'b2', order: 0 })
    expect(byId.get('c3')).toMatchObject({ boardId: 'b2', order: 1 })
    expect(byId.get('c1')).toMatchObject({ boardId: 'b1', order: 0 })
    expect(plan.result.cards.moved).toEqual(expect.arrayContaining(['c2', 'c3']))
    expect(plan.result.cards.updated).toEqual([])
  })
})

describe('planApplyIR / merge vs replace', () => {
  it('merge:IR 没提到的页与卡原样保留,列出的卡排在前面', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A' }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B' }),
        card({ id: 'c3', boardId: 'b2', order: 0, prompt: 'C' }),
      ],
    })
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c2', prompt: 'B' }] }],
    })
    expect(plan.result.cards.removed).toEqual([])
    expect(plan.result.boards.removed).toEqual([])
    expect(plan.next!.boards.map((b) => b.id)).toEqual(['b1', 'b2'])
    const b1 = plan.next!.cards.filter((c) => c.boardId === 'b1').sort((a, b) => a.order - b.order)
    expect(b1.map((c) => c.id)).toEqual(['c2', 'c1'])
  })

  it('replace:IR 未列出的页与卡都删掉', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A' }),
        card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B' }),
        card({ id: 'c3', boardId: 'b2', order: 0, prompt: 'C' }),
      ],
    })
    const plan = planApplyIR(
      src,
      {
        irVersion: WORKBENCH_IR_VERSION,
        structureRevision: 0,
        boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c2', prompt: 'B' }] }],
      },
      { mode: 'replace' },
    )
    expect(plan.result.boards.removed).toEqual(['b2'])
    expect(plan.result.cards.removed.sort()).toEqual(['c1', 'c3'])
    expect(plan.next!.cards.map((c) => c.id)).toEqual(['c2'])
    expect(plan.persist!.removeCardIds.sort()).toEqual(['c1', 'c3'])
    expect(plan.persist!.removeBoardIds).toEqual(['b2'])
  })

  it('activeBoardId 指向被删的页时回落到第一页', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
      activeBoardId: 'b2',
    })
    const plan = planApplyIR(
      src,
      {
        irVersion: WORKBENCH_IR_VERSION,
        structureRevision: 0,
        activeBoardId: 'b2',
        boards: [{ id: 'b1', name: '页面 1', cards: [] }],
      },
      { mode: 'replace' },
    )
    expect(plan.next!.activeBoardId).toBe('b1')
  })

  it('IR 显式指定 activeBoardId 时切过去', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
    })
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      structureRevision: 0,
      activeBoardId: 'b2',
      boards: [{ id: 'b1', name: '页面 1', cards: [] }, { id: 'b2', name: '页面 2', cards: [] }],
    })
    expect(plan.next!.activeBoardId).toBe('b2')
    // 换页只是视图变化,不算结构变动 —— agent 手里的位置计划仍然有效
    expect(plan.result.structureRevision).toBe(0)
    expect(plan.next!.revision).toBe(1)
  })
})

describe('planApplyIR / 渲染中的卡片', () => {
  for (const status of ['preparing', 'queued', 'running'] as const) {
    it(`${status} 的卡规格定格不可改,但位置能动`, () => {
      const src = source({
        cards: [
          card({ id: 'c1', boardId: 'b1', order: 0, prompt: '在飞', status, taskId: 't-1' }),
          card({ id: 'c2', boardId: 'b1', order: 1, prompt: 'B' }),
        ],
      })
      const ir = roundTrip(src)
      ir.boards[0].cards.reverse()
      ir.boards[0].cards[1].prompt = '改不动'
      const plan = planApplyIR(src, ir)
      const c1 = plan.next!.cards.find((c) => c.id === 'c1')!
      expect(c1.prompt).toBe('在飞')
      expect(c1.order).toBe(1)
      expect(plan.result.cards.updated).toEqual([])
      expect(plan.result.cards.moved).toEqual(expect.arrayContaining(['c1', 'c2']))
      expect(plan.result.skipped.map((s) => s.reason).join()).toContain('规格已定格')
    })
  }

  it('渲染中的卡拒绝删除,并被挪到第一页末尾兜住', () => {
    const src = source({
      boards: [
        { id: 'b1', name: '页面 1', order: 0, createdAt: 1 },
        { id: 'b2', name: '页面 2', order: 1, createdAt: 1 },
      ],
      cards: [
        card({ id: 'c1', boardId: 'b1', order: 0, prompt: 'A' }),
        card({ id: 'c2', boardId: 'b2', order: 0, prompt: '在飞', status: 'running', taskId: 't-1' }),
      ],
    })
    const plan = planApplyIR(
      src,
      {
        irVersion: WORKBENCH_IR_VERSION,
        structureRevision: 0,
        boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c1', prompt: 'A' }] }],
      },
      { mode: 'replace' },
    )
    expect(plan.result.cards.removed).toEqual([])
    expect(plan.result.skipped.map((s) => s.reason).join()).toContain('拒绝删除')
    const c2 = plan.next!.cards.find((c) => c.id === 'c2')!
    expect(c2).toMatchObject({ boardId: 'b1', order: 1 })
    expect(plan.persist!.cards.map((c) => c.id)).toContain('c2')
  })
})
