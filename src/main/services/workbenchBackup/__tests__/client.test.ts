import { describe, expect, it, vi } from 'vitest'
import { WORKBENCH_BACKUP_MAX_BYTES } from '../../../../types/workbenchBackup'
import { createWorkbenchBackupClient, type BackupTransport } from '../client'

function transport(reply: { status: number; body: Record<string, unknown> } | Error) {
  const send = vi.fn(async () => {
    if (reply instanceof Error) throw reply
    return reply
  })
  return { send } as BackupTransport & { send: ReturnType<typeof vi.fn> }
}

const file = { format: 'catimation-workbench-project', formatVersion: 1, project: { name: 'a' }, boards: [] }

describe('createWorkbenchBackupClient', () => {
  it('list: 取出 items', async () => {
    const t = transport({ status: 200, body: { success: true, data: { items: [{ dramaId: 'd1', name: 'A' }] } } })
    const r = await createWorkbenchBackupClient(t).list()
    expect(r).toEqual({ ok: true, data: { items: [{ dramaId: 'd1', name: 'A' }] } })
    expect(t.send).toHaveBeenCalledWith('/api/workbench-backup', 'GET', undefined)
  })

  it('put: 发 {name, clientUpdatedAt, file},并放宽超时', async () => {
    const t = transport({ status: 200, body: { success: true, data: { unchanged: false, version: 'v', bytes: 1, boards: 0, cards: 0 } } })
    const r = await createWorkbenchBackupClient(t).put('d1', { name: 'A', clientUpdatedAt: 5, file })
    expect(r.ok).toBe(true)
    const [path, method, opts] = t.send.mock.calls[0] as [string, string, { body: unknown; timeoutMs: number }]
    expect(path).toBe('/api/workbench-backup/d1')
    expect(method).toBe('PUT')
    expect(opts.body).toEqual({ name: 'A', clientUpdatedAt: 5, file })
    expect(opts.timeoutMs).toBeGreaterThan(15_000)
  })

  it('put: 超过体积上限在本地就拒,不发请求', async () => {
    const t = transport({ status: 200, body: { success: true, data: {} } })
    const big = { ...file, pad: 'x'.repeat(WORKBENCH_BACKUP_MAX_BYTES) }
    const r = await createWorkbenchBackupClient(t).put('d1', { name: 'A', clientUpdatedAt: 1, file: big })
    expect(r).toMatchObject({ ok: false, code: 'TOO_LARGE' })
    expect(t.send).not.toHaveBeenCalled()
  })

  it('不合法的剧 id / 版本号不发请求', async () => {
    const t = transport({ status: 200, body: { success: true, data: {} } })
    const c = createWorkbenchBackupClient(t)
    expect(await c.get('../x')).toMatchObject({ ok: false, code: 'INVALID' })
    expect(await c.get('d1', '../../x')).toMatchObject({ ok: false, code: 'INVALID' })
    expect(await c.remove('a/b')).toMatchObject({ ok: false, code: 'INVALID' })
    expect(await c.put('', { name: 'n', clientUpdatedAt: 1, file })).toMatchObject({ ok: false, code: 'INVALID' })
    expect(t.send).not.toHaveBeenCalled()
  })

  it('get: 版本号拼进查询串', async () => {
    const t = transport({ status: 200, body: { success: true, data: { file, version: '0000000000001-aaaaaaaa' } } })
    const r = await createWorkbenchBackupClient(t).get('d1', '0000000000001-aaaaaaaa')
    expect(r).toEqual({ ok: true, data: { file, version: '0000000000001-aaaaaaaa' } })
    expect(t.send.mock.calls[0][0]).toBe('/api/workbench-backup/d1?version=0000000000001-aaaaaaaa')
  })

  it('没登录:传输层抛 NOT_AUTHENTICATED → code NOT_AUTHENTICATED', async () => {
    const err = Object.assign(new Error('未登录'), { code: 'NOT_AUTHENTICATED' })
    expect(await createWorkbenchBackupClient(transport(err)).list()).toMatchObject({ ok: false, code: 'NOT_AUTHENTICATED' })
  })

  it('网络失败 → NETWORK', async () => {
    expect(await createWorkbenchBackupClient(transport(new Error('fetch failed'))).list()).toMatchObject({
      ok: false,
      code: 'NETWORK',
      message: 'fetch failed',
    })
  })

  it.each([
    [503, { success: false, code: 'BACKUP_NOT_CONFIGURED', error: '云备份暂未开通' }, 'NOT_CONFIGURED'],
    [401, { success: false, code: 'UNAUTHORIZED', error: '请先登录' }, 'NOT_AUTHENTICATED'],
    [413, { success: false, code: 'FILE_TOO_LARGE', error: '太大' }, 'TOO_LARGE'],
    [409, { success: false, code: 'TOO_MANY_DRAMAS', error: '满了' }, 'TOO_MANY'],
    [404, { success: false, code: 'NOT_FOUND', error: '没有这部剧' }, 'NOT_FOUND'],
    [400, { success: false, code: 'INVALID_FILE', error: '不是工程文件' }, 'INVALID'],
    [502, { success: false, code: 'BACKUP_STORAGE_ERROR', error: '存储暂不可用' }, 'SERVER'],
  ])('HTTP %i %j → %s', async (status, body, code) => {
    const r = await createWorkbenchBackupClient(transport({ status, body })).list()
    expect(r).toMatchObject({ ok: false, code })
  })

  it('没带我们错误码的 404(旧后端没有这组接口)按「未开通」处理,而不是「这部剧不存在」', async () => {
    const r = await createWorkbenchBackupClient(transport({ status: 404, body: { error: 'Not Found' } })).list()
    expect(r).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' })
  })

  it('2xx 但没有 data → SERVER,不让 undefined 往下流', async () => {
    const r = await createWorkbenchBackupClient(transport({ status: 200, body: { success: true } })).list()
    expect(r).toMatchObject({ ok: false, code: 'SERVER' })
  })
})

// ---------------------------------------------------------------------------
// 云端回收站(服务端 #171):删除 = 移入回收站;回收站自己有一组接口
// ---------------------------------------------------------------------------

const TRASH_ID = 'd1@1700000000000'
const putOk = { status: 200, body: { success: true, data: { unchanged: false, version: 'v', bytes: 1, boards: 0, cards: 0 } } }
const trashedBody = (deviceName?: string) => ({
  status: 409,
  body: {
    success: false,
    code: 'DRAMA_TRASHED',
    error: '这部剧已在云端回收站',
    details: { trashId: TRASH_ID, deletedAt: 1_700_000_000_000, purgeAfter: 1_705_000_000_000, deviceName },
  },
})

function scripted(...replies: Array<{ status: number; body: Record<string, unknown> }>) {
  const queue = [...replies]
  const send = vi.fn(async () => {
    const next = queue.shift()
    if (!next) throw new Error('unexpected extra request')
    return next
  })
  return { send } as BackupTransport & { send: ReturnType<typeof vi.fn> }
}

describe('createWorkbenchBackupClient · 设备名与删除', () => {
  it('put:带上设备名(只在有设备名时才出现这个键)', async () => {
    const t = transport(putOk)
    await createWorkbenchBackupClient(t, { deviceName: 'PC-A' }).put('d1', { name: 'A', clientUpdatedAt: 5, file })
    expect((t.send.mock.calls[0] as unknown[])[2]).toMatchObject({ body: { deviceName: 'PC-A' } })
  })

  it('put:设备名过长截到 64 字符', async () => {
    const t = transport(putOk)
    await createWorkbenchBackupClient(t, { deviceName: 'x'.repeat(200) }).put('d1', { name: 'A', clientUpdatedAt: 5, file })
    const body = (t.send.mock.calls[0] as [string, string, { body: { deviceName: string } }])[2].body
    expect(body.deviceName).toHaveLength(64)
  })

  it('remove:默认是「移入云端回收站」,设备名走查询串;回包带回收站信息', async () => {
    const data = { trashed: true, removed: 3, trashId: TRASH_ID, deletedAt: 1, purgeAfter: 2 }
    const t = transport({ status: 200, body: { success: true, data } })
    const r = await createWorkbenchBackupClient(t, { deviceName: 'PC A' }).remove('d1')
    expect(r).toEqual({ ok: true, data })
    expect(t.send).toHaveBeenCalledWith('/api/workbench-backup/d1?deviceName=PC%20A', 'DELETE', undefined)
  })

  it('remove({permanent}):走 ?permanent=1,不带设备名', async () => {
    const t = transport({ status: 200, body: { success: true, data: { trashed: false, removed: 4 } } })
    const r = await createWorkbenchBackupClient(t, { deviceName: 'PC-A' }).remove('d1', { permanent: true })
    expect(r).toMatchObject({ ok: true, data: { trashed: false, removed: 4 } })
    expect(t.send.mock.calls[0][0]).toBe('/api/workbench-backup/d1?permanent=1')
  })

  it('remove:旧后端只回 removed,trashed 缺省为 false', async () => {
    const t = transport({ status: 200, body: { success: true, data: { removed: 2 } } })
    const r = await createWorkbenchBackupClient(t).remove('d1')
    expect(r).toEqual({ ok: true, data: { removed: 2, trashed: false } })
  })

  it('剧 id 叫 trash 会撞上回收站路由 → 本地直接拒', async () => {
    const t = transport(putOk)
    const c = createWorkbenchBackupClient(t)
    expect(await c.put('trash', { name: 'n', clientUpdatedAt: 1, file })).toMatchObject({ ok: false, code: 'INVALID' })
    expect(await c.get('trash')).toMatchObject({ ok: false, code: 'INVALID' })
    expect(t.send).not.toHaveBeenCalled()
  })
})

describe('createWorkbenchBackupClient · put 遇到云端回收站', () => {
  it('别的设备删的 → TRASHED + details,不自动复活', async () => {
    const t = scripted(trashedBody('PC-B'))
    const r = await createWorkbenchBackupClient(t, { deviceName: 'PC-A' }).put('d1', { name: 'A', clientUpdatedAt: 5, file })
    expect(r).toMatchObject({ ok: false, code: 'TRASHED', details: { trashId: TRASH_ID, deviceName: 'PC-B' } })
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('本机自己删的(删了又在本地恢复)→ 自动带 revive 重发一次', async () => {
    const t = scripted(trashedBody('PC-A'), putOk)
    const r = await createWorkbenchBackupClient(t, { deviceName: 'PC-A' }).put('d1', { name: 'A', clientUpdatedAt: 5, file })
    expect(r.ok).toBe(true)
    expect(t.send).toHaveBeenCalledTimes(2)
    expect((t.send.mock.calls[1] as [string, string, { body: Record<string, unknown> }])[2].body).toMatchObject({ revive: true })
    expect((t.send.mock.calls[0] as [string, string, { body: Record<string, unknown> }])[2].body).not.toHaveProperty('revive')
  })

  it('没有设备名时不猜:同名比较不成立,照样交给用户', async () => {
    const t = scripted(trashedBody(undefined))
    const r = await createWorkbenchBackupClient(t).put('d1', { name: 'A', clientUpdatedAt: 5, file })
    expect(r).toMatchObject({ ok: false, code: 'TRASHED' })
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('已经带着 revive 还被拒 → 不循环,原样返回', async () => {
    const t = scripted(trashedBody('PC-A'))
    const r = await createWorkbenchBackupClient(t, { deviceName: 'PC-A' }).put('d1', {
      name: 'A',
      clientUpdatedAt: 5,
      file,
      revive: true,
    })
    expect(r).toMatchObject({ ok: false, code: 'TRASHED' })
    expect(t.send).toHaveBeenCalledTimes(1)
  })

  it('用户明确选「继续备份」:revive 原样发给服务端', async () => {
    const t = scripted(putOk)
    await createWorkbenchBackupClient(t).put('d1', { name: 'A', clientUpdatedAt: 5, file, revive: true })
    expect((t.send.mock.calls[0] as [string, string, { body: Record<string, unknown> }])[2].body).toMatchObject({ revive: true })
  })
})

describe('createWorkbenchBackupClient · 回收站接口', () => {
  it('trashList:GET /trash', async () => {
    const items = [{ trashId: TRASH_ID, dramaId: 'd1', name: 'A', deletedAt: 1, purgeAfter: 2 }]
    const t = transport({ status: 200, body: { success: true, data: { items } } })
    expect(await createWorkbenchBackupClient(t).trashList()).toEqual({ ok: true, data: { items } })
    expect(t.send).toHaveBeenCalledWith('/api/workbench-backup/trash', 'GET', undefined)
  })

  it('trashGet:取回收站里那份(可指定版本),id 里的 @ 要编码', async () => {
    const t = transport({ status: 200, body: { success: true, data: { file, version: '0000000000001-aaaaaaaa' } } })
    const r = await createWorkbenchBackupClient(t).trashGet(TRASH_ID, '0000000000001-aaaaaaaa')
    expect(r).toEqual({ ok: true, data: { file, version: '0000000000001-aaaaaaaa' } })
    expect(t.send.mock.calls[0][0]).toBe('/api/workbench-backup/trash/d1%401700000000000?version=0000000000001-aaaaaaaa')
  })

  it('trashRestore:POST …/restore;同号活剧还在 → EXISTS', async () => {
    const ok = transport({ status: 200, body: { success: true, data: { dramaId: 'd1', version: 'v' } } })
    expect(await createWorkbenchBackupClient(ok).trashRestore(TRASH_ID)).toEqual({ ok: true, data: { dramaId: 'd1', version: 'v' } })
    expect(ok.send).toHaveBeenCalledWith('/api/workbench-backup/trash/d1%401700000000000/restore', 'POST', undefined)

    const exists = transport({ status: 409, body: { success: false, code: 'DRAMA_EXISTS', error: '云端已有同号的剧' } })
    expect(await createWorkbenchBackupClient(exists).trashRestore(TRASH_ID)).toMatchObject({ ok: false, code: 'EXISTS' })
  })

  it('trashConfirm / trashPurge:各自的方法与路径', async () => {
    const c1 = transport({ status: 200, body: { success: true, data: { purgeAfter: 9 } } })
    expect(await createWorkbenchBackupClient(c1).trashConfirm(TRASH_ID)).toEqual({ ok: true, data: { purgeAfter: 9 } })
    expect(c1.send).toHaveBeenCalledWith('/api/workbench-backup/trash/d1%401700000000000/confirm', 'POST', undefined)

    const c2 = transport({ status: 200, body: { success: true, data: { removed: 2 } } })
    expect(await createWorkbenchBackupClient(c2).trashPurge(TRASH_ID)).toEqual({ ok: true, data: { removed: 2 } })
    expect(c2.send).toHaveBeenCalledWith('/api/workbench-backup/trash/d1%401700000000000', 'DELETE', undefined)
  })

  it('不合法的回收站 id 不发请求', async () => {
    const t = transport({ status: 200, body: { success: true, data: {} } })
    const c = createWorkbenchBackupClient(t)
    for (const bad of ['', 'd1', '../x@1700000000000', 'd1@123', 'd1@1700000000000/x']) {
      expect(await c.trashGet(bad), bad).toMatchObject({ ok: false, code: 'INVALID' })
      expect(await c.trashConfirm(bad), bad).toMatchObject({ ok: false, code: 'INVALID' })
      expect(await c.trashPurge(bad), bad).toMatchObject({ ok: false, code: 'INVALID' })
      expect(await c.trashRestore(bad), bad).toMatchObject({ ok: false, code: 'INVALID' })
    }
    expect(t.send).not.toHaveBeenCalled()
  })

  it.each([
    [409, { success: false, code: 'TRASH_FULL', error: '回收站满了' }, 'TOO_MANY'],
    [400, { success: false, code: 'INVALID_TRASH_ID', error: 'id 不对' }, 'INVALID'],
    [404, { success: false, code: 'NOT_FOUND', error: '回收站里没有这一项' }, 'NOT_FOUND'],
  ])('回收站错误码 HTTP %i %j → %s', async (status, body, code) => {
    const r = await createWorkbenchBackupClient(transport({ status, body })).trashList()
    expect(r).toMatchObject({ ok: false, code })
  })
})
