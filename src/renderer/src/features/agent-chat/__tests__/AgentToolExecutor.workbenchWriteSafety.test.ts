import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useTabStore } from '../../../stores/useTabStore'
import { resetAssetPreviewCacheForTest } from '../../video-workbench/assetPreview'
import {
  resetWorkbenchStoreForTest,
  useVideoWorkbenchStore,
  versionSpecOf,
} from '../../video-workbench/store'
import { resetWorkbenchDbForTest } from '../../video-workbench/WorkbenchDb'
import { resetThreadScopesForTest } from '../../video-workbench/threadScope'

/**
 * 多个对话同时写同一个工作台时的「写入安全」:
 *   1. add_tasks 的 clientRef 幂等(重试 / 两个对话撞同一镜不重复建卡)
 *   2. 整页 start 默认不重跑「出过片且没改过」的卡(避免重复花钱)
 *   3. 回执:落点 + 「自你上次调用以来别人改了什么」
 *   4. 单卡写入的可选 expectedRev(带版本才写,不符就拒并回当前内容)
 */

function callTool(
  toolName: string,
  params: Record<string, unknown>,
  threadId?: string,
): Promise<any> {
  return (
    new AgentToolExecutor() as unknown as {
      callVideoWorkbench: (n: string, p: Record<string, unknown>, t?: string) => Promise<any>
    }
  ).callVideoWorkbench(toolName, params, threadId)
}

const S = () => useVideoWorkbenchStore.getState()

beforeEach(async () => {
  resetThreadScopesForTest()
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  resetAssetPreviewCacheForTest()
  useTabStore.setState({ activeTab: 'generate', previousTab: null })
  await S().ensureHydrated()
})

afterEach(() => {
  delete (window as any).electronAPI
})

/** 把一张卡摆成「已出片」:状态 succeeded,并留下与当前规格一致的版本存档。 */
function markSucceeded(id: string, opts: { withVersion?: boolean } = {}): void {
  useVideoWorkbenchStore.setState((s) => ({
    cards: s.cards.map((c) =>
      c.id !== id
        ? c
        : {
            ...c,
            status: 'succeeded' as const,
            localPath: 'D:/out.mp4',
            versions:
              opts.withVersion === false
                ? undefined
                : [{ id: 'v1', seq: 1, createdAt: 1, localPath: 'D:/out.mp4', spec: versionSpecOf(c) }],
          },
    ),
  }))
}

describe('add_tasks clientRef 幂等', () => {
  it('同一个 clientRef 重发:不重复建卡,回执指出已存在的那张', async () => {
    const first = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第 12 镜', clientRef: 'shot-12' }],
      navigate: false,
    })
    expect(first.cardIds).toHaveLength(1)
    expect(first.duplicates).toBeUndefined()

    const retry = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第 12 镜', clientRef: 'shot-12' }],
      navigate: false,
    })
    expect(retry.cardIds).toEqual([])
    expect(retry.duplicates).toEqual([
      expect.objectContaining({
        clientRef: 'shot-12',
        cardId: first.cardIds[0],
        samePrompt: true,
        status: 'draft',
      }),
    ])
    expect(retry.hint).toMatch(/已存在/)
    expect(S().cards).toHaveLength(1)
    // 回包照旧带全局摘要
    expect(retry.total).toBe(1)
  })

  it('同 clientRef 但提示词不同:不新建也不覆盖,samePrompt:false 让模型自己决定', async () => {
    const first = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '原稿', clientRef: 'shot-1' }],
      navigate: false,
    })
    const again = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '改过的稿', clientRef: 'shot-1' }],
      navigate: false,
    })
    expect(again.cardIds).toEqual([])
    expect(again.duplicates[0]).toMatchObject({ cardId: first.cardIds[0], samePrompt: false })
    expect(S().cards[0].prompt).toBe('原稿')
  })

  it('一批里有已存在的和新的:只建新的,按顺序回 cardIds', async () => {
    const first = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'A', clientRef: 'a' }],
      navigate: false,
    })
    const mixed = await callTool('video_workbench_add_tasks', {
      tasks: [
        { prompt: 'A', clientRef: 'a' },
        { prompt: 'B', clientRef: 'b' },
        { prompt: 'C' },
      ],
      navigate: false,
    })
    expect(mixed.cardIds).toHaveLength(2)
    expect(mixed.duplicates).toHaveLength(1)
    expect(mixed.duplicates[0].cardId).toBe(first.cardIds[0])
    expect(S().cards.map((c) => c.prompt)).toEqual(['A', 'B', 'C'])
  })

  it('同一次调用里的重复 clientRef 只留第一个', async () => {
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [
        { prompt: 'X1', clientRef: 'x' },
        { prompt: 'X2', clientRef: 'x' },
      ],
      navigate: false,
    })
    expect(r.cardIds).toHaveLength(1)
    expect(r.duplicates).toHaveLength(1)
    expect(S().cards).toHaveLength(1)
    expect(S().cards[0].prompt).toBe('X1')
  })

  it('clientRef 只在同一分段内唯一:第 2 集的第 1 镜不会撞上第 1 集的第 1 镜', async () => {
    const b1 = S().activeBoardId
    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第 1 集第 1 镜', clientRef: 'shot-1' }],
      navigate: false,
    })
    const b2 = S().addBoard('第 2 集')
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第 2 集第 1 镜', clientRef: 'shot-1' }],
      boardId: b2,
      navigate: false,
    })
    expect(r.cardIds).toHaveLength(1)
    expect(r.duplicates).toBeUndefined()
    expect(r.placed.boardId).toBe(b2)
    expect(S().cards.filter((c) => c.boardId === b1)).toHaveLength(1)
    expect(S().cards.filter((c) => c.boardId === b2)).toHaveLength(1)

    // 同一分段里再发才是重放
    const replay = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '第 2 集第 1 镜', clientRef: 'shot-1' }],
      boardId: b2,
      navigate: false,
    })
    expect(replay.cardIds).toEqual([])
    expect(replay.duplicates).toHaveLength(1)
  })

  it('clientRef 在别的剧里同编号也照样新建', async () => {
    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '甲剧第 1 镜', clientRef: 'shot-1' }],
      navigate: false,
    })
    await callTool('video_workbench_create_project', { name: '乙剧' }, 'thread-b')
    const r = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: '乙剧第 1 镜', clientRef: 'shot-1' }], navigate: false },
      'thread-b',
    )
    expect(r.cardIds).toHaveLength(1)
    expect(r.duplicates).toBeUndefined()
    expect(S().cards).toHaveLength(2)
  })

  it('卡被删掉后,同 clientRef 可以重新建(幂等键随卡存亡)', async () => {
    const first = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '镜头', clientRef: 'k' }],
      navigate: false,
    })
    await callTool('video_workbench_remove_tasks', { cardIds: first.cardIds })
    const again = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '镜头', clientRef: 'k' }],
      navigate: false,
    })
    expect(again.cardIds).toHaveLength(1)
    expect(again.duplicates).toBeUndefined()
  })

  it('重放不会重复提交:autoStart 只启动这次新建的卡', async () => {
    const submit = vi.fn(async () => ({ success: true, taskId: 't-1' }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }
    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '猫', clientRef: 'cat' }],
      navigate: false,
      autoStart: true,
    })
    expect(submit).toHaveBeenCalledTimes(1)

    const replay = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '猫', clientRef: 'cat' }],
      navigate: false,
      autoStart: true,
    })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(replay.cardIds).toEqual([])
  })

  it('空白 clientRef 当作没给(不参与去重);超长直接报错而不是悄悄截断', async () => {
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [
        { prompt: 'p1', clientRef: '   ' },
        { prompt: 'p2', clientRef: '' },
      ],
      navigate: false,
    })
    expect(r.cardIds).toHaveLength(2)
    await expect(
      callTool('video_workbench_add_tasks', {
        tasks: [{ prompt: 'p3', clientRef: 'x'.repeat(65) }],
        navigate: false,
      }),
    ).rejects.toThrow(/clientRef/)
  })

  it('status 回 clientRef(上下文丢了也能按镜号找回卡)', async () => {
    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '镜', clientRef: 'shot-7' }, { prompt: '无编号' }],
      navigate: false,
    })
    const status = await callTool('video_workbench_status', {})
    expect(status.cards[0].clientRef).toBe('shot-7')
    expect(status.cards[1].clientRef).toBeUndefined()
    const concise = await callTool('video_workbench_status', { fields: 'concise' })
    expect(concise.cards[0].clientRef).toBe('shot-7')
  })
})

describe('add_tasks 回执:落点', () => {
  it('追加:回这页里的起止位置(0 起,与 move_task 同口径)', async () => {
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'A' }], navigate: false })
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'B' }, { prompt: 'C' }],
      navigate: false,
    })
    expect(r.placed).toMatchObject({ firstIndex: 1, lastIndex: 2 })
    expect(r.placed.boardId).toBe(S().activeBoardId)
  })

  it('插到锚点之后:落点是插入后的真实位置', async () => {
    const a = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'A' }, { prompt: 'B' }],
      navigate: false,
    })
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'M' }],
      afterCardId: a.cardIds[0],
      navigate: false,
    })
    expect(r.placed).toMatchObject({ firstIndex: 1, lastIndex: 1 })
  })

  it('全是重放时没有落点(什么都没写)', async () => {
    await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'A', clientRef: 'a' }],
      navigate: false,
    })
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'A', clientRef: 'a' }],
      navigate: false,
    })
    expect(r.placed).toBeUndefined()
  })
})

describe('整页 start 默认跳过「出过片且没改过」的卡', () => {
  let submit: ReturnType<typeof vi.fn>
  beforeEach(() => {
    let n = 0
    submit = vi.fn(async () => ({ success: true, taskId: `t-${++n}` }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }
  })

  const addTwo = async () => {
    const r = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '已出片的' }, { prompt: '还是草稿的' }],
      navigate: false,
    })
    return r.cardIds as string[]
  }

  it('不点名 cardIds:已出片的不重跑,回执说明跳过了几张和怎么重跑', async () => {
    const [done, draft] = await addTwo()
    markSucceeded(done)

    const r = await callTool('video_workbench_start', {})
    expect(r.started).toEqual([draft])
    expect(submit).toHaveBeenCalledTimes(1)
    expect(r.skippedSucceeded).toBe(1)
    expect(r.note).toMatch(/cardIds|includeSucceeded/)
  })

  it('出片之后改过提示词的卡仍会重跑(改完再整页启动是常见流程)', async () => {
    const [done] = await addTwo()
    markSucceeded(done)
    S().updateCard(done, { prompt: '改过的提示词' })

    const r = await callTool('video_workbench_start', {})
    expect(r.started).toContain(done)
    expect(r.skippedSucceeded).toBeUndefined()
  })

  it('出片之后改过规格(分辨率)的卡也重跑', async () => {
    const [done] = await addTwo()
    markSucceeded(done)
    S().updateCard(done, { resolution: '1080p' })
    const r = await callTool('video_workbench_start', {})
    expect(r.started).toContain(done)
  })

  it('点名 cardIds:照常重跑(用户或模型明确要重做)', async () => {
    const [done] = await addTwo()
    markSucceeded(done)
    const r = await callTool('video_workbench_start', { cardIds: [done] })
    expect(r.started).toEqual([done])
    expect(r.skippedSucceeded).toBeUndefined()
  })

  it('includeSucceeded:true:整页全部重跑', async () => {
    const [done, draft] = await addTwo()
    markSucceeded(done)
    const r = await callTool('video_workbench_start', { includeSucceeded: true })
    expect(r.started.sort()).toEqual([done, draft].sort())
  })

  it('失败的卡照常重跑', async () => {
    const [done] = await addTwo()
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === done ? { ...c, status: 'failed' as const, error: 'x' } : c)),
    }))
    const r = await callTool('video_workbench_start', {})
    expect(r.started).toContain(done)
  })

  it('成功但没有版本存档(老数据):查不出有没有改过,保守跳过而不是再花一次钱', async () => {
    const [done] = await addTwo()
    markSucceeded(done, { withVersion: false })
    const r = await callTool('video_workbench_start', {})
    expect(r.started).not.toContain(done)
    expect(r.skippedSucceeded).toBe(1)
  })

  it('用户在界面上选中的卡算明确点名:选中已出片的卡再启动会重跑', async () => {
    const [done] = await addTwo()
    markSucceeded(done)
    S().selectCard(done)
    expect(S().selectedCardIds).toEqual([done])
    const r = await callTool('video_workbench_start', {})
    expect(r.started).toEqual([done])
    expect(r.skippedSucceeded).toBeUndefined()
  })
})

describe('单卡写入的 expectedRev', () => {
  it('status / update_task 回 rev;带着刚拿到的 rev 写能成功,并拿到新 rev', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '旧' }],
      navigate: false,
    })
    const status = await callTool('video_workbench_status', {})
    expect(status.cards[0].rev).toBe(0)
    const concise = await callTool('video_workbench_status', { fields: 'concise' })
    expect(concise.cards[0].rev).toBe(0)

    const u1 = await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      resolution: '1080p',
      expectedRev: 0,
    })
    expect(u1.ok).toBe(true)
    expect(u1.card.rev).toBe(1)

    // 用回执里的新 rev 接着写,不必先 status
    const u2 = await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      ratio: '9:16',
      expectedRev: u1.card.rev,
    })
    expect(u2.ok).toBe(true)
    expect(u2.card.rev).toBe(2)
  })

  it('rev 过期:不写,回 ok:false + 冲突 + 这张卡当前的样子,模型据此重新决定', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '原提示词' }],
      navigate: false,
    })
    // 别人(用户/另一个对话)在 agent 看过之后改了这张卡
    S().updateCard(cardIds[0], { prompt: '别人改过的提示词' })

    const r = await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      prompt: '我以为还是原稿,基于它改的',
      expectedRev: 0,
    })
    expect(r.ok).toBe(false)
    expect(r.conflict).toEqual({ expectedRev: 0, currentRev: 1 })
    expect(r.card).toMatchObject({ cardId: cardIds[0], prompt: '别人改过的提示词', rev: 1 })
    expect(r.hint).toMatch(/重新|再/)
    expect(S().cards[0].prompt).toBe('别人改过的提示词')
  })

  it('不带 expectedRev:行为与以前完全一致(最后写入者赢)', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '原' }],
      navigate: false,
    })
    S().updateCard(cardIds[0], { prompt: '别人改的' })
    const r = await callTool('video_workbench_update_task', { cardId: cardIds[0], prompt: '我的' })
    expect(r.ok).toBe(true)
    expect(S().cards[0].prompt).toBe('我的')
  })

  it('后台事件把 rev 推高但内容没变:冲突回包带当前卡,用新 rev 一次重试就成功', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: '内容没变' }],
      navigate: false,
    })
    // 素材转存完成这类后台事件:rev +1,规格内容一个字不变
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === cardIds[0] ? { ...c, rev: (c.rev ?? 0) + 1 } : c)),
    }))
    const first = await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      resolution: '1080p',
      expectedRev: 0,
    })
    expect(first.ok).toBe(false)
    expect(first.card.prompt).toBe('内容没变')
    const retry = await callTool('video_workbench_update_task', {
      cardId: cardIds[0],
      resolution: '1080p',
      expectedRev: first.conflict.currentRev,
    })
    expect(retry.ok).toBe(true)
    expect(S().cards[0].resolution).toBe('1080p')
  })

  it('set_spec 的 expectedRevs:过期的那张跳过并回当前值,其余照改', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'A' }, { prompt: 'B' }],
      navigate: false,
    })
    S().updateCard(cardIds[0], { resolution: '480p' }) // 别人动过 A:rev 0 → 1

    const r = await callTool('video_workbench_set_spec', {
      cardIds,
      resolution: '1080p',
      expectedRevs: { [cardIds[0]]: 0, [cardIds[1]]: 0 },
    })
    expect(r.updated).toEqual([cardIds[1]])
    expect(r.skipped).toEqual([
      expect.objectContaining({
        cardId: cardIds[0],
        conflict: { expectedRev: 0, currentRev: 1 },
        current: expect.objectContaining({ resolution: '480p' }),
      }),
    ])
    const [a, b] = S().cards
    expect(a.resolution).toBe('480p')
    expect(b.resolution).toBe('1080p')
  })

  it('set_spec 没给 expectedRevs 的卡不受约束', async () => {
    const { cardIds } = await callTool('video_workbench_add_tasks', {
      tasks: [{ prompt: 'A' }, { prompt: 'B' }],
      navigate: false,
    })
    const r = await callTool('video_workbench_set_spec', {
      cardIds,
      duration: 8,
      expectedRevs: { [cardIds[0]]: 0 },
    })
    expect(r.updated).toHaveLength(2)
  })
})

describe('自你上次调用以来别人改了什么(changedSinceYourLastCall)', () => {
  /** 两个对话绑在同一部剧里(屏幕上的默认剧)。 */
  const bothOnDefault = async () => {
    await callTool('video_workbench_switch_project', { projectId: 'project-default', focus: false }, 'thread-a')
    await callTool('video_workbench_switch_project', { projectId: 'project-default', focus: false }, 'thread-b')
  }

  it('另一个对话改了卡:我的下一次调用带上增量,再下一次就没有了', async () => {
    await bothOnDefault()
    const added = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: 'A' }, { prompt: 'B' }], navigate: false },
      'thread-a',
    )
    await callTool('video_workbench_status', {}, 'thread-a')

    await callTool('video_workbench_update_task', { cardId: added.cardIds[0], prompt: 'A 被 B 改了' }, 'thread-b')

    const seen = await callTool('video_workbench_status', {}, 'thread-a')
    expect(seen.changedSinceYourLastCall).toEqual({
      edited: { count: 1, ids: [added.cardIds[0]] },
    })
    const again = await callTool('video_workbench_status', {}, 'thread-a')
    expect(again.changedSinceYourLastCall).toBeUndefined()
  })

  it('写入的回包同样带增量,而且在写入生效之前算(不把我自己这次写入算成别人的)', async () => {
    await bothOnDefault()
    const a1 = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: 'A' }], navigate: false },
      'thread-a',
    )
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'B 的' }], navigate: false }, 'thread-b')

    const a2 = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: 'A 的第二张' }], navigate: false },
      'thread-a',
    )
    // 看到的是 B 加的那张,不含自己刚加的
    expect(a2.changedSinceYourLastCall.added.count).toBe(1)
    expect(a2.changedSinceYourLastCall.added.ids).not.toContain(a2.cardIds[0])
    expect(a2.changedSinceYourLastCall.added.ids).not.toContain(a1.cardIds[0])
  })

  it('自己的写入不会在下一次调用里被当成「别人改的」', async () => {
    await bothOnDefault()
    const added = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: 'A' }], navigate: false },
      'thread-a',
    )
    await callTool('video_workbench_update_task', { cardId: added.cardIds[0], prompt: 'A2' }, 'thread-a')
    const next = await callTool('video_workbench_status', {}, 'thread-a')
    expect(next.changedSinceYourLastCall).toBeUndefined()
  })

  it('别人删了卡 / 加了卡 / 挪了顺序,分别报 removed / added / reordered', async () => {
    await bothOnDefault()
    const seed = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: '1' }, { prompt: '2' }, { prompt: '3' }], navigate: false },
      'thread-a',
    )
    await callTool('video_workbench_status', {}, 'thread-a')

    await callTool('video_workbench_remove_tasks', { cardIds: [seed.cardIds[0]] }, 'thread-b')
    const afterRemove = await callTool('video_workbench_status', {}, 'thread-a')
    expect(afterRemove.changedSinceYourLastCall).toEqual({
      removed: { count: 1, ids: [seed.cardIds[0]] },
    })

    const addedByB = await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '4' }], navigate: false }, 'thread-b')
    const afterAdd = await callTool('video_workbench_status', {}, 'thread-a')
    expect(afterAdd.changedSinceYourLastCall).toEqual({
      added: { count: 1, ids: addedByB.cardIds },
    })

    await callTool('video_workbench_move_task', { cardId: seed.cardIds[2], toIndex: 0 }, 'thread-b')
    const afterMove = await callTool('video_workbench_status', {}, 'thread-a')
    expect(afterMove.changedSinceYourLastCall).toEqual({ reordered: [S().activeBoardId] })
  })

  it('后台把 rev 推高、或者卡的状态在推进:不算别人改了内容,不出声', async () => {
    await bothOnDefault()
    const { cardIds } = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: 'A' }], navigate: false },
      'thread-a',
    )
    await callTool('video_workbench_status', {}, 'thread-a')
    useVideoWorkbenchStore.setState((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardIds[0] ? { ...c, rev: (c.rev ?? 0) + 3, status: 'running' as const } : c,
      ),
    }))
    const r = await callTool('video_workbench_status', {}, 'thread-a')
    expect(r.changedSinceYourLastCall).toBeUndefined()
  })

  it('一次最多列 8 个 id,count 仍是真实数量', async () => {
    await bothOnDefault()
    await callTool('video_workbench_status', {}, 'thread-a')
    const many = Array.from({ length: 12 }, (_, i) => ({ prompt: `P${i}` }))
    await callTool('video_workbench_add_tasks', { tasks: many, navigate: false }, 'thread-b')
    const r = await callTool('video_workbench_status', {}, 'thread-a')
    expect(r.changedSinceYourLastCall.added.count).toBe(12)
    expect(r.changedSinceYourLastCall.added.ids).toHaveLength(8)
  })

  it('第一次调用(没有基线)和没有 threadId 的调用都不带增量', async () => {
    const first = await callTool('video_workbench_status', {}, 'thread-a')
    expect(first.changedSinceYourLastCall).toBeUndefined()

    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'A' }], navigate: false })
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'B' }], navigate: false })
    const legacy = await callTool('video_workbench_status', {})
    expect(legacy.changedSinceYourLastCall).toBeUndefined()
  })

  it('换了一部剧:不拿上一部剧的基线去比', async () => {
    await bothOnDefault()
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'A' }], navigate: false }, 'thread-a')
    await callTool('video_workbench_status', {}, 'thread-a')
    const created = await callTool('video_workbench_create_project', { name: '新剧' }, 'thread-a')
    expect(created.changedSinceYourLastCall).toBeUndefined()
    const r = await callTool('video_workbench_status', {}, 'thread-a')
    expect(r.changedSinceYourLastCall).toBeUndefined()
  })

  it('同一对话并行发出的几次调用:只有第一次带增量,其余不带(分不清是谁写的)', async () => {
    await bothOnDefault()
    const added = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: 'A' }], navigate: false },
      'thread-a',
    )
    await callTool('video_workbench_status', {}, 'thread-a')
    await callTool('video_workbench_update_task', { cardId: added.cardIds[0], prompt: 'B 改的' }, 'thread-b')

    const [r1, r2] = await Promise.all([
      callTool('video_workbench_status', {}, 'thread-a'),
      callTool('video_workbench_status', {}, 'thread-a'),
    ])
    const withDelta = [r1, r2].filter((r) => r.changedSinceYourLastCall !== undefined)
    expect(withDelta).toHaveLength(1)
    expect(r1.changedSinceYourLastCall).toBeDefined()
    // 并行批结束后基线已推进,下一次不再重复报
    const after = await callTool('video_workbench_status', {}, 'thread-a')
    expect(after.changedSinceYourLastCall).toBeUndefined()
  })

  it('同一部剧里另一个对话在另一段的动作不打扰我(基线按分段记)', async () => {
    const { b1, b2 } = twoEpisodes()
    await pin('thread-a', b1)
    await pin('thread-b', b2)
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '1-1' }], navigate: false }, 'thread-a')
    await callTool('video_workbench_status', {}, 'thread-a')

    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '2-1' }, { prompt: '2-2' }], navigate: false }, 'thread-b')
    const r = await callTool('video_workbench_status', {}, 'thread-a')
    expect(r.changedSinceYourLastCall).toBeUndefined()
  })
})

/** 同一部剧(屏幕上的默认剧)里有两集,屏幕停在第 1 集。 */
function twoEpisodes() {
  const b1 = S().activeBoardId
  const b2 = S().addBoard('第 2 集')
  S().switchBoard(b1)
  return { b1, b2 }
}

const pin = (threadId: string, boardId: string) =>
  callTool('video_workbench_switch_project', { projectId: 'project-default', boardId, focus: false }, threadId)

describe('同一部剧里各管一个分段(board binding)', () => {
  it('switch_project 带 boardId:之后不带 boardId 的写入落在各自那一集,屏幕不动', async () => {
    const { b1, b2 } = twoEpisodes()
    const a = await pin('thread-a', b1)
    const b = await pin('thread-b', b2)
    expect(a.yourBoardId).toBe(b1)
    expect(b.yourBoardId).toBe(b2)

    const ra = await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第 1 集' }], navigate: false }, 'thread-a')
    const rb = await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第 2 集' }], navigate: false }, 'thread-b')
    expect(ra.placed.boardId).toBe(b1)
    expect(rb.placed.boardId).toBe(b2)
    expect(S().cards.filter((c) => c.boardId === b1).map((c) => c.prompt)).toEqual(['第 1 集'])
    expect(S().cards.filter((c) => c.boardId === b2).map((c) => c.prompt)).toEqual(['第 2 集'])
    expect(S().activeBoardId).toBe(b1)

    // 读也只看自己那一集
    const status = await callTool('video_workbench_status', {}, 'thread-b')
    expect(status.activeBoardId).toBe(b2)
    expect(status.cards.map((c: { prompt: string }) => c.prompt)).toEqual(['第 2 集'])
  })

  it('用户在屏幕上翻页:钉过分段的对话照写自己那一集', async () => {
    const { b1, b2 } = twoEpisodes()
    await pin('thread-a', b1)
    S().switchBoard(b2) // 用户翻到第 2 集
    const r = await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'A 的' }], navigate: false }, 'thread-a')
    expect(r.placed.boardId).toBe(b1)
  })

  it('switch_project 的回包把别的对话占着的分段标出来', async () => {
    const { b1, b2 } = twoEpisodes()
    await pin('thread-a', b1)
    const b = await callTool('video_workbench_switch_project', { projectId: 'project-default', focus: false }, 'thread-b')
    const byId = Object.fromEntries(b.boards.map((x: { id: string }) => [x.id, x]))
    expect(byId[b1].inUseByOtherChat).toBe(true)
    expect(byId[b2].inUseByOtherChat).toBeUndefined()
  })

  it('只绑了剧、隐式落点是别人占着的那一集:写入被拦并指路;点名 boardId 的写入放行', async () => {
    const { b1, b2 } = twoEpisodes()
    await pin('thread-a', b1)
    await callTool('video_workbench_switch_project', { projectId: 'project-default', focus: false }, 'thread-b')

    await expect(
      callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'oops' }], navigate: false }, 'thread-b'),
    ).rejects.toThrow(/boardId.*switch_project|switch_project.*boardId/s)
    expect(S().cards).toHaveLength(0)

    const ok = await callTool(
      'video_workbench_add_tasks',
      { tasks: [{ prompt: '显式' }], boardId: b2, navigate: false },
      'thread-b',
    )
    expect(ok.placed.boardId).toBe(b2)
    // 读不拦
    await expect(callTool('video_workbench_status', {}, 'thread-b')).resolves.toBeTruthy()
  })

  it('switch_project 带的 boardId 不属于这部剧:报错,不改绑定', async () => {
    const { b1 } = twoEpisodes()
    await pin('thread-a', b1)
    const other = await callTool('video_workbench_create_project', { name: '乙剧' }, 'thread-c')
    await expect(
      callTool('video_workbench_switch_project', { projectId: 'project-default', boardId: other.boardId }, 'thread-a'),
    ).rejects.toThrow(/不在/)
    const ra = await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '仍在第 1 集' }], navigate: false }, 'thread-a')
    expect(ra.placed.boardId).toBe(b1)
  })

  it('start 不点名:只启动自己那一集,另一集和屏幕上的选中都不碰', async () => {
    const submit = vi.fn(async () => ({ success: true, taskId: 't' }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }
    const { b1, b2 } = twoEpisodes()
    await pin('thread-a', b1)
    await pin('thread-b', b2)
    const [a1] = (await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'A-1' }], navigate: false }, 'thread-a')).cardIds
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: 'B-1' }, { prompt: 'B-2' }], navigate: false }, 'thread-b')
    S().selectCard(a1)

    const r = await callTool('video_workbench_start', {}, 'thread-b')
    expect(r.started).toHaveLength(2)
    const sent = submit.mock.calls.map((c: unknown[]) => (c[0] as { prompt: string }).prompt).sort()
    expect(sent).toEqual(['B-1', 'B-2'])
    expect(S().cards.find((c) => c.id === a1)!.status).toBe('draft')
    expect(S().selectedCardIds).toEqual([a1])
  })

  it('整页 start 的「跳过已出片」在非屏幕那一集同样生效', async () => {
    const submit = vi.fn(async () => ({ success: true, taskId: 't' }))
    ;(window as any).electronAPI = { videoWorkbench: { submit } }
    const { b2 } = twoEpisodes()
    await pin('thread-b', b2)
    const [done, draft] = (
      await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '已出片' }, { prompt: '草稿' }], navigate: false }, 'thread-b')
    ).cardIds
    markSucceeded(done)
    const r = await callTool('video_workbench_start', {}, 'thread-b')
    expect(r.started).toEqual([draft])
    expect(r.skippedSucceeded).toBe(1)
  })

  it('export 不点名:导自己钉的那一集,而不是屏幕上翻到的那页', async () => {
    const { b1, b2 } = twoEpisodes()
    await pin('thread-b', b2)
    await callTool('video_workbench_add_tasks', { tasks: [{ prompt: '第 2 集' }], navigate: false }, 'thread-b')
    expect(S().activeBoardId).toBe(b1)
    const ir = await callTool('video_workbench_export', { full: true }, 'thread-b')
    expect(ir.boards.map((x: { id: string }) => x.id)).toEqual([b2])
  })

  it('create_project:新剧的起始分段自动钉给创建它的对话', async () => {
    const c = await callTool('video_workbench_create_project', { name: '乙剧' }, 'thread-c')
    const list = await callTool('video_workbench_list_projects', {}, 'thread-c')
    expect(list.yourBoardId).toBe(c.boardId)
  })
})

