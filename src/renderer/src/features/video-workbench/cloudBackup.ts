// 工作台云备份:把每部剧按「工程文件」(.catwb.json,URL-first)传到服务端私有桶,
// 以平台账号为界;换机 / 清缓存后可从云端取回成一部新剧。
//
// 与 store / React 解耦 —— 调用方把快照和一组 api 函数传进来,测试直接喂假的。
//
// 刻意的取舍:
// - **不上传本地素材**。备份是后台自动做的,不能在用户没点任何按钮时偷偷从磁盘传大文件;
//   只有本机路径 / data: 的素材与「只有本地副本」的成片会从云端副本里略去(计数后告知用户),
//   手动「导出工程」仍会上传它们。已是 https(拖入即传 / 生成结果)的照常带上。
// - **没有持久化的同步状态**:每个会话第一次先 `list()` 取云端各剧的内容指纹,之后只传内容变了的。
//   服务端也按同一指纹去重(内容没变 → `unchanged`,不写对象),所以重复传只是多一次请求。
// - 回收站里的剧不在快照里 → 不备份,但**云端旧副本不会因此被删**(备份的意义就是删错了还能找回)。

import type { VideoWorkbenchBoard, VideoWorkbenchCard, VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import type {
  WorkbenchBackupErrorCode,
  WorkbenchBackupGetData,
  WorkbenchBackupItem,
  WorkbenchBackupPutData,
  WorkbenchBackupPutInput,
  WorkbenchBackupResult,
} from '../../../../types/workbenchBackup'
import { buildProjectFile, parseProjectFile, type ProjectFileSummary, type WorkbenchProjectFile } from './projectFile'

export interface CloudBackupApi {
  list: () => Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>>
  put: (input: { dramaId: string } & WorkbenchBackupPutInput) => Promise<WorkbenchBackupResult<WorkbenchBackupPutData>>
  get: (dramaId: string, version?: string) => Promise<WorkbenchBackupResult<WorkbenchBackupGetData>>
}

/** preload 暴露的完整通道(备份流程只用 list/put/get;对话框另用 remove)。 */
export interface CloudBackupBridge extends CloudBackupApi {
  remove: (dramaId: string) => Promise<WorkbenchBackupResult<{ removed: number }>>
}

export interface BackupSnapshot {
  projects: readonly VideoWorkbenchProject[]
  boards: readonly VideoWorkbenchBoard[]
  cards: readonly VideoWorkbenchCard[]
}

export interface BackupSyncState {
  /** 是否已用云端 list 对过账。 */
  seeded: boolean
  /** dramaId → 云端已确认收下的内容指纹。 */
  acked: Map<string, string>
}

export function createBackupSyncState(): BackupSyncState {
  return { seeded: false, acked: new Map() }
}

// ---------------------------------------------------------------------------
// 构建 + 指纹
// ---------------------------------------------------------------------------

export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 内容指纹,与服务端 `contentHash` 同口径:去掉每次导出都变的 `exportedAt` 和升级就变的 `app`。
 * 键序依赖 `buildProjectFile` 的构造顺序(与服务端对解析后的 JSON 取 rest 一致)。
 */
export async function fingerprintFile(file: WorkbenchProjectFile): Promise<string | null> {
  const { exportedAt: _e, app: _a, ...content } = file
  return sha256Hex(JSON.stringify(content))
}

export interface PreparedBackup {
  file: WorkbenchProjectFile
  cards: number
  /** 因只在本机而没带进云端副本的素材 / 成片个数(按不同源去重)。 */
  localOnly: number
  /** 这部剧最近一次有动静的时间(剧本身改名 / 任一卡片更新)。 */
  activityAt: number
}

export function prepareBackup(
  project: VideoWorkbenchProject,
  boards: readonly VideoWorkbenchBoard[],
  cards: readonly VideoWorkbenchCard[],
  app: { name: string; version: string },
  now: number,
): PreparedBackup | null {
  const own = boards.filter((b) => b.projectId === project.id)
  const ownIds = new Set(own.map((b) => b.id))
  const ownCards = cards.filter((c) => !!c.boardId && ownIds.has(c.boardId))
  const localSrcs = new Set<string>()
  const built = buildProjectFile({
    project,
    boards: own,
    cards: ownCards,
    app,
    now,
    resolve: (src) => {
      localSrcs.add(src)
      return 'skip'
    },
  })
  // resolve 恒为 'skip' 时不会有 missing,保险起见仍当不可备份处理而不是抛。
  if (!built.ok) return null
  let activityAt = project.updatedAt
  for (const c of ownCards) if (c.updatedAt > activityAt) activityAt = c.updatedAt
  return { file: built.file, cards: ownCards.length, localOnly: localSrcs.size, activityAt }
}

// ---------------------------------------------------------------------------
// 一轮备份
// ---------------------------------------------------------------------------

export interface BackupFailure {
  dramaId: string
  name: string
  code: WorkbenchBackupErrorCode
  message: string
}

export interface BackupPassResult {
  uploaded: number
  /** 内容与云端一致,没传。 */
  unchanged: number
  /** 没有任何卡片的空剧,不备份。 */
  empty: number
  /** 本轮涉及的剧里因只在本机而没进云端副本的素材 / 成片总数。 */
  localOnly: number
  failures: BackupFailure[]
  /** 非空 = 这一轮被整体中止(未登录 / 服务端没开 / 连续网络失败)。 */
  stopped: WorkbenchBackupErrorCode | null
}

export interface RunBackupPassOptions {
  api: CloudBackupApi
  snapshot: BackupSnapshot
  state: BackupSyncState
  app: { name: string; version: string }
  now?: number
  /** 连续这么多次 NETWORK / SERVER 失败就放弃本轮,留给下次改动再试。默认 2。 */
  maxConsecutiveTransportFailures?: number
}

/** 这些码意味着「再试也没用」,整轮中止。 */
const STOP_CODES: ReadonlySet<WorkbenchBackupErrorCode> = new Set(['NOT_AUTHENTICATED', 'NOT_CONFIGURED'])
const TRANSPORT_CODES: ReadonlySet<WorkbenchBackupErrorCode> = new Set(['NETWORK', 'SERVER'])

export async function runBackupPass(opts: RunBackupPassOptions): Promise<BackupPassResult> {
  const result: BackupPassResult = { uploaded: 0, unchanged: 0, empty: 0, localOnly: 0, failures: [], stopped: null }
  const { api, snapshot, state } = opts
  const now = opts.now ?? Date.now()
  const maxTransport = opts.maxConsecutiveTransportFailures ?? 2

  if (!state.seeded) {
    const listed = await api.list()
    if (!listed.ok) {
      result.stopped = listed.code
      return result
    }
    for (const item of listed.data.items) {
      if (item.sha256) state.acked.set(item.dramaId, item.sha256)
    }
    state.seeded = true
  }

  let consecutiveTransport = 0
  for (const project of snapshot.projects) {
    const prepared = prepareBackup(project, snapshot.boards, snapshot.cards, opts.app, now)
    if (!prepared) continue
    if (prepared.cards === 0) {
      result.empty += 1
      continue
    }
    const fingerprint = await fingerprintFile(prepared.file)
    if (fingerprint && state.acked.get(project.id) === fingerprint) {
      result.unchanged += 1
      result.localOnly += prepared.localOnly
      continue
    }
    const put = await api.put({
      dramaId: project.id,
      name: project.name,
      clientUpdatedAt: prepared.activityAt,
      file: prepared.file,
    })
    if (put.ok) {
      consecutiveTransport = 0
      if (fingerprint) state.acked.set(project.id, fingerprint)
      if (put.data.unchanged) result.unchanged += 1
      else result.uploaded += 1
      result.localOnly += prepared.localOnly
      continue
    }
    if (STOP_CODES.has(put.code)) {
      result.stopped = put.code
      return result
    }
    result.failures.push({ dramaId: project.id, name: project.name, code: put.code, message: put.message })
    if (TRANSPORT_CODES.has(put.code)) {
      consecutiveTransport += 1
      if (consecutiveTransport >= maxTransport) {
        result.stopped = put.code
        return result
      }
    } else {
      consecutiveTransport = 0
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 从云端取回
// ---------------------------------------------------------------------------

export type FetchBackupResult =
  | { ok: true; file: WorkbenchProjectFile; summary: ProjectFileSummary; version: string }
  | { ok: false; code: WorkbenchBackupErrorCode | 'CORRUPT'; message: string }

/** 取回的云端副本再过一遍加固解析(与「导入工程」同一道闸),不信任存储里的内容。 */
export async function fetchBackupFile(
  api: Pick<CloudBackupApi, 'get'>,
  dramaId: string,
  version?: string,
): Promise<FetchBackupResult> {
  const got = await api.get(dramaId, version)
  if (!got.ok) return { ok: false, code: got.code, message: got.message }
  const parsed = parseProjectFile(JSON.stringify(got.data.file))
  if (!parsed.ok) return { ok: false, code: 'CORRUPT', message: `云端副本无法解析:${parsed.reason}` }
  return { ok: true, file: parsed.file, summary: parsed.summary, version: got.data.version }
}
