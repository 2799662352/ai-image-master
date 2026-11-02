// 云备份一轮:只传变了的 / 本地素材不偷传 / 各类失败的去留 / 取回走加固解析。
// 假云端按服务端同口径(去掉 exportedAt 与 app 的内容指纹)去重,验证两端指纹一致。
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchBoard, VideoWorkbenchProject } from '../../../../../types/videoWorkbench'
import type {
  WorkbenchBackupErrorCode,
  WorkbenchBackupItem,
  WorkbenchBackupResult,
} from '../../../../../types/workbenchBackup'
import { buildCard } from '../cardSpec'
import {
  createBackupSyncState,
  fetchBackupFile,
  fingerprintFile,
  prepareBackup,
  runBackupPass,
  type CloudBackupApi,
} from '../cloudBackup'

const app = { name: 'CATIMATION', version: '4.9.23' }

function project(id: string, name = `剧 ${id}`, updatedAt = 10): VideoWorkbenchProject {
  return { id, name, order: 0, createdAt: 1, updatedAt }
}
function board(id: string, projectId: string): VideoWorkbenchBoard {
  return { id, projectId, name: '分段 1', order: 0, createdAt: 1 }
}
function card(boardId: string, prompt: string, extra: Record<string, unknown> = {}) {
  return { ...buildCard({ prompt }, 0, boardId), ...extra }
}

function serverHash(file: Record<string, unknown>): string {
  const { exportedAt: _e, app: _a, ...rest } = file
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex')
}

type Fail = { code: WorkbenchBackupErrorCode; message?: string }
function fakeCloud(opts: { existing?: WorkbenchBackupItem[]; failList?: Fail; failPut?: (dramaId: string, n: number) => Fail | null } = {}) {
  const store = new Map<string, { sha: string; file: Record<string, unknown> }>()
  const puts: string[] = []
  let putCount = 0
  const api: CloudBackupApi = {
    list: vi.fn(async (): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>> => {
      if (opts.failList) return { ok: false, code: opts.failList.code, message: opts.failList.message ?? 'x' }
      return { ok: true, data: { items: opts.existing ?? [...store].map(([dramaId, v]) => item(dramaId, v.sha)) } }
    }),
    put: vi.fn(async (input) => {
      putCount += 1
      const fail = opts.failPut?.(input.dramaId, putCount)
      if (fail) return { ok: false, code: fail.code, message: fail.message ?? 'x' }
      const sha = serverHash(input.file as unknown as Record<string, unknown>)
      const prev = store.get(input.dramaId)
      puts.push(input.dramaId)
      if (prev?.sha === sha) return { ok: true, data: { unchanged: true, version: 'v', bytes: 1, boards: 1, cards: 1 } }
      store.set(input.dramaId, { sha, file: input.file as unknown as Record<string, unknown> })
      return { ok: true, data: { unchanged: false, version: 'v', bytes: 1, boards: 1, cards: 1 } }
    }),
    get: vi.fn(async (dramaId) => {
      const v = store.get(dramaId)
      if (!v) return { ok: false, code: 'NOT_FOUND' as const, message: 'nf' }
      return { ok: true, data: { file: v.file as never, version: 'v1' } }
    }),
  }
  return { api, store, puts }
}

function item(dramaId: string, sha256: string): WorkbenchBackupItem {
  return { dramaId, name: dramaId, version: 'v', sha256, bytes: 1, boards: 1, cards: 1, clientUpdatedAt: 1, serverUpdatedAt: 1, versions: 1 }
}

describe('prepareBackup', () => {
  it('只在本机的素材与只有本地副本的成片不进云端副本,按不同源计数;https 的照常带上', () => {
    const c = card('b1', 'A', {
      referenceImages: [
        { name: 'cloud.png', src: 'https://cos/cloud.png' },
        { name: 'local.png', src: 'D:\\pics\\local.png' },
        { name: 'again.png', src: 'D:\\pics\\local.png' },
        { name: 'pasted.png', src: 'data:image/png;base64,AAAA' },
      ],
      status: 'succeeded',
      localPath: 'C:\\out\\a.mp4',
    })
    const out = prepareBackup(project('p1'), [board('b1', 'p1')], [c], app, 0)
    expect(out).not.toBeNull()
    expect(out!.localOnly).toBe(3)
    expect(out!.cards).toBe(1)
    const exported = out!.file.boards[0].cards[0]
    expect(exported.referenceImages.map((m) => m.src)).toEqual(['https://cos/cloud.png'])
    expect(exported.result).toEqual({ status: 'draft' })
  })

  it('activityAt 取剧自身与各卡片更新时间的最大值;别的剧的卡不算', () => {
    const mine = { ...card('b1', 'A'), updatedAt: 500 }
    const other = { ...card('b2', 'B'), updatedAt: 9999 }
    const out = prepareBackup(project('p1', '剧', 100), [board('b1', 'p1'), board('b2', 'p2')], [mine, other], app, 0)
    expect(out!.activityAt).toBe(500)
    expect(out!.cards).toBe(1)
  })
})

describe('fingerprintFile', () => {
  it('与服务端同口径:不含 exportedAt / app;内容不变指纹不变,改一个字就变', async () => {
    const boards = [board('b1', 'p1')]
    const a = prepareBackup(project('p1'), boards, [card('b1', 'A')], { name: 'X', version: '1' }, 1_000)!
    const b = prepareBackup(project('p1'), boards, [card('b1', 'A')], { name: 'X', version: '2' }, 9_000_000)!
    const c = prepareBackup(project('p1'), boards, [card('b1', 'B')], app, 0)!
    const fa = await fingerprintFile(a.file)
    expect(fa).toBe(serverHash(a.file as unknown as Record<string, unknown>))
    expect(fa).toBe(await fingerprintFile(b.file))
    expect(fa).not.toBe(await fingerprintFile(c.file))
  })
})

describe('runBackupPass', () => {
  const snapshot = {
    projects: [project('p1'), project('p2'), project('empty')],
    boards: [board('b1', 'p1'), board('b2', 'p2'), board('b3', 'empty')],
    cards: [card('b1', 'A'), card('b2', 'B')],
  }

  it('首轮全传(空剧不传);第二轮内容没变 → 一个请求都不发;改了哪部只传哪部', async () => {
    const cloud = fakeCloud()
    const state = createBackupSyncState()
    const r1 = await runBackupPass({ api: cloud.api, snapshot, state, app, now: 1 })
    expect(r1).toMatchObject({ uploaded: 2, unchanged: 0, empty: 1, stopped: null, failures: [] })
    expect(cloud.puts.sort()).toEqual(['p1', 'p2'])

    const r2 = await runBackupPass({ api: cloud.api, snapshot, state, app, now: 2 })
    expect(r2).toMatchObject({ uploaded: 0, unchanged: 2, empty: 1 })
    expect(cloud.api.put).toHaveBeenCalledTimes(2)
    expect(cloud.api.list).toHaveBeenCalledTimes(1)

    const edited = { ...snapshot, cards: [card('b1', 'A 改了'), snapshot.cards[1]] }
    const r3 = await runBackupPass({ api: cloud.api, snapshot: edited, state, app, now: 3 })
    expect(r3).toMatchObject({ uploaded: 1, unchanged: 1 })
    expect(cloud.puts.at(-1)).toBe('p1')
  })

  it('新会话:先用云端 list 的指纹对账,云端已有且一致的不再上传', async () => {
    const first = fakeCloud()
    await runBackupPass({ api: first.api, snapshot, state: createBackupSyncState(), app, now: 1 })
    const second = fakeCloud({ existing: [...first.store].map(([id, v]) => item(id, v.sha)) })
    const r = await runBackupPass({ api: second.api, snapshot, state: createBackupSyncState(), app, now: 99 })
    expect(r).toMatchObject({ uploaded: 0, unchanged: 2 })
    expect(second.api.put).not.toHaveBeenCalled()
  })

  it('未登录 / 服务端没开 → 整轮中止,不再往下试;list 失败也一样', async () => {
    for (const code of ['NOT_AUTHENTICATED', 'NOT_CONFIGURED'] as const) {
      const c1 = fakeCloud({ failList: { code } })
      const r1 = await runBackupPass({ api: c1.api, snapshot, state: createBackupSyncState(), app })
      expect(r1.stopped).toBe(code)
      expect(c1.api.put).not.toHaveBeenCalled()

      const c2 = fakeCloud({ failPut: () => ({ code }) })
      const r2 = await runBackupPass({ api: c2.api, snapshot, state: createBackupSyncState(), app })
      expect(r2.stopped).toBe(code)
      expect(c2.api.put).toHaveBeenCalledTimes(1)
    }
  })

  it('连续两次网络 / 服务端失败就放弃本轮;失败的剧不记已备份,下一轮会重试', async () => {
    let allow = false
    const cloud = fakeCloud({ failPut: () => (allow ? null : { code: 'NETWORK' }) })
    const state = createBackupSyncState()
    const many = {
      projects: [project('p1'), project('p2'), project('p3')],
      boards: [board('b1', 'p1'), board('b2', 'p2'), board('b3', 'p3')],
      cards: [card('b1', 'A'), card('b2', 'B'), card('b3', 'C')],
    }
    const r1 = await runBackupPass({ api: cloud.api, snapshot: many, state, app })
    expect(r1.stopped).toBe('NETWORK')
    expect(r1.failures).toHaveLength(2)
    expect(cloud.api.put).toHaveBeenCalledTimes(2)

    allow = true
    const r2 = await runBackupPass({ api: cloud.api, snapshot: many, state, app })
    expect(r2).toMatchObject({ uploaded: 3, stopped: null, failures: [] })
  })

  it('成功一次就清零连续失败计数(隔开的两次失败不会中止本轮)', async () => {
    const cloud = fakeCloud({ failPut: (id) => (id === 'p1' || id === 'p3' ? { code: 'SERVER' } : null) })
    const many = {
      projects: [project('p1'), project('p2'), project('p3')],
      boards: [board('b1', 'p1'), board('b2', 'p2'), board('b3', 'p3')],
      cards: [card('b1', 'A'), card('b2', 'B'), card('b3', 'C')],
    }
    const r = await runBackupPass({ api: cloud.api, snapshot: many, state: createBackupSyncState(), app })
    expect(r.stopped).toBeNull()
    expect(r.uploaded).toBe(1)
    expect(r.failures.map((f) => f.dramaId)).toEqual(['p1', 'p3'])
  })

  it('单部过大 / 剧数超限:只记在那一部上,其它照传;不算网络失败', async () => {
    const cloud = fakeCloud({ failPut: (id) => (id === 'p1' ? { code: 'TOO_LARGE', message: '太大' } : id === 'p2' ? { code: 'TOO_MANY' } : null) })
    const many = {
      projects: [project('p1'), project('p2'), project('p3')],
      boards: [board('b1', 'p1'), board('b2', 'p2'), board('b3', 'p3')],
      cards: [card('b1', 'A'), card('b2', 'B'), card('b3', 'C')],
    }
    const r = await runBackupPass({ api: cloud.api, snapshot: many, state: createBackupSyncState(), app, maxConsecutiveTransportFailures: 1 })
    expect(r.stopped).toBeNull()
    expect(r.uploaded).toBe(1)
    expect(r.failures.map((f) => [f.dramaId, f.code])).toEqual([['p1', 'TOO_LARGE'], ['p2', 'TOO_MANY']])
  })

  it('各剧的「只在本机」素材数累加进结果(含内容没变没传的剧)', async () => {
    const local = { referenceImages: [{ name: 'l.png', src: 'D:\\l.png' }] }
    const snap = {
      projects: [project('p1'), project('p2')],
      boards: [board('b1', 'p1'), board('b2', 'p2')],
      cards: [card('b1', 'A', local), card('b2', 'B', local)],
    }
    const cloud = fakeCloud()
    const state = createBackupSyncState()
    expect((await runBackupPass({ api: cloud.api, snapshot: snap, state, app })).localOnly).toBe(2)
    expect((await runBackupPass({ api: cloud.api, snapshot: snap, state, app })).localOnly).toBe(2)
  })
})

describe('fetchBackupFile', () => {
  it('取回的副本过加固解析,给出摘要与版本', async () => {
    const cloud = fakeCloud()
    const state = createBackupSyncState()
    await runBackupPass({
      api: cloud.api,
      snapshot: { projects: [project('p1', '追车戏')], boards: [board('b1', 'p1')], cards: [card('b1', 'A')] },
      state,
      app,
    })
    const r = await fetchBackupFile(cloud.api, 'p1')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.file.project.name).toBe('追车戏')
    expect(r.summary).toMatchObject({ segments: 1, cards: 1 })
    expect(r.version).toBe('v1')
  })

  it('云端副本被改坏(不是工程文件)→ CORRUPT,不抛;服务端的失败码原样透传', async () => {
    const cloud = fakeCloud()
    cloud.store.set('bad', { sha: 'x', file: { format: 'not-ours', boards: [] } })
    expect(await fetchBackupFile(cloud.api, 'bad')).toMatchObject({ ok: false, code: 'CORRUPT' })
    expect(await fetchBackupFile(cloud.api, 'nope')).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})
