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
// - 本地回收站里的剧不在 projects 里 → 不备份。删除按「备份 ≠ 同步」处理:
//   本机删剧 → 云端副本**移入云端回收站**(别的设备能看到「这部剧被删了」,不会悄悄把它复活;
//   云端回收站最长留 60 天);本机彻底删除 → 通知云端把保留期收紧到 30 天;
//   别的设备删了、本机还有 → 不自动删本机,只提示并让用户选「继续备份」。

import type { VideoWorkbenchBoard, VideoWorkbenchCard, VideoWorkbenchProject } from '../../../../types/videoWorkbench'
import type {
  WorkbenchBackupErrorCode,
  WorkbenchBackupGetData,
  WorkbenchBackupItem,
  WorkbenchBackupPutData,
  WorkbenchBackupPutInput,
  WorkbenchBackupRemoveData,
  WorkbenchBackupResult,
  WorkbenchBackupTrashItem,
} from '../../../../types/workbenchBackup'
import { buildProjectFile, parseProjectFile, type ProjectFileSummary, type WorkbenchProjectFile } from './projectFile'

export interface CloudBackupApi {
  list: () => Promise<WorkbenchBackupResult<{ items: WorkbenchBackupItem[] }>>
  put: (input: { dramaId: string } & WorkbenchBackupPutInput) => Promise<WorkbenchBackupResult<WorkbenchBackupPutData>>
  get: (dramaId: string, version?: string) => Promise<WorkbenchBackupResult<WorkbenchBackupGetData>>
  /** 可选:没有它就不会把「本机删掉的剧」镜像到云端回收站(旧桥 / 测试假件)。默认移入云端回收站。 */
  remove?: (dramaId: string, opts?: { permanent?: boolean }) => Promise<WorkbenchBackupResult<WorkbenchBackupRemoveData>>
}

/** preload 暴露的完整通道。 */
export interface CloudBackupBridge extends CloudBackupApi {
  remove: (dramaId: string, opts?: { permanent?: boolean }) => Promise<WorkbenchBackupResult<WorkbenchBackupRemoveData>>
  trashList: () => Promise<WorkbenchBackupResult<{ items: WorkbenchBackupTrashItem[] }>>
  trashGet: (trashId: string, version?: string) => Promise<WorkbenchBackupResult<WorkbenchBackupGetData>>
  trashRestore: (trashId: string) => Promise<WorkbenchBackupResult<{ dramaId: string; version: string }>>
  trashConfirm: (trashId: string) => Promise<WorkbenchBackupResult<{ purgeAfter: number }>>
  trashPurge: (trashId: string) => Promise<WorkbenchBackupResult<{ removed: number }>>
}

export interface BackupSnapshot {
  projects: readonly VideoWorkbenchProject[]
  boards: readonly VideoWorkbenchBoard[]
  cards: readonly VideoWorkbenchCard[]
  /** 本机回收站里的剧(只要 id / 名字 / 删除时间):云端还有活副本的,这一轮移入云端回收站。 */
  trashedProjects?: readonly { id: string; name: string; deletedAt: number }[]
}

/** 云端回收站里有同号条目、挡住了这部剧的备份(别的设备删的):要用户决定,不是故障。 */
export interface TrashConflict {
  dramaId: string
  name: string
  trashId: string
  deletedAt: number
  purgeAfter: number
  /** 执行删除的设备名(客户端自报)。 */
  deviceName?: string
}

export interface BackupSyncState {
  /** 是否已用云端 list 对过账。 */
  seeded: boolean
  /** dramaId → 云端已确认收下的内容指纹。 */
  acked: Map<string, string>
  /** dramaId → 云端「活」副本的最后写入时间(服务端时钟;本机自己传的按本机时钟估)。镜像删除的护栏用。 */
  cloudAt: Map<string, number>
  /** 被云端回收站挡住的剧:内容指纹没变就不再重复请求,但每轮仍照实报告。 */
  blocked: Map<string, { fingerprint: string | null; conflict: TrashConflict }>
}

export function createBackupSyncState(): BackupSyncState {
  return { seeded: false, acked: new Map(), cloudAt: new Map(), blocked: new Map() }
}

/** 本机与服务端时钟的容差:云端比「本机删除」晚不到这么久不算「别的设备后来又改过」。 */
export const CLOUD_CLOCK_SKEW_MS = 5 * 60_000

/** 首次对账:list 一次,记下各剧的内容指纹与写入时间。失败返回错误码。 */
async function ensureSeeded(api: Pick<CloudBackupApi, 'list'>, state: BackupSyncState): Promise<WorkbenchBackupErrorCode | null> {
  if (state.seeded) return null
  const listed = await api.list()
  if (!listed.ok) return listed.code
  for (const item of listed.data.items) {
    if (item.sha256) state.acked.set(item.dramaId, item.sha256)
    state.cloudAt.set(item.dramaId, item.serverUpdatedAt)
  }
  state.seeded = true
  return null
}

function toConflict(dramaId: string, name: string, details?: Record<string, unknown>): TrashConflict {
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const device = typeof details?.deviceName === 'string' ? details.deviceName.trim() : ''
  return {
    dramaId,
    name,
    trashId: typeof details?.trashId === 'string' ? details.trashId : '',
    deletedAt: num(details?.deletedAt),
    purgeAfter: num(details?.purgeAfter),
    ...(device ? { deviceName: device } : {}),
  }
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
  /** 本轮把几部「本机已删」的剧移入了云端回收站。 */
  trashedRemote: number
  /** 被云端回收站挡住、等用户决定要不要继续备份的剧(别的设备删的)。 */
  trashConflicts: TrashConflict[]
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
  const result: BackupPassResult = {
    uploaded: 0,
    unchanged: 0,
    empty: 0,
    localOnly: 0,
    failures: [],
    stopped: null,
    trashedRemote: 0,
    trashConflicts: [],
  }
  const { api, snapshot, state } = opts
  const now = opts.now ?? Date.now()
  const maxTransport = opts.maxConsecutiveTransportFailures ?? 2

  const seedFailure = await ensureSeeded(api, state)
  if (seedFailure) {
    result.stopped = seedFailure
    return result
  }

  let consecutiveTransport = 0
  /** 记一次失败;返回 true = 这一轮该整体中止。 */
  const noteFailure = (dramaId: string, name: string, code: WorkbenchBackupErrorCode, message: string): boolean => {
    if (STOP_CODES.has(code)) {
      result.stopped = code
      return true
    }
    result.failures.push({ dramaId, name, code, message })
    if (TRANSPORT_CODES.has(code)) {
      consecutiveTransport += 1
      if (consecutiveTransport >= maxTransport) {
        result.stopped = code
        return true
      }
    } else {
      consecutiveTransport = 0
    }
    return false
  }

  // 先把「本机已删、云端还有活副本」的剧移入云端回收站。护栏:云端副本比这次删除新(别的设备删后
  // 又改过)就不动 —— 那份改动是更新的信息;误删也只是进云端回收站,还能取回。
  if (api.remove) {
    for (const gone of snapshot.trashedProjects ?? []) {
      const cloudAt = state.cloudAt.get(gone.id)
      if (cloudAt === undefined || cloudAt - CLOUD_CLOCK_SKEW_MS > gone.deletedAt) continue
      const removed = await api.remove(gone.id)
      if (removed.ok) {
        consecutiveTransport = 0
        state.cloudAt.delete(gone.id)
        state.acked.delete(gone.id)
        state.blocked.delete(gone.id)
        result.trashedRemote += 1
        continue
      }
      if (noteFailure(gone.id, gone.name, removed.code, removed.message)) return result
    }
  }

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
    const blocked = state.blocked.get(project.id)
    if (blocked && fingerprint && blocked.fingerprint === fingerprint) {
      result.trashConflicts.push(blocked.conflict)
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
      state.cloudAt.set(project.id, now)
      state.blocked.delete(project.id)
      if (put.data.unchanged) result.unchanged += 1
      else result.uploaded += 1
      result.localOnly += prepared.localOnly
      continue
    }
    if (put.code === 'TRASHED') {
      // 云端回收站里有同号条目(别的设备删的):不是故障,不计入失败与连续失败。
      const conflict = toConflict(project.id, project.name, put.details)
      state.blocked.set(project.id, { fingerprint, conflict })
      result.trashConflicts.push(conflict)
      consecutiveTransport = 0
      continue
    }
    if (noteFailure(project.id, project.name, put.code, put.message)) return result
  }
  return result
}

export type ReviveBackupResult =
  | { ok: true; unchanged: boolean }
  | { ok: false; code: WorkbenchBackupErrorCode; message: string }

/**
 * 用户在冲突提示里选了「继续备份」:带 `revive` 重发这一部剧,云端据此重新建立活副本。
 * 只在用户明确点了才会走到这里 —— 别的设备删的剧不能被自动复活。
 */
export async function reviveBackup(opts: {
  api: Pick<CloudBackupApi, 'put'>
  snapshot: BackupSnapshot
  state: BackupSyncState
  app: { name: string; version: string }
  dramaId: string
  now?: number
}): Promise<ReviveBackupResult> {
  const { api, snapshot, state, dramaId } = opts
  const now = opts.now ?? Date.now()
  const project = snapshot.projects.find((p) => p.id === dramaId)
  if (!project) return { ok: false, code: 'NOT_FOUND', message: '这部剧已经不在本机了' }
  const prepared = prepareBackup(project, snapshot.boards, snapshot.cards, opts.app, now)
  if (!prepared || prepared.cards === 0) return { ok: false, code: 'INVALID', message: '这部剧还没有镜头,没有可备份的内容' }
  const put = await api.put({
    dramaId,
    name: project.name,
    clientUpdatedAt: prepared.activityAt,
    file: prepared.file,
    revive: true,
  })
  if (!put.ok) return { ok: false, code: put.code, message: put.message }
  const fingerprint = await fingerprintFile(prepared.file)
  if (fingerprint) state.acked.set(dramaId, fingerprint)
  state.cloudAt.set(dramaId, now)
  state.blocked.delete(dramaId)
  return { ok: true, unchanged: put.data.unchanged }
}

// ---------------------------------------------------------------------------
// 本机彻底删除 → 通知云端
// ---------------------------------------------------------------------------

/** 一部在本机被彻底删除(清空回收站 / 逐项删除 / 30 天到期)的剧。 */
export interface PurgedProject {
  id: string
  name: string
  /** 它进本机回收站的时间。 */
  deletedAt: number
  purgedAt: number
}

export interface SettlePurgedResult {
  /** 补做了几次「活副本 → 云端回收站」(没来得及镜像就被彻底删了)。 */
  trashed: number
  /** 把几条云端回收站记录的保留期收紧到 30 天。 */
  confirmed: number
  failed: number
  stopped: WorkbenchBackupErrorCode | null
}

/**
 * 本机彻底删除了一些剧:① 云端若还有活副本,先移入云端回收站;② 云端回收站里这部剧的记录
 * 通知「本机已彻底删除」,把保留期从最长 60 天收紧到 30 天。尽力而为 —— 失败不抛、不重试
 * (云端回收站本来就最长 60 天后清掉,这里只是让它早点走)。
 */
export async function settlePurgedProjects(
  api: Pick<CloudBackupBridge, 'list' | 'remove' | 'trashList' | 'trashConfirm'>,
  state: BackupSyncState,
  purged: readonly PurgedProject[],
): Promise<SettlePurgedResult> {
  const out: SettlePurgedResult = { trashed: 0, confirmed: 0, failed: 0, stopped: null }
  if (purged.length === 0) return out
  const seedFailure = await ensureSeeded(api, state)
  if (seedFailure) {
    out.stopped = seedFailure
    return out
  }

  for (const p of purged) {
    const cloudAt = state.cloudAt.get(p.id)
    if (cloudAt === undefined || cloudAt - CLOUD_CLOCK_SKEW_MS > p.deletedAt) continue
    const r = await api.remove(p.id)
    if (r.ok) {
      state.cloudAt.delete(p.id)
      state.acked.delete(p.id)
      state.blocked.delete(p.id)
      out.trashed += 1
    } else if (STOP_CODES.has(r.code)) {
      out.stopped = r.code
      return out
    } else {
      out.failed += 1
    }
  }

  const listed = await api.trashList()
  if (!listed.ok) {
    out.stopped = STOP_CODES.has(listed.code) ? listed.code : null
    out.failed += 1
    return out
  }
  const byId = new Map(purged.map((p) => [p.id, p]))
  for (const item of listed.data.items) {
    const p = byId.get(item.dramaId)
    if (!p) continue
    // 本机彻底删除之后才在别处删的那条,是另一次删除,不是这次要结案的
    if (item.deletedAt - CLOUD_CLOCK_SKEW_MS > p.purgedAt) continue
    const c = await api.trashConfirm(item.trashId)
    if (c.ok) out.confirmed += 1
    else if (STOP_CODES.has(c.code)) {
      out.stopped = c.code
      return out
    } else out.failed += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// 从云端取回
// ---------------------------------------------------------------------------

export type FetchBackupResult =
  | { ok: true; file: WorkbenchProjectFile; summary: ProjectFileSummary; version: string }
  | { ok: false; code: WorkbenchBackupErrorCode | 'CORRUPT'; message: string }

/** 取回的云端副本再过一遍加固解析(与「导入工程」同一道闸),不信任存储里的内容。 */
function parseFetched(got: WorkbenchBackupResult<WorkbenchBackupGetData>): FetchBackupResult {
  if (!got.ok) return { ok: false, code: got.code, message: got.message }
  const parsed = parseProjectFile(JSON.stringify(got.data.file))
  if (!parsed.ok) return { ok: false, code: 'CORRUPT', message: `云端副本无法解析:${parsed.reason}` }
  return { ok: true, file: parsed.file, summary: parsed.summary, version: got.data.version }
}

export async function fetchBackupFile(
  api: Pick<CloudBackupApi, 'get'>,
  dramaId: string,
  version?: string,
): Promise<FetchBackupResult> {
  return parseFetched(await api.get(dramaId, version))
}

/** 取云端回收站里那份(最新一版)—— 「取回为新剧」用,同样走加固解析。 */
export async function fetchTrashedBackupFile(
  api: Pick<CloudBackupBridge, 'trashGet'>,
  trashId: string,
  version?: string,
): Promise<FetchBackupResult> {
  return parseFetched(await api.trashGet(trashId, version))
}
