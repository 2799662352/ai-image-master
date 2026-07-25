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

  it('带 irVersion 与 revision 令牌', () => {
    const ir = exportWorkbenchIR(source({ revision: 7 }))
    expect(ir.irVersion).toBe(WORKBENCH_IR_VERSION)
    expect(ir.revision).toBe(7)
    expect(ir.activeBoardId).toBe('b1')
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

  it('revision 过期时拒绝并回报冲突,什么都不写', () => {
    const src = source({ revision: 5, cards: [card({ id: 'c1', boardId: 'b1', prompt: '旧' })] })
    const ir = roundTrip(src)
    ir.revision = 3 // agent 手里是旧令牌
    ir.boards[0].cards[0].prompt = '新'
    const plan = planApplyIR(src, ir)
    expect(plan.result.ok).toBe(false)
    expect(plan.result.conflict).toEqual({ expected: 3, actual: 5 })
    expect(plan.next).toBeUndefined()
    expect(plan.result.revision).toBe(5)
  })

  it('force 可以越过 revision 校验', () => {
    const src = source({ revision: 5, cards: [card({ id: 'c1', boardId: 'b1', prompt: '旧' })] })
    const ir = roundTrip(src)
    ir.revision = 3
    ir.boards[0].cards[0].prompt = '新'
    const plan = planApplyIR(src, ir, { force: true })
    expect(plan.result.ok).toBe(true)
    expect(plan.result.cards.updated).toEqual(['c1'])
  })

  it('boards 为空 / 全是坏页时拒绝(否则等于清空工作台)', () => {
    expect(planApplyIR(source(), { irVersion: WORKBENCH_IR_VERSION, revision: 0, boards: [] }).result.ok).toBe(false)
    const allBad = planApplyIR(source(), {
      irVersion: WORKBENCH_IR_VERSION,
      revision: 0,
      boards: [{ name: '  ', cards: [] }],
    })
    expect(allBad.result.ok).toBe(false)
    expect(allBad.result.skipped.map((s) => s.reason).join()).toContain('没有一页可用')
  })

  it('超过卡片上限时整体拒绝,不静默淘汰旧卡', () => {
    const src = source()
    const ir = roundTrip(src)
    ir.boards[0].cards = Array.from({ length: WORKBENCH_MAX_CARDS + 1 }, (_, i) => ({ prompt: `镜 ${i}` }))
    const plan = planApplyIR(src, ir)
    expect(plan.result.ok).toBe(false)
    expect(plan.result.skipped.at(-1)!.reason).toContain('超过上限')
  })

  it('未知 id 报错而不是静默新建', () => {
    const src = source()
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      revision: 0,
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
      revision: 0,
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
    expect(plan.result.revision).toBe(1)
  })

  it('省略字段 = 回默认值(声明而非 patch)', () => {
    const src = source({
      cards: [card({ id: 'c1', boardId: 'b1', prompt: '猫', resolution: '1080p', duration: 12, seed: 7 })],
    })
    const plan = planApplyIR(src, {
      irVersion: WORKBENCH_IR_VERSION,
      revision: 0,
      boards: [{ id: 'b1', name: '页面 1', cards: [{ id: 'c1', prompt: '猫' }] }],
    })
    const next = plan.next!.cards[0]
    expect(next.resolution).toBe('720p')
    expect(next.duration).toBe(5)
    expect(next.seed).toBeUndefined()
  })

  it('原样 round-trip 不产生任何改动,也不 bump revision', () => {
    const src = source({
      revision: 4,
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
      revision: 4,
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
      revision: 0,
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
      revision: 0,
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
      revision: 0,
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
        revision: 0,
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
        revision: 0,
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
      revision: 0,
      activeBoardId: 'b2',
      boards: [{ id: 'b1', name: '页面 1', cards: [] }, { id: 'b2', name: '页面 2', cards: [] }],
    })
    expect(plan.next!.activeBoardId).toBe('b2')
    expect(plan.result.revision).toBe(1)
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
        revision: 0,
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
