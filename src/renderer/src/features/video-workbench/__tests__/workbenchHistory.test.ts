// 撤销栈纯逻辑单测:意图/运行时切分、复活、删新卡、渲染中定格、在飞卡停车、
// 上限守门、no-op 不消耗版本号、栈深上限。全部喂普通对象,不碰 store。

import { describe, expect, it } from 'vitest'
import type { VideoWorkbenchCard, VideoWorkbenchCardStatus } from '../../../../../types/videoWorkbench'
import { normalizeSpec } from '../cardSpec'
import {
  WORKBENCH_HISTORY_LIMIT,
  type WorkbenchHistorySource,
  type WorkbenchIntent,
  captureIntent,
  planRestore,
  pushHistory,
} from '../workbenchHistory'
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

function source(patch: Partial<WorkbenchHistorySource> = {}): WorkbenchHistorySource {
  return {
    boards: [{ id: 'b1', name: '页面 1', order: 0, createdAt: 1_000 }],
    cards: [],
    activeBoardId: 'b1',
    revision: 0,
    ...patch,
  }
}

describe('captureIntent', () => {
  it('浅拷贝数组:元素与 store 共享,但后续 push 不污染快照', () => {
    const src = source({ cards: [card({ id: 'c1', boardId: 'b1', prompt: '原' })] })
    const snap = captureIntent(src)

    src.cards.push(card({ id: 'c2', boardId: 'b1' }))

    expect(snap.cards).toHaveLength(1)
    expect(snap.cards[0]).toBe(src.cards[0])
  })
})

describe('pushHistory', () => {
  it('超出上限丢最老的一步', () => {
    let stack: WorkbenchIntent[] = []
    for (let i = 0; i < WORKBENCH_HISTORY_LIMIT + 5; i++) {
      stack = pushHistory(stack, captureIntent(source({ activeBoardId: `b${i}` })))
    }
    expect(stack).toHaveLength(WORKBENCH_HISTORY_LIMIT)
    expect(stack[0].activeBoardId).toBe('b5')
  })

  it('不改入参', () => {
    const stack: WorkbenchIntent[] = []
    pushHistory(stack, captureIntent(source()))
    expect(stack).toHaveLength(0)
  })
})

describe('planRestore', () => {
  it('还原规格但保留运行时字段:撤销不会让跑着的任务从卡片上消失', () => {
    const snapshot = captureIntent(
      source({ cards: [card({ id: 'c1', boardId: 'b1', prompt: '旧提示词' })] }),
    )
    // 快照之后:改了提示词、启动了生成 —— 卡片带上了 taskId / videoUrl
    const src = source({
      revision: 2,
      cards: [
        card({
          id: 'c1',
          boardId: 'b1',
          prompt: '新提示词',
          status: 'succeeded',
          taskId: 't-1',
          videoUrl: 'https://x/v.mp4',
          localPath: 'D:/v.mp4',
          historyRecorded: true,
        }),
      ],
    })

    const plan = planRestore(src, snapshot)

    expect(plan.result.ok).toBe(true)
    expect(plan.result.cards.restored).toEqual(['c1'])
    const restored = plan.next!.cards[0]
    expect(restored.prompt).toBe('旧提示词')
    // 运行时字段原样保留
    expect(restored.status).toBe('succeeded')
    expect(restored.taskId).toBe('t-1')
    expect(restored.videoUrl).toBe('https://x/v.mp4')
    expect(restored.localPath).toBe('D:/v.mp4')
    expect(restored.historyRecorded).toBe(true)
  })

  it('还原 seed 到「随机」:快照没种子就真的清掉,而不是被当前值顶回来', () => {
    const snapshot = captureIntent(source({ cards: [card({ id: 'c1', boardId: 'b1' })] }))
    const src = source({ revision: 1, cards: [card({ id: 'c1', boardId: 'b1', seed: 42 })] })

    const plan = planRestore(src, snapshot)

    expect(plan.next!.cards[0].seed).toBeUndefined()
    expect(Object.hasOwn(plan.next!.cards[0], 'seed')).toBe(false)
  })

  it('复活被删的卡片,整块带回 clientId/taskId(可重新接上仍在广播的任务)', () => {
    const snapshot = captureIntent(
      source({
        cards: [
          card({ id: 'c1', boardId: 'b1', prompt: '第一' }),
          card({
            id: 'c2',
            boardId: 'b1',
            order: 1,
            prompt: '第二',
            status: 'running',
            clientId: 'cl-2',
            taskId: 't-2',
          }),
        ],
      }),
    )
    const src = source({ revision: 1, cards: [card({ id: 'c1', boardId: 'b1', prompt: '第一' })] })

    const plan = planRestore(src, snapshot)

    expect(plan.result.cards.resurrected).toEqual(['c2'])
    const back = plan.next!.cards.find((c) => c.id === 'c2')!
    expect(back.clientId).toBe('cl-2')
    expect(back.taskId).toBe('t-2')
    expect(back.status).toBe('running')
    expect(back.order).toBe(1)
    expect(plan.persist!.cards.map((c) => c.id)).toContain('c2')
  })

  it('删掉快照之后新建的卡,并压实剩余卡的 order', () => {
    const snapshot = captureIntent(
      source({ cards: [card({ id: 'c1', boardId: 'b1', order: 0 })] }),
    )
    const src = source({
      revision: 1,
      cards: [
        card({ id: 'cNew', boardId: 'b1', order: 0 }),
        card({ id: 'c1', boardId: 'b1', order: 1 }),
      ],
    })

    const plan = planRestore(src, snapshot)

    expect(plan.result.cards.removed).toEqual(['cNew'])
    expect(plan.next!.cards.map((c) => c.id)).toEqual(['c1'])
    expect(plan.next!.cards[0].order).toBe(0)
    expect(plan.persist!.removeCardIds).toEqual(['cNew'])
  })

  it('正在生成的卡不删,停到第一页末尾并报告', () => {
    const snapshot = captureIntent(source({ cards: [] }))
    const src = source({
      revision: 1,
      cards: [
        card({ id: 'cRun', boardId: 'b1', status: 'running' }),
        card({ id: 'cDraft', boardId: 'b1', order: 1 }),
      ],
    })

    const plan = planRestore(src, snapshot)

    expect(plan.result.cards.removed).toEqual(['cDraft'])
    expect(plan.next!.cards.map((c) => c.id)).toEqual(['cRun'])
    expect(plan.next!.cards[0].order).toBe(0)
    expect(plan.result.skipped).toEqual([
      { cardId: 'cRun', reason: '卡片正在生成,拒绝删除(已保留在页面上)' },
    ])
  })

  it('正在生成的卡规格定格不回滚,但位置照样还原', () => {
    const snapshot = captureIntent(
      source({
        cards: [
          card({ id: 'cRun', boardId: 'b1', order: 0, prompt: '旧', status: 'running' }),
          card({ id: 'c2', boardId: 'b1', order: 1 }),
        ],
      }),
    )
    const src = source({
      revision: 1,
      cards: [
        card({ id: 'c2', boardId: 'b1', order: 0 }),
        card({ id: 'cRun', boardId: 'b1', order: 1, prompt: '提交时的新', status: 'running' }),
      ],
    })

    const plan = planRestore(src, snapshot)

    const back = plan.next!.cards.find((c) => c.id === 'cRun')!
    expect(back.prompt).toBe('提交时的新')
    expect(back.order).toBe(0)
    expect(plan.result.skipped).toEqual([
      { cardId: 'cRun', reason: '卡片正在生成,规格已定格不可回滚(位置已还原)' },
    ])
  })

  it('还原页:复活被删的页、删掉新建的页、改回页名', () => {
    const snapshot = captureIntent(
      source({
        boards: [
          { id: 'b1', name: '原名', order: 0, createdAt: 1 },
          { id: 'b2', name: '第二页', order: 1, createdAt: 1 },
        ],
        cards: [card({ id: 'c2', boardId: 'b2' })],
        activeBoardId: 'b2',
      }),
    )
    const src = source({
      revision: 3,
      boards: [
        { id: 'b1', name: '改过的名', order: 0, createdAt: 1 },
        { id: 'b3', name: '后来新建的', order: 1, createdAt: 2 },
      ],
      cards: [card({ id: 'c3', boardId: 'b3' })],
      activeBoardId: 'b3',
    })

    const plan = planRestore(src, snapshot)

    expect(plan.next!.boards.map((b) => [b.id, b.name, b.order])).toEqual([
      ['b1', '原名', 0],
      ['b2', '第二页', 1],
    ])
    expect(plan.result.boards.removed).toEqual(['b3'])
    expect(plan.result.boards.restored).toEqual(expect.arrayContaining(['b1', 'b2']))
    // b3 的卡跟着页一起没了,b2 的卡复活
    expect(plan.result.cards.removed).toEqual(['c3'])
    expect(plan.result.cards.resurrected).toEqual(['c2'])
    // 回到快照那一刻看的页,撤销才看得见效果
    expect(plan.next!.activeBoardId).toBe('b2')
  })

  it('意图完全一致 = no-op:不写盘,也不消耗版本号', () => {
    const src = source({ revision: 5, cards: [card({ id: 'c1', boardId: 'b1', prompt: '同' })] })
    const plan = planRestore(src, captureIntent(src))

    expect(plan.result.noop).toBe(true)
    expect(plan.result.revision).toBe(5)
    expect(plan.next).toBeUndefined()
    expect(plan.persist).toBeUndefined()
  })

  it('只改了位置也算变化,并只落盘动过的卡', () => {
    const snapshot = captureIntent(
      source({
        cards: [
          card({ id: 'c1', boardId: 'b1', order: 0 }),
          card({ id: 'c2', boardId: 'b1', order: 1 }),
          card({ id: 'c3', boardId: 'b1', order: 2 }),
        ],
      }),
    )
    const src = source({
      revision: 1,
      cards: [
        card({ id: 'c2', boardId: 'b1', order: 0 }),
        card({ id: 'c1', boardId: 'b1', order: 1 }),
        card({ id: 'c3', boardId: 'b1', order: 2 }),
      ],
    })

    const plan = planRestore(src, snapshot)

    expect(plan.next!.cards.map((c) => c.id)).toEqual(['c1', 'c2', 'c3'])
    // c3 位置没动,不该被重写
    expect(plan.persist!.cards.map((c) => c.id).sort()).toEqual(['c1', 'c2'])
    expect(plan.result.revision).toBe(2)
  })

  it('空快照拒绝还原,避免清空工作台', () => {
    const plan = planRestore(source(), { boards: [], cards: [], activeBoardId: 'b1' })
    expect(plan.result.ok).toBe(false)
    expect(plan.next).toBeUndefined()
    expect(plan.result.skipped[0].reason).toContain('清空工作台')
  })

  it('还原后超过卡片上限则整体拒绝,不静默淘汰旧卡', () => {
    const many = Array.from({ length: WORKBENCH_MAX_CARDS }, (_, i) =>
      card({ id: `s${i}`, boardId: 'b1', order: i }),
    )
    const snapshot = captureIntent(source({ cards: many }))
    // 当前:快照里那批全被删了,换成一批在飞的卡 —— 在飞的不能删,复活的又都要回来
    const src = source({
      revision: 1,
      cards: [card({ id: 'run', boardId: 'b1', status: 'running' })],
    })

    const plan = planRestore(src, snapshot)

    expect(plan.result.ok).toBe(false)
    expect(plan.next).toBeUndefined()
    expect(plan.result.skipped.at(-1)!.reason).toContain(`超过上限 ${WORKBENCH_MAX_CARDS}`)
  })
})
