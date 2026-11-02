// 视频工作台云备份的主进程接线:IPC 通道,背后是 `client.ts`。
//
// 为什么走主进程:平台 JWT 只活在主进程(`auth/credentials.ts`),不经 IPC 下发。
// 渲染层只管「建工程文件 / 解析 / 调度」,要上传时把文件交给这里。

import { hostname } from 'node:os'
import { ipcMain } from 'electron'
import type {
  WorkbenchBackupGetData,
  WorkbenchBackupItem,
  WorkbenchBackupPutData,
  WorkbenchBackupPutInput,
  WorkbenchBackupRemoveData,
  WorkbenchBackupResult,
  WorkbenchBackupTrashItem,
  WorkbenchBackupVersion,
} from '../../../types/workbenchBackup'
import { requireToken, sendJson } from '../auth/httpJson'
import { createWorkbenchBackupClient, type BackupTransport, type WorkbenchBackupClient } from './client'

export const WORKBENCH_BACKUP_IPC = {
  LIST: 'workbench-backup:list',
  PUT: 'workbench-backup:put',
  GET: 'workbench-backup:get',
  VERSIONS: 'workbench-backup:versions',
  REMOVE: 'workbench-backup:remove',
  TRASH_LIST: 'workbench-backup:trash-list',
  TRASH_GET: 'workbench-backup:trash-get',
  TRASH_RESTORE: 'workbench-backup:trash-restore',
  TRASH_CONFIRM: 'workbench-backup:trash-confirm',
  TRASH_PURGE: 'workbench-backup:trash-purge',
} as const

/** 现取 token:登出 / 换号后下一次请求自然用新的,没有要失效的缓存。 */
const defaultTransport: BackupTransport = {
  async send(path, method, opts) {
    const token = requireToken()
    return sendJson(path, method, { token, body: opts?.body, timeoutMs: opts?.timeoutMs })
  },
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

const invalid = (message: string) => ({ ok: false as const, code: 'INVALID' as const, message })

/** 本机设备名:主机名只是给「在哪台设备上删的」提示用的标签,不是身份凭据。 */
function localDeviceName(): string {
  try {
    return hostname()
  } catch {
    return ''
  }
}

/**
 * 注册 IPC 通道。`client` 可注入(测试用)。入参来自渲染层(不可信),这里只做形状收窄,
 * 内容校验(id 字符集、体积)由 client 与服务端各守一遍。
 */
export function registerWorkbenchBackupIpc(
  client: WorkbenchBackupClient = createWorkbenchBackupClient(defaultTransport, { deviceName: localDeviceName() }),
): void {
  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.LIST)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.LIST,
    (): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>> => client.list(),
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.PUT)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.PUT,
    async (_event, payload: unknown): Promise<WorkbenchBackupResult<WorkbenchBackupPutData>> => {
      const p = (payload ?? {}) as {
        dramaId?: unknown
        name?: unknown
        clientUpdatedAt?: unknown
        file?: unknown
        revive?: unknown
      }
      if (typeof p.file !== 'object' || p.file === null) return invalid('缺少工程文件')
      const input: WorkbenchBackupPutInput = {
        name: asString(p.name),
        clientUpdatedAt: typeof p.clientUpdatedAt === 'number' ? p.clientUpdatedAt : 0,
        file: p.file,
        ...(p.revive === true ? { revive: true } : {}),
      }
      return client.put(asString(p.dramaId), input)
    },
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.GET)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.GET,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<WorkbenchBackupGetData>> => {
      const p = (payload ?? {}) as { dramaId?: unknown; version?: unknown }
      return client.get(asString(p.dramaId), typeof p.version === 'string' ? p.version : undefined)
    },
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.VERSIONS)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.VERSIONS,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<{ versions: WorkbenchBackupVersion[] }>> =>
      client.versions(asString((payload as { dramaId?: unknown } | null)?.dramaId)),
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.REMOVE)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.REMOVE,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<WorkbenchBackupRemoveData>> => {
      const p = (payload ?? {}) as { dramaId?: unknown; permanent?: unknown }
      const dramaId = asString(p.dramaId)
      return p.permanent === true ? client.remove(dramaId, { permanent: true }) : client.remove(dramaId)
    },
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.TRASH_LIST)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.TRASH_LIST,
    (): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupTrashItem[] }>> => client.trashList(),
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.TRASH_GET)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.TRASH_GET,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<WorkbenchBackupGetData>> => {
      const p = (payload ?? {}) as { trashId?: unknown; version?: unknown }
      return client.trashGet(asString(p.trashId), typeof p.version === 'string' ? p.version : undefined)
    },
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.TRASH_RESTORE)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.TRASH_RESTORE,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<{ dramaId: string; version: string }>> =>
      client.trashRestore(asString((payload as { trashId?: unknown } | null)?.trashId)),
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.TRASH_CONFIRM)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.TRASH_CONFIRM,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<{ purgeAfter: number }>> =>
      client.trashConfirm(asString((payload as { trashId?: unknown } | null)?.trashId)),
  )

  ipcMain.removeHandler(WORKBENCH_BACKUP_IPC.TRASH_PURGE)
  ipcMain.handle(
    WORKBENCH_BACKUP_IPC.TRASH_PURGE,
    (_event, payload: unknown): Promise<WorkbenchBackupResult<{ removed: number }>> =>
      client.trashPurge(asString((payload as { trashId?: unknown } | null)?.trashId)),
  )
}
