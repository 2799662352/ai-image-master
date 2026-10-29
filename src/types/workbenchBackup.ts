// 视频工作台云备份的共享契约(主进程 / preload / 渲染层共用)。
//
// 服务端是 sora-ui-backend 的 `/api/workbench-backup`(私有桶,按 JWT 用户隔离)。
// 备份单元 = 工程文件(`projectFile.ts` 的 `WorkbenchProjectFile`),一部剧一份。

/**
 * 序列化后单份上限。服务端全局 JSON 解析是 5 MB、其自身上限 4.5 MB,这里略低,
 * 让「太大」在本地就报出来,而不是等一个 413。
 */
export const WORKBENCH_BACKUP_MAX_BYTES = 4_400_000

/** 每个账号在云端最多存多少部剧(与服务端 `BACKUP_LIMITS.maxDramasPerUser` 一致,只用于提示文案)。 */
export const WORKBENCH_BACKUP_MAX_DRAMAS = 300

/** 云端一部剧的摘要(列表用),字段与服务端 `DramaListItem` 一一对应。 */
export interface WorkbenchBackupItem {
  /** = 本地 `VideoWorkbenchProject.id`。 */
  dramaId: string
  name: string
  version: string
  /** 内容指纹:sha256(JSON.stringify(工程文件去掉 exportedAt / app))。 */
  sha256: string
  bytes: number
  boards: number
  cards: number
  clientUpdatedAt: number
  serverUpdatedAt: number
  /** 云端保留的快照份数。 */
  versions: number
}

export interface WorkbenchBackupVersion {
  version: string
  at: number
  size: number
}

export interface WorkbenchBackupPutInput {
  name: string
  clientUpdatedAt: number
  /** 工程文件(渲染层 `buildProjectFile` 的产物)。主进程只转发,不解释。 */
  file: unknown
}

export interface WorkbenchBackupPutData {
  unchanged: boolean
  version: string
  bytes: number
  boards: number
  cards: number
}

export interface WorkbenchBackupGetData {
  file: unknown
  version: string
}

/**
 * 失败原因归类 —— 界面按它决定「是否还要继续试」:
 *  - `NOT_AUTHENTICATED`  没登录:静默等下次改动,不打扰。
 *  - `NOT_CONFIGURED`     服务端没开(没配桶 / 还是旧版本):本次会话不再试。
 *  - `NETWORK` / `SERVER` 瞬时:下一轮再试。
 *  - `TOO_LARGE` / `TOO_MANY` / `INVALID` / `NOT_FOUND`  对这份数据是确定的失败,重试没用。
 */
export type WorkbenchBackupErrorCode =
  | 'NOT_AUTHENTICATED'
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'SERVER'
  | 'TOO_LARGE'
  | 'TOO_MANY'
  | 'INVALID'
  | 'NOT_FOUND'

export type WorkbenchBackupResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WorkbenchBackupErrorCode; message: string }
