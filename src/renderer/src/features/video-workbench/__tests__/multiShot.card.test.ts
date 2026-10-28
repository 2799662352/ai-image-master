// 可灵分镜在工作台数据层的落点:规格收敛 / 提交闸 / updateCard / IR 往返 / 工程文件 / 快照。
// (纯规则见 types/__tests__/klingMultiShot.test.ts;组包见 main/services/kling/__tests__/request.multiShot.test.ts。)

import { beforeEach, describe, expect, it } from 'vitest'
import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchCardStatus,
  VideoWorkbenchProject,
  WorkbenchIR,
} from '../../../../../types/videoWorkbench'
import type { KlingMultiShot } from '../../../../../types/klingMultiShot'
import { buildCard, conformMultiShot, normalizeSpec, pickSpec, specEquals } from '../cardSpec'
import { canStart, resetWorkbenchStoreForTest, snapshotCard, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'
import { exportWorkbenchIR, planApplyIR, type WorkbenchIRSource } from '../workbenchIR'
import { buildProjectFile, parseProjectFile, planImport } from '../projectFile'
import { buildTaskDetail } from '../taskDetail'
import { cardContentKey } from '../threadObservation'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

const SHOTS: KlingMultiShot = {
  type: 'customize',
  shots: [
    { prompt: '雨夜街头,人物回头', duration: 2 },
    { prompt: '特写:雨滴落在水洼里', duration: 3 },
  ],
}

const kling = (over: Record<string, unknown> = {}): VideoWorkbenchCard =>
  buildCard({ prompt: '', model: 'kling4', duration: 5, multiShot: SHOTS, ...over } as never, 0)

describe('normalizeSpec · 分镜只留给收它的模型', () => {
  it('可灵保留自定义分镜', () => {
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', multiShot: SHOTS }).multiShot).toEqual(SHOTS)
    expect(normalizeSpec({ model: 'kling4-omni', prompt: 'x', multiShot: { type: 'intelligence' } }).multiShot).toEqual({
      type: 'intelligence',
    })
  })

  it('Seedance / 万相丢掉它(留着只会让人以为生效了)', () => {
    for (const model of ['2.0', '2.5', 'wan3'] as const) {
      expect(normalizeSpec({ model, prompt: 'x', multiShot: SHOTS })).not.toHaveProperty('multiShot')
    }
  })

  it('off / null / 认不出的值 = 没有分镜,且不在规格上留 undefined 键', () => {
    for (const multiShot of [null, { type: 'off' }, 'customize', { type: 'customize' }, { type: 'customize', shots: [] }]) {
      expect(normalizeSpec({ model: 'kling4', prompt: 'x', multiShot: multiShot as never })).not.toHaveProperty('multiShot')
    }
  })

  it('镜头时长之和对不上总时长时不在这里悄悄修 —— 留给 canStart 明说', () => {
    const wrong: KlingMultiShot = { type: 'customize', shots: [{ prompt: 'a', duration: 1 }, { prompt: 'b', duration: 1 }] }
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', duration: 5, multiShot: wrong }).multiShot).toEqual(wrong)
  })

  it('pickSpec / specEquals 认分镜:改镜头描述就是规格变了', () => {
    const a = kling()
    const b = { ...a, multiShot: { type: 'customize', shots: [{ prompt: '改了', duration: 2 }, SHOTS.type === 'customize' ? SHOTS.shots[1] : { prompt: '', duration: 3 }] } as KlingMultiShot }
    expect(pickSpec(a).multiShot).toEqual(SHOTS)
    expect(specEquals(pickSpec(a), pickSpec(a))).toBe(true)
    expect(specEquals(pickSpec(a), pickSpec(b))).toBe(false)
    expect(specEquals(pickSpec(a), pickSpec({ ...a, multiShot: undefined }))).toBe(false)
  })
})

describe('conformMultiShot · 总时长 / 模型变了之后对齐镜头', () => {
  it('已对得上:原样返回同一个引用', () => {
    expect(conformMultiShot('kling4', 5, SHOTS)).toBe(SHOTS)
  })

  it('总时长变了:镜头时长按比例对齐,描述原样保留', () => {
    const out = conformMultiShot('kling4', 10, SHOTS)
    expect(out?.type).toBe('customize')
    if (out?.type !== 'customize') return
    expect(out.shots.map((s) => s.prompt)).toEqual(['雨夜街头,人物回头', '特写:雨滴落在水洼里'])
    expect(out.shots.reduce((n, s) => n + s.duration, 0)).toBe(10)
  })

  it('智能分镜原样;智能时长(-1)不动;不收分镜的模型 → 没有', () => {
    expect(conformMultiShot('kling4', 8, { type: 'intelligence' })).toEqual({ type: 'intelligence' })
    expect(conformMultiShot('kling4', -1, SHOTS)).toBe(SHOTS)
    expect(conformMultiShot('2.0', 5, SHOTS)).toBeUndefined()
    expect(conformMultiShot('kling4', 5, undefined)).toBeUndefined()
  })
})

describe('canStart · 分镜', () => {
  it('自定义分镜:总提示词可以空,镜头对得上就能提交', () => {
    const card = kling()
    expect(card.prompt).toBe('')
    expect(canStart(card).ok).toBe(true)
  })

  it('智能分镜:总提示词为空不行(模型靠它切镜头),有就行', () => {
    expect(canStart(kling({ multiShot: { type: 'intelligence' } })).ok).toBe(false)
    expect(canStart(kling({ multiShot: { type: 'intelligence' }, prompt: '雨夜追逐' })).ok).toBe(true)
  })

  it('没有分镜时空提示词照旧不能提交(这条放宽不外溢)', () => {
    const gate = canStart(buildCard({ prompt: '', model: 'kling4' }, 0))
    expect(gate).toEqual({ ok: false, reason: '提示词为空' })
  })

  it('时长之和对不上:说清当前几秒、总时长几秒', () => {
    const gate = canStart(kling({ duration: 8 }))
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/当前 5 秒.*视频总时长 8 秒/)
  })

  it('某个镜头描述为空 / 太长:指出是第几个镜头', () => {
    const empty = canStart(kling({ multiShot: { type: 'customize', shots: [{ prompt: 'a', duration: 2 }, { prompt: '  ', duration: 3 }] } }))
    expect(empty.reason).toContain('第 2 个镜头的描述不能为空')
    const long = canStart(kling({ multiShot: { type: 'customize', shots: [{ prompt: 'x'.repeat(513), duration: 5 }] } }))
    expect(long.reason).toContain('第 1 个镜头的描述不能超过 512 字')
  })

  it('绕过 buildCard 把分镜塞到不收它的模型上(旧卡 / 手改库):提交闸明说不支持', () => {
    const gate = canStart({ ...buildCard({ prompt: 'x', model: '2.0' }, 0), multiShot: SHOTS })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/不支持分镜/)
  })
})

describe('store.updateCard · 分镜', () => {
  const add = (input: Record<string, unknown>) => {
    const [id] = useVideoWorkbenchStore.getState().addCards([input as never])
    return id
  }
  const get = (id: string) => useVideoWorkbenchStore.getState().cards.find((c) => c.id === id)!
  const update = (id: string, patch: Record<string, unknown>) =>
    useVideoWorkbenchStore.getState().updateCard(id, patch as never)

  it('addCards 把分镜带进卡片', () => {
    const id = add({ prompt: '', model: 'kling4', duration: 5, multiShot: SHOTS })
    expect(get(id).multiShot).toEqual(SHOTS)
  })

  it('改总时长:自定义镜头自动对齐(不让用户先看一条「差几秒」的错误)', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    update(id, { duration: 10 })
    const ms = get(id).multiShot
    expect(ms?.type).toBe('customize')
    if (ms?.type !== 'customize') return
    expect(ms.shots.reduce((n, s) => n + s.duration, 0)).toBe(10)
    expect(canStart(get(id)).ok).toBe(true)
  })

  it('改提示词(逐字符触发)绝不动镜头时长', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    const before = get(id).multiShot
    update(id, { prompt: 'pp' })
    expect(get(id).prompt).toBe('pp')
    // 同一个引用:连「重新对齐了一遍恰好得到相同的值」都不算。
    expect(get(id).multiShot).toBe(before)
    expect(get(id).multiShot).toEqual(SHOTS)
  })

  it('用户正在手填镜头时长、合计暂时对不上:原样保留,由 canStart 说明', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    const mid: KlingMultiShot = { type: 'customize', shots: [{ prompt: 'a', duration: 1 }, { prompt: 'b', duration: 3 }] }
    update(id, { multiShot: mid })
    expect(get(id).multiShot).toEqual(mid)
    expect(canStart(get(id)).ok).toBe(false)
  })

  it('同一个 patch 里既改时长又显式给分镜:尊重显式值,不再对齐', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    const explicit: KlingMultiShot = { type: 'customize', shots: [{ prompt: 'a', duration: 4 }, { prompt: 'b', duration: 4 }] }
    update(id, { duration: 8, multiShot: explicit })
    expect(get(id).multiShot).toEqual(explicit)
  })

  it('null / off 清除分镜,且卡上不留一个值为 undefined 的键', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    update(id, { multiShot: null })
    expect(get(id)).not.toHaveProperty('multiShot')

    const id2 = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    update(id2, { multiShot: { type: 'off' } })
    expect(get(id2)).not.toHaveProperty('multiShot')
  })

  it('从可灵切到 Seedance:分镜被丢掉;切回来不会凭空长出来', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    update(id, { model: '2.0' })
    expect(get(id)).not.toHaveProperty('multiShot')
    update(id, { model: 'kling4' })
    expect(get(id)).not.toHaveProperty('multiShot')
  })

  it('不收分镜的模型上写分镜:忽略,不报错也不落库', () => {
    const id = add({ prompt: 'p', model: '2.0' })
    update(id, { multiShot: SHOTS })
    expect(get(id)).not.toHaveProperty('multiShot')
  })

  it('可灵 4.0 ↔ Omni 互切保留分镜', () => {
    const id = add({ prompt: 'p', model: 'kling4', duration: 5, multiShot: SHOTS })
    update(id, { model: 'kling4-omni' })
    expect(get(id).multiShot).toEqual(SHOTS)
  })
})

describe('IR · 分镜往返', () => {
  function card(patch: Partial<VideoWorkbenchCard> & { id: string; boardId: string }): VideoWorkbenchCard {
    return {
      order: 0,
      status: 'draft' as VideoWorkbenchCardStatus,
      createdAt: 1_000,
      updatedAt: 1_000,
      ...normalizeSpec({ prompt: patch.prompt ?? '', model: patch.model, duration: patch.duration, multiShot: patch.multiShot }),
      ...patch,
    }
  }
  const source = (cards: VideoWorkbenchCard[]): WorkbenchIRSource => ({
    boards: [{ id: 'b1', projectId: 'p1', name: '页面 1', order: 0, createdAt: 1_000 }],
    cards,
    activeProjectId: 'p1',
    activeBoardId: 'b1',
    revision: 0,
    structureRevision: 0,
  })
  const roundTrip = (src: WorkbenchIRSource): WorkbenchIR => JSON.parse(JSON.stringify(exportWorkbenchIR(src))) as WorkbenchIR

  it('导出带分镜;没有分镜的卡不带这个键', () => {
    const src = source([
      card({ id: 'c1', boardId: 'b1', model: 'kling4', duration: 5, multiShot: SHOTS, prompt: 'p' }),
      card({ id: 'c2', boardId: 'b1', order: 1, model: 'kling4', prompt: 'q' }),
    ])
    const [a, b] = exportWorkbenchIR(src).boards[0].cards
    expect(a.multiShot).toEqual(SHOTS)
    expect(b).not.toHaveProperty('multiShot')
  })

  it('原样 round-trip 不产生任何改动(分镜没有被当成「变了」)', () => {
    const src = source([card({ id: 'c1', boardId: 'b1', model: 'kling4', duration: 5, multiShot: SHOTS, prompt: 'p' })])
    const plan = planApplyIR(src, roundTrip(src))
    expect(plan.result.ok).toBe(true)
    expect(plan.result.cards.updated).toEqual([])
    expect(plan.result.skipped).toEqual([])
  })

  it('apply 能给已有卡加上 / 改掉 / 清掉分镜', () => {
    const src = source([card({ id: 'c1', boardId: 'b1', model: 'kling4', duration: 5, prompt: 'p' })])
    const ir = roundTrip(src)
    ir.boards[0].cards[0].multiShot = SHOTS
    const added = planApplyIR(src, ir)
    expect(added.result.cards.updated).toEqual(['c1'])
    expect(added.next!.cards[0].multiShot).toEqual(SHOTS)

    const withShots = source(added.next!.cards)
    const ir2 = roundTrip(withShots)
    ir2.boards[0].cards[0].multiShot = { type: 'off' } as never
    const cleared = planApplyIR(withShots, ir2)
    expect(cleared.result.cards.updated).toEqual(['c1'])
    expect(cleared.next!.cards[0]).not.toHaveProperty('multiShot')
  })

  it('apply 新建卡时带分镜;落在不收分镜的模型上被丢掉', () => {
    const src = source([])
    const plan = planApplyIR(src, {
      irVersion: roundTrip(src).irVersion,
      structureRevision: 0,
      boards: [{
        id: 'b1',
        projectId: 'p1',
        name: '页面 1',
        cards: [
          { prompt: '', model: 'kling4', duration: 5, multiShot: SHOTS },
          { prompt: 'x', model: '2.0', duration: 5, multiShot: SHOTS },
        ],
      }],
    })
    const [k, s] = plan.next!.cards.slice().sort((a, b) => a.order - b.order)
    expect(k.multiShot).toEqual(SHOTS)
    expect(s).not.toHaveProperty('multiShot')
  })

  it('只占位条目(只给 id)不碰分镜', () => {
    const src = source([card({ id: 'c1', boardId: 'b1', model: 'kling4', duration: 5, multiShot: SHOTS, prompt: 'p' })])
    const plan = planApplyIR(src, {
      irVersion: roundTrip(src).irVersion,
      structureRevision: 0,
      boards: [{ id: 'b1', projectId: 'p1', name: '页面 1', cards: [{ id: 'c1' }] }],
    })
    expect(plan.result.cards.updated).toEqual([])
    expect(plan.next!.cards[0].multiShot).toEqual(SHOTS)
  })

  it('改了分镜的卡被用户先改过(rev 过期):只跳过这张,并把分镜差异写进 reason', () => {
    const src = source([card({ id: 'c1', boardId: 'b1', model: 'kling4', duration: 5, multiShot: SHOTS, prompt: 'p', rev: 4 })])
    const ir = roundTrip(src)
    ir.boards[0].cards[0].rev = 2
    ir.boards[0].cards[0].multiShot = { type: 'intelligence' }
    const plan = planApplyIR(src, ir)
    expect(plan.result.cards.updated).toEqual([])
    expect(plan.result.skipped[0].reason).toContain('multiShot')
  })
})

describe('工程文件 · 分镜', () => {
  const project: VideoWorkbenchProject = { id: 'p1', name: '剧', order: 0, createdAt: 1, updatedAt: 2 }
  const boards: VideoWorkbenchBoard[] = [{ id: 'b1', projectId: 'p1', name: '页', order: 0, createdAt: 1 }]
  const app = { name: 'CATIMATION-Cyberpunk Master', version: '4.9.20' }

  it('导出 → 解析 → 导入计划:分镜原样往返;没有分镜的卡不带这个键', () => {
    const cards = [
      buildCard({ prompt: '', model: 'kling4', duration: 5, multiShot: SHOTS } as never, 0, 'b1'),
      buildCard({ prompt: 'x', model: 'kling4' }, 1, 'b1'),
    ]
    const built = buildProjectFile({ project, boards, cards, app, now: 0, resolve: () => null })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.file.boards[0].cards[0].multiShot).toEqual(SHOTS)
    expect(built.file.boards[0].cards[1]).not.toHaveProperty('multiShot')

    const parsed = parseProjectFile(JSON.stringify(built.file))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.boards[0].cards[0].multiShot).toEqual(SHOTS)

    const plan = planImport(parsed.file)
    expect(plan.boards[0].cards[0].input.multiShot).toEqual(SHOTS)
    expect(plan.boards[0].cards[1].input).not.toHaveProperty('multiShot')
  })

  it('文件里的分镜是坏数据:当没有,整份文件照样能打开', () => {
    const built = buildProjectFile({
      project,
      boards,
      cards: [buildCard({ prompt: 'x', model: 'kling4' }, 0, 'b1')],
      app,
      now: 0,
      resolve: () => null,
    })
    if (!built.ok) throw new Error('build failed')
    const doc = JSON.parse(JSON.stringify(built.file)) as { boards: Array<{ cards: Array<Record<string, unknown>> }> }
    doc.boards[0].cards[0].multiShot = { type: 'customize', shots: 'oops' }
    const parsed = parseProjectFile(JSON.stringify(doc))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.file.boards[0].cards[0]).not.toHaveProperty('multiShot')
  })
})

describe('快照 / 观察 / 任务详情', () => {
  it('status 快照带分镜,镜头描述截到 120 字(不撑大回包)', () => {
    const long = 'x'.repeat(300)
    const card = kling({ multiShot: { type: 'customize', shots: [{ prompt: long, duration: 2 }, { prompt: '短', duration: 3 }] } })
    const snap = snapshotCard(card)
    expect(snap.multiShot?.type).toBe('customize')
    if (snap.multiShot?.type !== 'customize') return
    expect(snap.multiShot.shots[0].prompt.length).toBeLessThanOrEqual(121)
    expect(snap.multiShot.shots[1]).toEqual({ prompt: '短', duration: 3 })
    expect(snapshotCard(buildCard({ prompt: 'x', model: 'kling4' }, 0))).not.toHaveProperty('multiShot')
  })

  it('观察指纹:分镜变了就是内容变了;没有分镜的卡指纹与改动前一致', () => {
    const a = kling()
    const b = kling({ multiShot: { type: 'customize', shots: [{ prompt: '换了', duration: 2 }, { prompt: '特写:雨滴落在水洼里', duration: 3 }] } })
    expect(cardContentKey(a)).not.toBe(cardContentKey(b))
    const plain = buildCard({ prompt: 'x', model: 'kling4' }, 0)
    expect(cardContentKey(plain)).toBe(cardContentKey({ ...plain }))
  })

  it('任务详情的请求里写出分镜(用户核对「到底发了什么」)', () => {
    const detail = buildTaskDetail(
      { ...kling(), status: 'running', taskId: 'task_k', billing: 'platform' },
      { index: 0 },
    )
    expect(JSON.stringify(detail)).toContain('雨夜街头')
  })
})
