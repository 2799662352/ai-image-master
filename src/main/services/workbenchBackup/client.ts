// 视频工作台云备份的主进程客户端:把 `/api/workbench-backup` 的 HTTP 形状收成
// `{ ok, data } | { ok:false, code, message }`,渲染层按 code 分支,不用认 HTTP 状态码。
//
// 鉴权用平台 JWT(`requireToken`),与人像库同一条后端、同一个登录态;**不是**走网关的
// 计费令牌(那条路径有「花完要上报余额」的守卫测试),所以不扣费、也不需要上报。
//
// 传输层可注入:单测直接喂假的,不碰 electron / 网络。
//
// 云端回收站(服务端 sora-ui-backend #171):`DELETE /:dramaId` 默认是「移入回收站」而不是硬删;
// 回收站自己有 list / get / restore / confirm / purge 一组接口。设备名由本模块统一附上
// (删除时记「谁删的」,上传时记「谁最后写的」),渲染层不用管。

import {
  WORKBENCH_BACKUP_MAX_BYTES,
  type WorkbenchBackupErrorCode,
  type WorkbenchBackupGetData,
  type WorkbenchBackupItem,
  type WorkbenchBackupPutData,
  type WorkbenchBackupPutInput,
  type WorkbenchBackupRemoveData,
  type WorkbenchBackupResult,
  type WorkbenchBackupTrashItem,
  type WorkbenchBackupVersion,
} from '../../../types/workbenchBackup'

export interface BackupTransport {
  send(
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    opts?: { body?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface WorkbenchBackupClientOptions {
  /** 本机设备名(通常是主机名)。写进上传 / 删除请求,用于「在哪台设备上删的」提示。 */
  deviceName?: string
}

export interface WorkbenchBackupClient {
  list(): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>>
  put(dramaId: string, input: WorkbenchBackupPutInput): Promise<WorkbenchBackupResult<WorkbenchBackupPutData>>
  get(dramaId: string, version?: string): Promise<WorkbenchBackupResult<WorkbenchBackupGetData>>
  versions(dramaId: string): Promise<WorkbenchBackupResult<{ versions: WorkbenchBackupVersion[] }>>
  /** 默认移入云端回收站;`permanent` = 立即硬删(含历史版本)。 */
  remove(dramaId: string, opts?: { permanent?: boolean }): Promise<WorkbenchBackupResult<WorkbenchBackupRemoveData>>
  trashList(): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupTrashItem[] }>>
  trashGet(trashId: string, version?: string): Promise<WorkbenchBackupResult<WorkbenchBackupGetData>>
  trashRestore(trashId: string): Promise<WorkbenchBackupResult<{ dramaId: string; version: string }>>
  /** 本地已彻底删除:云端保留期收紧为 30 天。 */
  trashConfirm(trashId: string): Promise<WorkbenchBackupResult<{ purgeAfter: number }>>
  trashPurge(trashId: string): Promise<WorkbenchBackupResult<{ removed: number }>>
}

const PATH = '/api/workbench-backup'
const DRAMA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** 服务端保留的路由名:剧 id 叫它会撞上 `/trash`,本地先挡掉。 */
const RESERVED_DRAMA_IDS: ReadonlySet<string> = new Set(['trash'])
const TRASH_ID_RE = /^[A-Za-z0-9_-]{1,64}@\d{13}$/
const VERSION_RE = /^\d{13}-[0-9a-f]{8}$/
const DEVICE_NAME_MAX = 64
/** 上传一份几百 KB 的 JSON,慢网下 15 秒的默认超时不够。 */
const PUT_TIMEOUT_MS = 60_000

/** 传输层抛出的「没登录」。主进程里是 `AuthError('NOT_AUTHENTICATED')`;用鸭子类型避免这里依赖 electron。 */
function isNotAuthenticated(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'NOT_AUTHENTICATED'
}

type Failure = Extract<WorkbenchBackupResult<never>, { ok: false }>

function fail(code: WorkbenchBackupErrorCode, message: string, details?: Record<string, unknown>): Failure {
  return details ? { ok: false, code, message, details } : { ok: false, code, message }
}

const SERVER_CODE_MAP: Record<string, WorkbenchBackupErrorCode> = {
  UNAUTHORIZED: 'NOT_AUTHENTICATED',
  BACKUP_NOT_CONFIGURED: 'NOT_CONFIGURED',
  FILE_TOO_LARGE: 'TOO_LARGE',
  TOO_MANY_DRAMAS: 'TOO_MANY',
  TRASH_FULL: 'TOO_MANY',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_USER: 'NOT_AUTHENTICATED',
  INVALID_DRAMA_ID: 'INVALID',
  INVALID_TRASH_ID: 'INVALID',
  INVALID_VERSION: 'INVALID',
  INVALID_FILE: 'INVALID',
  DRAMA_TRASHED: 'TRASHED',
  DRAMA_EXISTS: 'EXISTS',
  SNAPSHOT_CORRUPT: 'SERVER',
  BACKUP_STORAGE_ERROR: 'SERVER',
}

function mapFailure(status: number, body: Record<string, unknown>): Failure {
  const serverCode = typeof body.code === 'string' ? body.code : ''
  const detail = typeof body.error === 'string' && body.error ? body.error : `请求失败(HTTP ${status})`
  const mapped = SERVER_CODE_MAP[serverCode]
  if (mapped) {
    const raw = body.details
    const details = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined
    return fail(mapped, detail, details)
  }
  if (status === 401 || status === 403) return fail('NOT_AUTHENTICATED', '登录已失效,请重新登录')
  if (status === 413) return fail('TOO_LARGE', detail)
  // 带不上我们的错误码的 404 = 后端还没部署这组接口(旧版本),不是「这部剧不存在」。
  if (status === 404 || status === 503) return fail('NOT_CONFIGURED', '云备份服务暂未开通')
  return fail('SERVER', detail)
}

function cleanDeviceName(raw: string | undefined): string | undefined {
  // 控制字符一律去掉(会进 HTTP 查询串和日志),再截长度。
  const name = (raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, DEVICE_NAME_MAX)
  return name || undefined
}

export function createWorkbenchBackupClient(
  transport: BackupTransport,
  options: WorkbenchBackupClientOptions = {},
): WorkbenchBackupClient {
  const deviceName = cleanDeviceName(options.deviceName)

  async function call<T>(
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    opts: { body?: Record<string, unknown>; timeoutMs?: number } | undefined,
    pick: (data: Record<string, unknown>) => T,
  ): Promise<WorkbenchBackupResult<T>> {
    let res: { status: number; body: Record<string, unknown> }
    try {
      res = await transport.send(path, method, opts)
    } catch (e) {
      if (isNotAuthenticated(e)) return fail('NOT_AUTHENTICATED', '请先登录')
      return fail('NETWORK', e instanceof Error ? e.message : String(e))
    }
    if (res.status >= 400 || res.body.success === false) return mapFailure(res.status, res.body)
    const data = res.body.data
    if (typeof data !== 'object' || data === null) return fail('SERVER', '服务端响应格式不对')
    return { ok: true, data: pick(data as Record<string, unknown>) }
  }

  const checkId = (dramaId: string) =>
    DRAMA_ID_RE.test(dramaId) && !RESERVED_DRAMA_IDS.has(dramaId) ? null : fail('INVALID', '剧 id 不合法')
  const checkTrashId = (trashId: string) => (TRASH_ID_RE.test(trashId) ? null : fail('INVALID', '回收站 id 不合法'))
  const trashPath = (trashId: string, tail = '') => `${PATH}/trash/${encodeURIComponent(trashId)}${tail}`

  async function putOnce(dramaId: string, input: WorkbenchBackupPutInput) {
    const body: Record<string, unknown> = { name: input.name, clientUpdatedAt: input.clientUpdatedAt, file: input.file }
    if (deviceName) body.deviceName = deviceName
    if (input.revive) body.revive = true
    // 在发出去之前就拒:省一次必败的上传,也让「太大」成为本地可见的确定失败。
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > WORKBENCH_BACKUP_MAX_BYTES) {
      return fail('TOO_LARGE', '这部剧的工程文件太大,超过云备份上限')
    }
    return call(`${PATH}/${dramaId}`, 'PUT', { body, timeoutMs: PUT_TIMEOUT_MS }, (d) => d as unknown as WorkbenchBackupPutData)
  }

  return {
    list: () =>
      call(PATH, 'GET', undefined, (d) => ({ items: Array.isArray(d.items) ? (d.items as WorkbenchBackupItem[]) : [] })),

    async put(dramaId, input) {
      const bad = checkId(dramaId)
      if (bad) return bad
      const first = await putOnce(dramaId, input)
      // 「本机删了又在本地回收站恢复」:云端那条回收站记录是本机自己留的,用户这次的意图明确,
      // 带 revive 重发一次。别的设备删的不在此列 —— 那要交给用户决定(不静默复活)。
      // 设备名只是自报的主机名,不是身份;误判的代价是一份备份回到云端,不丢任何东西。
      if (
        !first.ok
        && first.code === 'TRASHED'
        && !input.revive
        && deviceName
        && first.details?.deviceName === deviceName
      ) {
        return putOnce(dramaId, { ...input, revive: true })
      }
      return first
    },

    async get(dramaId, version) {
      const bad = checkId(dramaId)
      if (bad) return bad
      if (version !== undefined && !VERSION_RE.test(version)) return fail('INVALID', '版本号不合法')
      const q = version ? `?version=${encodeURIComponent(version)}` : ''
      return call(`${PATH}/${dramaId}${q}`, 'GET', { timeoutMs: PUT_TIMEOUT_MS }, (d) => ({ file: d.file, version: String(d.version ?? '') }))
    },

    async versions(dramaId) {
      const bad = checkId(dramaId)
      if (bad) return bad
      return call(`${PATH}/${dramaId}/versions`, 'GET', undefined, (d) => ({
        versions: Array.isArray(d.versions) ? (d.versions as WorkbenchBackupVersion[]) : [],
      }))
    },

    async remove(dramaId, opts) {
      const bad = checkId(dramaId)
      if (bad) return bad
      const q = opts?.permanent ? '?permanent=1' : deviceName ? `?deviceName=${encodeURIComponent(deviceName)}` : ''
      return call(`${PATH}/${dramaId}${q}`, 'DELETE', undefined, (d): WorkbenchBackupRemoveData => {
        const out: WorkbenchBackupRemoveData = { removed: Number(d.removed) || 0, trashed: d.trashed === true }
        if (typeof d.trashId === 'string') out.trashId = d.trashId
        if (typeof d.deletedAt === 'number') out.deletedAt = d.deletedAt
        if (typeof d.purgeAfter === 'number') out.purgeAfter = d.purgeAfter
        return out
      })
    },

    trashList: () =>
      call(`${PATH}/trash`, 'GET', undefined, (d) => ({
        items: Array.isArray(d.items) ? (d.items as WorkbenchBackupTrashItem[]) : [],
      })),

    async trashGet(trashId, version) {
      const bad = checkTrashId(trashId)
      if (bad) return bad
      if (version !== undefined && !VERSION_RE.test(version)) return fail('INVALID', '版本号不合法')
      const q = version ? `?version=${encodeURIComponent(version)}` : ''
      return call(`${trashPath(trashId)}${q}`, 'GET', { timeoutMs: PUT_TIMEOUT_MS }, (d) => ({
        file: d.file,
        version: String(d.version ?? ''),
      }))
    },

    async trashRestore(trashId) {
      const bad = checkTrashId(trashId)
      if (bad) return bad
      return call(trashPath(trashId, '/restore'), 'POST', undefined, (d) => ({
        dramaId: String(d.dramaId ?? ''),
        version: String(d.version ?? ''),
      }))
    },

    async trashConfirm(trashId) {
      const bad = checkTrashId(trashId)
      if (bad) return bad
      return call(trashPath(trashId, '/confirm'), 'POST', undefined, (d) => ({ purgeAfter: Number(d.purgeAfter) || 0 }))
    },

    async trashPurge(trashId) {
      const bad = checkTrashId(trashId)
      if (bad) return bad
      return call(trashPath(trashId), 'DELETE', undefined, (d) => ({ removed: Number(d.removed) || 0 }))
    },
  }
}
