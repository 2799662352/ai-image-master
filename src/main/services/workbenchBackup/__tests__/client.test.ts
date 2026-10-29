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
