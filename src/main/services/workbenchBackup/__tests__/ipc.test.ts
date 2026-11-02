// 主进程接线:五个通道转给 client;preload 里手写的通道名要和这里的常量一致
// (preload 不能 import 这个文件 —— 它会把 electron 主进程模块拖进预加载包)。

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>()

vi.mock('electron', () => ({
  app: { isPackaged: true },
  net: { fetch: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, payload?: unknown) => Promise<unknown>) => {
      handlers.set(channel, fn)
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel)
    }),
  },
}))

vi.mock('../../auth/httpJson', () => ({
  requireToken: vi.fn(() => 'jwt'),
  sendJson: vi.fn(),
}))

import { WORKBENCH_BACKUP_IPC, registerWorkbenchBackupIpc } from '../ipc'
import type { WorkbenchBackupClient } from '../client'

const CLIENT_METHODS = [
  'list',
  'put',
  'get',
  'versions',
  'remove',
  'trashList',
  'trashGet',
  'trashRestore',
  'trashConfirm',
  'trashPurge',
] as const

function fakeClient() {
  const ok = async () => ({ ok: true as const, data: {} })
  return Object.fromEntries(CLIENT_METHODS.map((m) => [m, vi.fn(ok)])) as unknown as WorkbenchBackupClient &
    Record<(typeof CLIENT_METHODS)[number], ReturnType<typeof vi.fn>>
}

describe('registerWorkbenchBackupIpc', () => {
  beforeEach(() => handlers.clear())

  it('注册全部通道', () => {
    registerWorkbenchBackupIpc(fakeClient())
    expect([...handlers.keys()].sort()).toEqual(Object.values(WORKBENCH_BACKUP_IPC).sort())
  })

  it('put:收窄入参后转给 client', async () => {
    const client = fakeClient()
    registerWorkbenchBackupIpc(client)
    const file = { format: 'x' }
    await handlers.get(WORKBENCH_BACKUP_IPC.PUT)!({}, { dramaId: 'd1', name: 'A', clientUpdatedAt: 9, file })
    expect(client.put).toHaveBeenCalledWith('d1', { name: 'A', clientUpdatedAt: 9, file })
  })

  it('put:没有工程文件 / 非对象直接拒,不打 client', async () => {
    const client = fakeClient()
    registerWorkbenchBackupIpc(client)
    for (const bad of [undefined, null, 'str', { dramaId: 'd1' }, { dramaId: 'd1', file: 'x' }]) {
      expect(await handlers.get(WORKBENCH_BACKUP_IPC.PUT)!({}, bad)).toMatchObject({ ok: false, code: 'INVALID' })
    }
    expect(client.put).not.toHaveBeenCalled()
  })

  it('get / versions / remove:把 dramaId(与版本)交给 client;缺省给空串让 client 去拒', async () => {
    const client = fakeClient()
    registerWorkbenchBackupIpc(client)
    await handlers.get(WORKBENCH_BACKUP_IPC.GET)!({}, { dramaId: 'd1', version: '0000000000001-aaaaaaaa' })
    expect(client.get).toHaveBeenCalledWith('d1', '0000000000001-aaaaaaaa')
    await handlers.get(WORKBENCH_BACKUP_IPC.GET)!({}, { dramaId: 'd1' })
    expect(client.get).toHaveBeenLastCalledWith('d1', undefined)
    await handlers.get(WORKBENCH_BACKUP_IPC.VERSIONS)!({}, { dramaId: 'd1' })
    expect(client.versions).toHaveBeenCalledWith('d1')
    await handlers.get(WORKBENCH_BACKUP_IPC.REMOVE)!({}, null)
    expect(client.remove).toHaveBeenCalledWith('')
  })

  it('put:只有明确的 revive:true 才转发,别的真值一律当没有', async () => {
    const client = fakeClient()
    registerWorkbenchBackupIpc(client)
    const file = { format: 'x' }
    await handlers.get(WORKBENCH_BACKUP_IPC.PUT)!({}, { dramaId: 'd1', name: 'A', clientUpdatedAt: 1, file, revive: true })
    expect(client.put).toHaveBeenLastCalledWith('d1', { name: 'A', clientUpdatedAt: 1, file, revive: true })
    await handlers.get(WORKBENCH_BACKUP_IPC.PUT)!({}, { dramaId: 'd1', name: 'A', clientUpdatedAt: 1, file, revive: 'yes' })
    expect(client.put).toHaveBeenLastCalledWith('d1', { name: 'A', clientUpdatedAt: 1, file })
  })

  it('remove:permanent 只认 true;默认是移入云端回收站', async () => {
    const client = fakeClient()
    registerWorkbenchBackupIpc(client)
    await handlers.get(WORKBENCH_BACKUP_IPC.REMOVE)!({}, { dramaId: 'd1' })
    expect(client.remove).toHaveBeenLastCalledWith('d1')
    await handlers.get(WORKBENCH_BACKUP_IPC.REMOVE)!({}, { dramaId: 'd1', permanent: 1 })
    expect(client.remove).toHaveBeenLastCalledWith('d1')
    await handlers.get(WORKBENCH_BACKUP_IPC.REMOVE)!({}, { dramaId: 'd1', permanent: true })
    expect(client.remove).toHaveBeenLastCalledWith('d1', { permanent: true })
  })

  it('回收站通道:把 trashId(与版本)交给 client;缺省给空串让 client 去拒', async () => {
    const client = fakeClient()
    registerWorkbenchBackupIpc(client)
    const id = 'd1@1700000000000'
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_LIST)!({})
    expect(client.trashList).toHaveBeenCalledTimes(1)
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_GET)!({}, { trashId: id, version: '0000000000001-aaaaaaaa' })
    expect(client.trashGet).toHaveBeenLastCalledWith(id, '0000000000001-aaaaaaaa')
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_GET)!({}, { trashId: id })
    expect(client.trashGet).toHaveBeenLastCalledWith(id, undefined)
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_RESTORE)!({}, { trashId: id })
    expect(client.trashRestore).toHaveBeenCalledWith(id)
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_CONFIRM)!({}, { trashId: id })
    expect(client.trashConfirm).toHaveBeenCalledWith(id)
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_PURGE)!({}, { trashId: id })
    expect(client.trashPurge).toHaveBeenCalledWith(id)
    await handlers.get(WORKBENCH_BACKUP_IPC.TRASH_PURGE)!({}, null)
    expect(client.trashPurge).toHaveBeenLastCalledWith('')
  })

  it('preload 里手写的通道名与这里的常量一致', () => {
    const src = readFileSync(resolve(__dirname, '../../../../preload/index.ts'), 'utf8')
    for (const channel of Object.values(WORKBENCH_BACKUP_IPC)) {
      expect(src, `preload 缺少通道 ${channel}`).toContain(`'${channel}'`)
    }
  })
})
