// 云备份 × 云端回收站:本机删剧 → 镜像进云端回收站(带护栏)/ 别的设备删过 → 报冲突不报故障 /
// 用户选「继续备份」才复活 / 本机彻底删除 → 通知云端收紧保留期 / 回收站里的副本走同一道加固解析。
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import type {
  WorkbenchBackupErrorCode,
  WorkbenchBackupItem,
  WorkbenchBackupResult,
  WorkbenchBackupTrashItem,
} from '../../../../../types/workbenchBackup'
import { buildCard } from '../cardSpec'
import {
  CLOUD_CLOCK_SKEW_MS,
  createBackupSyncState,
  fetchTrashedBackupFile,
  reviveBackup,
  runBackupPass,
  settlePurgedProjects,
  type CloudBackupBridge,
} from '../cloudBackup'

const app = { name: 'CATIMATION', version: '4.9.25' }
const project = (id: string): VideoWorkbenchProject => ({ id, name: `剧 ${id}`, order: 0, createdAt: 1, updatedAt: 10 })
const board = (id: string, projectId: string): VideoWorkbenchBoard => ({ id, projectId, name: '分段 1', order: 0, createdAt: 1 })
const card = (boardId: string, prompt: string) => buildCard({ prompt }, 0, boardId)

const liveItem = (dramaId: string, serverUpdatedAt: number, sha256 = 'sha-old'): WorkbenchBackupItem => ({
  dramaId, name: dramaId, version: 'v', sha256, bytes: 1, boards: 1, cards: 1, clientUpdatedAt: 1, serverUpdatedAt, versions: 1,
})
const trashItem = (dramaId: string, deletedAt: number): WorkbenchBackupTrashItem => ({
  ...liveItem(dramaId, 1),
  trashId: `${dramaId}@${String(deletedAt).padStart(13, '0')}`,
  deletedAt,
  purgeAfter: deletedAt + 60 * 86_400_000,
})

const serverHash = (file: Record<string, unknown>): string => {
  const { exportedAt: _e, app: _a, ...rest } = file
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

const NOW = 1_800_000_000_000

/** 带回收站语义的假云端:有「活」的和「回收站」两处,put 遇到回收站里的同号条目回 TRASHED。 */
function fakeCloud(opts: { live?: WorkbenchBackupItem[]; trash?: WorkbenchBackupTrashItem[]; trashedBy?: string; failRemote?: WorkbenchBackupErrorCode } = {}) {
  const live = new Map((opts.live ?? []).map((i) => [i.dramaId, i]))
  const trash = [...(opts.trash ?? [])]
  const putCalls: Array<{ dramaId: string; revive?: boolean }> = []
  const api = {
    list: vi.fn(async (): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>> => ({ ok: true, data: { items: [...live.values()] } })),
    put: vi.fn(async (input: { dramaId: string; file: unknown; revive?: boolean }) => {
      putCalls.push({ dramaId: input.dramaId, revive: input.revive })
      const hit = trash.find((t) => t.dramaId === input.dramaId)
      if (hit && !live.has(input.dramaId) && !input.revive) {
        return {
          ok: false as const,
          code: 'TRASHED' as const,
          message: '已在别处删除',
          details: { trashId: hit.trashId, deletedAt: hit.deletedAt, purgeAfter: hit.purgeAfter, ...(opts.trashedBy ? { deviceName: opts.trashedBy } : {}) },
        }
      }
      live.set(input.dramaId, liveItem(input.dramaId, NOW, serverHash(input.file as Record<string, unknown>)))
      return { ok: true as const, data: { unchanged: false, version: 'v', bytes: 1, boards: 1, cards: 1 } }
    }),
    get: vi.fn(),
    remove: vi.fn(async (dramaId: string) => {
      if (opts.failRemote) return { ok: false as const, code: opts.failRemote, message: 'x' }
      const it = live.get(dramaId)
      if (!it) return { ok: true as const, data: { removed: 0, trashed: false } }
      live.delete(dramaId)
      trash.push(trashItem(dramaId, NOW))
      return { ok: true as const, data: { removed: 1, trashed: true } }
    }),
    trashList: vi.fn(async (): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupTrashItem[] }>> => ({ ok: true, data: { items: [...trash] } })),
    trashGet: vi.fn(),
    trashRestore: vi.fn(),
    trashConfirm: vi.fn(async () => ({ ok: true as const, data: { purgeAfter: 1 } })),
    trashPurge: vi.fn(),
  }
  return { api: api as unknown as CloudBackupBridge & typeof api, live, trash, putCalls }
}

const one = { projects: [project('p1')], boards: [board('b1', 'p1')], cards: [card('b1', 'A')] }
const noneLive = { projects: [], boards: [], cards: [] }

describe('本机删剧 → 镜像到云端回收站', () => {
  it('云端有活副本、且不比这次删除新 → 移入回收站(默认软删,不带 permanent),不再上传', async () => {
    const cloud = fakeCloud({ live: [liveItem('p1', 500)] })
    const state = createBackupSyncState()
    const r = await runBackupPass({
      api: cloud.api, state, app, now: NOW,
      snapshot: { ...noneLive, trashedProjects: [{ id: 'p1', name: '剧 p1', deletedAt: 1000 }] },
    })
    expect(cloud.api.remove).toHaveBeenCalledTimes(1)
    expect(cloud.api.remove).toHaveBeenCalledWith('p1')
    expect(r).toMatchObject({ trashedRemote: 1, failures: [], stopped: null, uploaded: 0 })
    expect(state.cloudAt.has('p1')).toBe(false)
    expect(state.acked.has('p1')).toBe(false)
    // 再来一轮:云端已经没有活副本 → 不会重复删
    await runBackupPass({ api: cloud.api, state, app, snapshot: { ...noneLive, trashedProjects: [{ id: 'p1', name: '剧 p1', deletedAt: 1000 }] } })
    expect(cloud.api.remove).toHaveBeenCalledTimes(1)
  })

  it('护栏:云端副本比这次删除晚过容差(别的设备删后又改过)→ 不动;容差内仍算「不更新」', async () => {
    const newer = fakeCloud({ live: [liveItem('p1', 1000 + CLOUD_CLOCK_SKEW_MS + 1)] })
    const r1 = await runBackupPass({
      api: newer.api, state: createBackupSyncState(), app,
      snapshot: { ...noneLive, trashedProjects: [{ id: 'p1', name: 'x', deletedAt: 1000 }] },
    })
    expect(newer.api.remove).not.toHaveBeenCalled()
    expect(r1.trashedRemote).toBe(0)

    const within = fakeCloud({ live: [liveItem('p1', 1000 + CLOUD_CLOCK_SKEW_MS)] })
    await runBackupPass({
      api: within.api, state: createBackupSyncState(), app,
      snapshot: { ...noneLive, trashedProjects: [{ id: 'p1', name: 'x', deletedAt: 1000 }] },
    })
    expect(within.api.remove).toHaveBeenCalledTimes(1)
  })

  it('云端根本没有这部剧 / 没有 remove 通道(旧桥)→ 什么都不做也不报错', async () => {
    const empty = fakeCloud()
    const r = await runBackupPass({
      api: empty.api, state: createBackupSyncState(), app,
      snapshot: { ...noneLive, trashedProjects: [{ id: 'p1', name: 'x', deletedAt: 1000 }] },
    })
    expect(empty.api.remove).not.toHaveBeenCalled()
    expect(r).toMatchObject({ trashedRemote: 0, failures: [], stopped: null })

    const legacy = fakeCloud({ live: [liveItem('p1', 500)] })
    const { remove: _drop, ...noRemove } = legacy.api
    const r2 = await runBackupPass({
      api: noRemove as unknown as CloudBackupBridge, state: createBackupSyncState(), app,
      snapshot: { ...noneLive, trashedProjects: [{ id: 'p1', name: 'x', deletedAt: 1000 }] },
    })
    expect(r2).toMatchObject({ trashedRemote: 0, failures: [], stopped: null })
  })

  it('镜像失败:未登录整轮中止;别的失败记在那部剧上,不影响后面的上传', async () => {
    const live2 = { projects: [project('p2')], boards: [board('b2', 'p2')], cards: [card('b2', 'B')] }
    const trashedP1 = [{ id: 'p1', name: '被删的', deletedAt: 1000 }]

    const stopped = fakeCloud({ live: [liveItem('p1', 500)], failRemote: 'NOT_AUTHENTICATED' })
    const r1 = await runBackupPass({ api: stopped.api, state: createBackupSyncState(), app, snapshot: { ...live2, trashedProjects: trashedP1 } })
    expect(r1.stopped).toBe('NOT_AUTHENTICATED')
    expect(stopped.api.put).not.toHaveBeenCalled()

    const soft = fakeCloud({ live: [liveItem('p1', 500)], failRemote: 'INVALID' })
    const r2 = await runBackupPass({ api: soft.api, state: createBackupSyncState(), app, snapshot: { ...live2, trashedProjects: trashedP1 } })
    expect(r2.stopped).toBeNull()
    expect(r2.failures).toEqual([{ dramaId: 'p1', name: '被删的', code: 'INVALID', message: 'x' }])
    expect(r2.uploaded).toBe(1) // p2 照常上传
  })
})

describe('云端回收站挡住备份(别的设备删的)', () => {
  const trashed = (deviceName?: string) => fakeCloud({ trash: [trashItem('p1', 1234)], trashedBy: deviceName })

  it('报冲突、不报故障;不算连续失败;指纹没变时不再重复请求,但每轮照实报告', async () => {
    const cloud = trashed('办公室-PC')
    const state = createBackupSyncState()
    const snap = { projects: [project('p1'), project('p2')], boards: [board('b1', 'p1'), board('b2', 'p2')], cards: [card('b1', 'A'), card('b2', 'B')] }
    const r1 = await runBackupPass({ api: cloud.api, snapshot: snap, state, app, now: NOW, maxConsecutiveTransportFailures: 1 })
    expect(r1.failures).toEqual([])
    expect(r1.stopped).toBeNull()
    expect(r1.uploaded).toBe(1) // p2 照常上传
    expect(r1.trashConflicts).toEqual([
      { dramaId: 'p1', name: '剧 p1', trashId: trashItem('p1', 1234).trashId, deletedAt: 1234, purgeAfter: trashItem('p1', 1234).purgeAfter, deviceName: '办公室-PC' },
    ])
    expect(cloud.putCalls.filter((c) => c.dramaId === 'p1')).toHaveLength(1)

    const r2 = await runBackupPass({ api: cloud.api, snapshot: snap, state, app, now: NOW })
    expect(cloud.putCalls.filter((c) => c.dramaId === 'p1')).toHaveLength(1) // 没再请求
    expect(r2.trashConflicts).toHaveLength(1)

    // 本地又改了内容 → 指纹变了,再试一次(云端回收站可能已被清掉)
    const edited = { ...snap, cards: [card('b1', 'A 改了'), snap.cards[1]] }
    await runBackupPass({ api: cloud.api, snapshot: edited, state, app, now: NOW })
    expect(cloud.putCalls.filter((c) => c.dramaId === 'p1')).toHaveLength(2)
  })

  it('服务端没带设备名 / 细节缺字段 → 冲突里不编造', async () => {
    const cloud = trashed()
    const r = await runBackupPass({ api: cloud.api, snapshot: one, state: createBackupSyncState(), app })
    expect(r.trashConflicts[0]).not.toHaveProperty('deviceName')
  })

  it('reviveBackup:带 revive 重发,成功后清掉冲突并记为已备份(下一轮不再传)', async () => {
    const cloud = trashed('办公室-PC')
    const state = createBackupSyncState()
    await runBackupPass({ api: cloud.api, snapshot: one, state, app, now: NOW })
    expect(state.blocked.has('p1')).toBe(true)

    const r = await reviveBackup({ api: cloud.api, snapshot: one, state, app, dramaId: 'p1', now: NOW })
    expect(r).toEqual({ ok: true, unchanged: false })
    expect(cloud.putCalls.at(-1)).toEqual({ dramaId: 'p1', revive: true })
    expect(state.blocked.has('p1')).toBe(false)

    const next = await runBackupPass({ api: cloud.api, snapshot: one, state, app, now: NOW })
    expect(next).toMatchObject({ unchanged: 1, uploaded: 0, trashConflicts: [] })
  })

  it('reviveBackup:本机没有这部剧 / 还没有镜头 → 不发请求;服务端失败原样带回', async () => {
    const cloud = trashed()
    const state = createBackupSyncState()
    expect(await reviveBackup({ api: cloud.api, snapshot: one, state, app, dramaId: 'nope' })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const emptyDrama = { projects: [project('p1')], boards: [board('b1', 'p1')], cards: [] }
    expect(await reviveBackup({ api: cloud.api, snapshot: emptyDrama, state, app, dramaId: 'p1' })).toMatchObject({ ok: false, code: 'INVALID' })
    expect(cloud.api.put).not.toHaveBeenCalled()

    const failing = { put: vi.fn(async () => ({ ok: false as const, code: 'TOO_MANY' as const, message: '满了' })) }
    expect(await reviveBackup({ api: failing, snapshot: one, state, app, dramaId: 'p1' })).toEqual({ ok: false, code: 'TOO_MANY', message: '满了' })
    expect(state.blocked.size).toBe(0)
  })
})

describe('本机彻底删除 → 通知云端', () => {
  const day = 86_400_000

  it('云端回收站里同号条目收紧保留期;别的剧、本机彻底删除之后才在别处删的那条不动', async () => {
    const cloud = fakeCloud({
      trash: [trashItem('p1', NOW - day), trashItem('p1', NOW + CLOUD_CLOCK_SKEW_MS + 1), trashItem('p2', NOW - day)],
    })
    const r = await settlePurgedProjects(cloud.api, createBackupSyncState(), [{ id: 'p1', name: '剧 p1', deletedAt: NOW - day, purgedAt: NOW }])
    expect(r).toMatchObject({ confirmed: 1, failed: 0, stopped: null })
    expect(cloud.api.trashConfirm).toHaveBeenCalledTimes(1)
    expect(cloud.api.trashConfirm).toHaveBeenCalledWith(trashItem('p1', NOW - day).trashId)
  })

  it('刚删就被清空、还没来得及镜像:先把云端活副本移入回收站,再给新条目结案', async () => {
    const cloud = fakeCloud({ live: [liveItem('p1', NOW - 2 * day)] })
    const state = createBackupSyncState()
    const r = await settlePurgedProjects(cloud.api, state, [{ id: 'p1', name: '剧 p1', deletedAt: NOW - day, purgedAt: NOW }])
    expect(cloud.api.remove).toHaveBeenCalledWith('p1')
    expect(r).toMatchObject({ trashed: 1, confirmed: 1 })
    expect(cloud.api.list).toHaveBeenCalledTimes(1) // 没对过账就先对一次
  })

  it('护栏:云端活副本比这次删除新得多(别处删后又改过)→ 不移入回收站;只剩容差内才动', async () => {
    const newer = fakeCloud({ live: [liveItem('p1', NOW)] })
    const r = await settlePurgedProjects(newer.api, createBackupSyncState(), [{ id: 'p1', name: '剧 p1', deletedAt: NOW - day, purgedAt: NOW }])
    expect(newer.api.remove).not.toHaveBeenCalled()
    expect(r).toMatchObject({ trashed: 0, failed: 0, stopped: null })
    expect(newer.live.has('p1')).toBe(true)

    const within = fakeCloud({ live: [liveItem('p1', NOW - day + CLOUD_CLOCK_SKEW_MS)] })
    await settlePurgedProjects(within.api, createBackupSyncState(), [{ id: 'p1', name: '剧 p1', deletedAt: NOW - day, purgedAt: NOW }])
    expect(within.api.remove).toHaveBeenCalledTimes(1)
  })

  it('尽力而为:没有要结案的 → 不发任何请求;未登录 → 报 stopped,不抛', async () => {
    const cloud = fakeCloud()
    expect(await settlePurgedProjects(cloud.api, createBackupSyncState(), [])).toMatchObject({ trashed: 0, confirmed: 0 })
    expect(cloud.api.list).not.toHaveBeenCalled()

    cloud.api.list.mockResolvedValueOnce({ ok: false, code: 'NOT_AUTHENTICATED', message: 'x' })
    const r = await settlePurgedProjects(cloud.api, createBackupSyncState(), [{ id: 'p1', name: 'x', deletedAt: 1, purgedAt: 2 }])
    expect(r.stopped).toBe('NOT_AUTHENTICATED')
    expect(cloud.api.trashConfirm).not.toHaveBeenCalled()
  })

  it('确认失败只计数,不影响其它条目', async () => {
    const cloud = fakeCloud({ trash: [trashItem('p1', NOW - day), trashItem('p2', NOW - day)] })
    cloud.api.trashConfirm.mockResolvedValueOnce({ ok: false, code: 'NETWORK', message: 'x' } as never)
    const r = await settlePurgedProjects(cloud.api, createBackupSyncState(), [
      { id: 'p1', name: 'a', deletedAt: NOW - day, purgedAt: NOW },
      { id: 'p2', name: 'b', deletedAt: NOW - day, purgedAt: NOW },
    ])
    expect(r).toMatchObject({ confirmed: 1, failed: 1, stopped: null })
  })
})

describe('fetchTrashedBackupFile', () => {
  it('回收站里的副本同样过加固解析:坏的 → CORRUPT,服务端失败码透传,好的给出摘要', async () => {
    const trashGet = vi.fn()
    trashGet.mockResolvedValueOnce({ ok: true, data: { file: { format: 'not-ours', boards: [] }, version: 'v1' } })
    expect(await fetchTrashedBackupFile({ trashGet }, 'p1@1')).toMatchObject({ ok: false, code: 'CORRUPT' })
    trashGet.mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', message: '过期了' })
    expect(await fetchTrashedBackupFile({ trashGet }, 'p1@1')).toEqual({ ok: false, code: 'NOT_FOUND', message: '过期了' })

    const cloud = fakeCloud()
    await runBackupPass({ api: cloud.api, snapshot: one, state: createBackupSyncState(), app, now: NOW })
    const file = (cloud.api.put.mock.calls[0]![0] as { file: unknown }).file
    trashGet.mockResolvedValueOnce({ ok: true, data: { file, version: 'v9' } })
    const good = await fetchTrashedBackupFile({ trashGet }, 'p1@1', 'v9')
    expect(good).toMatchObject({ ok: true, version: 'v9', summary: { segments: 1, cards: 1 } })
    expect(trashGet).toHaveBeenLastCalledWith('p1@1', 'v9')
  })
})
