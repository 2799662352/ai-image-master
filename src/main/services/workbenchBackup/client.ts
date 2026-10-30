// 视频工作台云备份的主进程客户端:把 `/api/workbench-backup` 的 HTTP 形状收成
// `{ ok, data } | { ok:false, code, message }`,渲染层按 code 分支,不用认 HTTP 状态码。
//
// 鉴权用平台 JWT(`requireToken`),与人像库同一条后端、同一个登录态;**不是**走网关的
// 计费令牌(那条路径有「花完要上报余额」的守卫测试),所以不扣费、也不需要上报。
//
// 传输层可注入:单测直接喂假的,不碰 electron / 网络。

import {
  WORKBENCH_BACKUP_MAX_BYTES,
  type WorkbenchBackupErrorCode,
  type WorkbenchBackupGetData,
  type WorkbenchBackupItem,
  type WorkbenchBackupPutData,
  type WorkbenchBackupPutInput,
  type WorkbenchBackupResult,
  type WorkbenchBackupVersion,
} from '../../../types/workbenchBackup'

export interface BackupTransport {
  send(
    path: string,
    method: 'GET' | 'PUT' | 'DELETE',
    opts?: { body?: Record<string, unknown>; timeoutMs?: number },
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

export interface WorkbenchBackupClient {
  list(): Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>>
  put(dramaId: string, input: WorkbenchBackupPutInput): Promise<WorkbenchBackupResult<WorkbenchBackupPutData>>
  get(dramaId: string, version?: string): Promise<WorkbenchBackupResult<WorkbenchBackupGetData>>
  versions(dramaId: string): Promise<WorkbenchBackupResult<{ versions: WorkbenchBackupVersion[] }>>
  remove(dramaId: string): Promise<WorkbenchBackupResult<{ removed: number }>>
}

const PATH = '/api/workbench-backup'
const DRAMA_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const VERSION_RE = /^\d{13}-[0-9a-f]{8}$/
/** 上传一份几百 KB 的 JSON,慢网下 15 秒的默认超时不够。 */
const PUT_TIMEOUT_MS = 60_000

/** 传输层抛出的「没登录」。主进程里是 `AuthError('NOT_AUTHENTICATED')`;用鸭子类型避免这里依赖 electron。 */
function isNotAuthenticated(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'NOT_AUTHENTICATED'
}

function fail(code: WorkbenchBackupErrorCode, message: string): { ok: false; code: WorkbenchBackupErrorCode; message: string } {
  return { ok: false, code, message }
}

const SERVER_CODE_MAP: Record<string, WorkbenchBackupErrorCode> = {
  UNAUTHORIZED: 'NOT_AUTHENTICATED',
  BACKUP_NOT_CONFIGURED: 'NOT_CONFIGURED',
  FILE_TOO_LARGE: 'TOO_LARGE',
  TOO_MANY_DRAMAS: 'TOO_MANY',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_USER: 'NOT_AUTHENTICATED',
  INVALID_DRAMA_ID: 'INVALID',
  INVALID_VERSION: 'INVALID',
  INVALID_FILE: 'INVALID',
  SNAPSHOT_CORRUPT: 'SERVER',
  BACKUP_STORAGE_ERROR: 'SERVER',
}

function mapFailure(status: number, body: Record<string, unknown>): { ok: false; code: WorkbenchBackupErrorCode; message: string } {
  const serverCode = typeof body.code === 'string' ? body.code : ''
  const detail = typeof body.error === 'string' && body.error ? body.error : `请求失败(HTTP ${status})`
  const mapped = SERVER_CODE_MAP[serverCode]
  if (mapped) return fail(mapped, detail)
  if (status === 401 || status === 403) return fail('NOT_AUTHENTICATED', '登录已失效,请重新登录')
  if (status === 413) return fail('TOO_LARGE', detail)
  // 带不上我们的错误码的 404 = 后端还没部署这组接口(旧版本),不是「这部剧不存在」。
  if (status === 404 || status === 503) return fail('NOT_CONFIGURED', '云备份服务暂未开通')
  return fail('SERVER', detail)
}

export function createWorkbenchBackupClient(transport: BackupTransport): WorkbenchBackupClient {
  async function call<T>(
    path: string,
    method: 'GET' | 'PUT' | 'DELETE',
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

  const checkId = (dramaId: string) => (DRAMA_ID_RE.test(dramaId) ? null : fail('INVALID', '剧 id 不合法'))

  return {
    list: () =>
      call(PATH, 'GET', undefined, (d) => ({ items: Array.isArray(d.items) ? (d.items as WorkbenchBackupItem[]) : [] })),

    async put(dramaId, input) {
      const bad = checkId(dramaId)
      if (bad) return bad
      const body = { name: input.name, clientUpdatedAt: input.clientUpdatedAt, file: input.file }
      // 在发出去之前就拒:省一次必败的上传,也让「太大」成为本地可见的确定失败。
      if (Buffer.byteLength(JSON.stringify(body), 'utf8') > WORKBENCH_BACKUP_MAX_BYTES) {
        return fail('TOO_LARGE', '这部剧的工程文件太大,超过云备份上限')
      }
      return call(`${PATH}/${dramaId}`, 'PUT', { body, timeoutMs: PUT_TIMEOUT_MS }, (d) => d as unknown as WorkbenchBackupPutData)
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

    async remove(dramaId) {
      const bad = checkId(dramaId)
      if (bad) return bad
      return call(`${PATH}/${dramaId}`, 'DELETE', undefined, (d) => ({ removed: Number(d.removed) || 0 }))
    },
  }
}
