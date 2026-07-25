// 卡片生命周期:计时起点(startedAt)、取消(含 preparing 阶段的延迟取消)、
// 重启后的 in-flight 对账。
//
// 计费口径贯穿全程:上游只允许取消 queued(不计费),running 无法取消(照样扣费),
// 所以 preparing 阶段的取消意图必须被记住 —— submit 一回来就立刻对 taskId 发
// 取消,那一刻任务几乎必然还在 queued,是真能省钱的窗口。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceCancelResult } from '../../../../types/seedance'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { canStart, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'

type Api = {
  submit: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  reconcile: ReturnType<typeof vi.fn>
}

function installApi(overrides: Partial<Api> = {}): Api {
  const api: Api = {
    submit: vi.fn(async () => ({ success: true, taskId: 'task-1' })),
    cancel: vi.fn(async (): Promise<SeedanceCancelResult> => ({ ok: true, billed: false })),
    reconcile: vi.fn(async () => []),
    ...overrides,
  }
  ;(window as any).electronAPI = { videoWorkbench: api }
  return api
}

const store = () => useVideoWorkbenchStore.getState()

/** 直接摆卡片状态（编排用；updateCard 会拒绝改生成中的卡，绕不过去）。 */
function setCard(id: string, patch: Partial<VideoWorkbenchCard>): void {
  useVideoWorkbenchStore.setState((s) => ({
    cards: s.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }))
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

describe('计时起点 startedAt', () => {
  it('提交时落 startedAt,不再依赖会被每条广播 bump 的 updatedAt', async () => {
    installApi()
    store().addCards([{ prompt: '一只猫' }])
    const before = Date.now()
    await store().startCards()

    const card = store().cards[0]
    expect(card.startedAt).toBeGreaterThanOrEqual(before)
    expect(card.startedAt).toBeLessThanOrEqual(Date.now())
  })

  it('重新生成会重置 startedAt(秒表从 0 起,而不是从上一轮累计)', async () => {
    installApi()
    store().addCards([{ prompt: '一只猫' }])
    await store().startCards()
    const first = store().cards[0].startedAt!

    // 先落终态才允许重新提交
    setCard(store().cards[0].id, { status: 'failed' })
    await new Promise((r) => setTimeout(r, 5))
    await store().startCards([store().cards[0].id])

    expect(store().cards[0].startedAt).toBeGreaterThan(first)
  })
})

describe('取消', () => {
  it('queued 卡片:调上游取消,卡片落 cancelled', async () => {
    const api = installApi()
    store().addCards([{ prompt: '一只猫' }])
    await store().startCards()
    const id = store().cards[0].id
    setCard(id, { status: 'queued', taskId: 'task-1' })

    const res = await store().cancelCards([id])

    expect(api.cancel).toHaveBeenCalledWith('task-1')
    expect(store().cards[0].status).toBe('cancelled')
    expect(res[0]).toMatchObject({ cardId: id, billed: false })
  })

  it('running 卡片:上游不支持真取消,卡片仍落 cancelled 且如实带回 billed=true', async () => {
    const api = installApi({
      cancel: vi.fn(async () => ({ ok: true, billed: true, reason: '上游不支持取消生成中的任务' })),
    })
    store().addCards([{ prompt: '一只猫' }])
    await store().startCards()
    const id = store().cards[0].id
    setCard(id, { status: 'running', taskId: 'task-1' })

    const res = await store().cancelCards([id])

    expect(api.cancel).toHaveBeenCalledWith('task-1')
    expect(store().cards[0].status).toBe('cancelled')
    expect(res[0]).toMatchObject({ billed: true })
  })

  it('preparing 阶段(还没 taskId):记住意图,submit 一回来立刻取消,卡片不回到 queued', async () => {
    let releaseSubmit: (v: { success: true; taskId: string }) => void = () => {}
    const api = installApi({
      submit: vi.fn(
        () =>
          new Promise<{ success: true; taskId: string }>((resolve) => {
            releaseSubmit = resolve
          }),
      ),
    })
    store().addCards([{ prompt: '一只猫' }])
    const starting = store().startCards()
    await vi.waitFor(() => expect(store().cards[0].status).toBe('preparing'))
    const id = store().cards[0].id

    await store().cancelCards([id])
    expect(store().cards[0].status).toBe('cancelled')
    expect(api.cancel).not.toHaveBeenCalled() // 还没 taskId,无从取消

    releaseSubmit({ success: true, taskId: 'task-late' })
    await starting

    // 拿到 taskId 后补发取消,且状态不得被 submit 的成功分支推回 queued
    await vi.waitFor(() => expect(api.cancel).toHaveBeenCalledWith('task-late'))
    expect(store().cards[0].status).toBe('cancelled')
  })

  it('draft / 终态卡片不发取消请求', async () => {
    const api = installApi()
    store().addCards([{ prompt: '一只猫' }])
    const id = store().cards[0].id

    const res = await store().cancelCards([id])

    expect(api.cancel).not.toHaveBeenCalled()
    expect(res).toHaveLength(0)
    expect(store().cards[0].status).toBe('draft')
  })

  it('cancelled 卡片可以重新生成', async () => {
    installApi()
    store().addCards([{ prompt: '一只猫' }])
    setCard(store().cards[0].id, { status: 'cancelled' })

    expect(canStart(store().cards[0]).ok).toBe(true)
  })
})

describe('重启对账 reconcileInFlight', () => {
  it('把进行中的卡片交给主进程重新接管,adopted 的保持进行中', async () => {
    const api = installApi({
      reconcile: vi.fn(async () => [{ taskId: 'task-1', outcome: 'adopted' as const }]),
    })
    store().addCards([{ prompt: '一只猫' }])
    const id = store().cards[0].id
    setCard(id, { status: 'running', taskId: 'task-1', clientId: 'wb-1' })

    await store().reconcileInFlight()

    expect(api.reconcile).toHaveBeenCalledWith([
      expect.objectContaining({ taskId: 'task-1', clientId: 'wb-1', prompt: '一只猫' }),
    ])
    expect(store().cards[0].status).toBe('running')
  })

  it('上游查不到(过期/已删)→ 卡片落 failed 并带原因,不再无限转圈', async () => {
    installApi({
      reconcile: vi.fn(async () => [
        { taskId: 'task-1', outcome: 'unknown' as const, reason: '任务不存在' },
      ]),
    })
    store().addCards([{ prompt: '一只猫' }])
    const id = store().cards[0].id
    setCard(id, { status: 'running', taskId: 'task-1' })

    await store().reconcileInFlight()

    expect(store().cards[0].status).toBe('failed')
    expect(store().cards[0].error).toContain('任务不存在')
  })

  it('preparing 但没 taskId(重启前没提交成功)→ 直接落 failed,不送去对账', async () => {
    const api = installApi()
    store().addCards([{ prompt: '一只猫' }])
    const id = store().cards[0].id
    setCard(id, { status: 'preparing' })

    await store().reconcileInFlight()

    expect(api.reconcile).not.toHaveBeenCalled()
    expect(store().cards[0].status).toBe('failed')
    expect(store().cards[0].error).toBeTruthy()
  })

  it('没有进行中的卡片时不发 IPC', async () => {
    const api = installApi()
    store().addCards([{ prompt: '一只猫' }])

    await store().reconcileInFlight()

    expect(api.reconcile).not.toHaveBeenCalled()
  })
})
