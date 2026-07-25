// src/renderer/src/features/video-workbench/store.ts
/**
 * 「生成视频」工作台 —— 卡片状态单一真相源(zustand)。
 *
 * 人机协同的关键设计:页面 UI 与 MCP 工具(video_workbench_*,经
 * AgentToolExecutor)操作**同一个 store**,任何一方的改动双方立即可见。
 *
 * 生成链路:startCards() → 渲染端生成 clientId → `video-workbench:submit`
 * IPC(主进程复用 generate_video 的 buildContent/人像库导入/SeedanceTaskManager
 * 提交与后台轮询)→ 进度经既有 `seedance:task-update` 广播回流(source:
 * 'workbench'),applyTaskUpdate() 按 clientId 对齐卡片。
 *
 * 持久化:每次卡片变更 500ms 防抖写 IndexedDB(WorkbenchDb);视频结果本身由
 * 主进程落本地 mp4 + COS 永久 URL,卡片只背地址(与音频页「本地文件 + COS +
 * IndexedDB 元数据」同款三级持久化)。
 */

import { create } from 'zustand'
import type { SeedanceCancelResult, SeedanceTaskUpdate } from '../../../../types/seedance'
import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchCardInput,
  VideoWorkbenchCardStatus,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
  VideoWorkbenchReconcileItem,
  VideoWorkbenchReconcileResult,
  VideoWorkbenchSubmitPayload,
  VideoWorkbenchSubmitResult,
  WorkbenchApplyOptions,
  WorkbenchApplyResult,
  WorkbenchIR,
} from '../../../../types/videoWorkbench'
import type { HistoryDataService } from '../history'
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import { modeLimit } from './modes'
import { getWorkbenchDb } from './WorkbenchDb'
import {
  type MaterialKind,
  buildCard,
  clampMaterials,
  createDefaultBoard,
  createId,
  isActiveStatus,
  normalizeDuration,
  normalizeMode,
  normalizeSeed,
  reorderBoard,
  toMaterial,
} from './cardSpec'
import { exportWorkbenchIR, planApplyIR } from './workbenchIR'
import {
  type HistoryCursor,
  type WorkbenchIntent,
  type WorkbenchRestoreResult,
  captureIntent,
  coalesceKeyFor,
  planRestore,
  pushHistory,
  refusedRestore,
  shouldCoalesce,
} from './workbenchHistory'

export {
  MAX_REFERENCE_AUDIOS,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_VIDEOS,
  buildCard,
  toMaterial,
} from './cardSpec'

/** 卡片持久化防抖窗口(打字高频更新不打爆 IndexedDB)。 */
const PERSIST_DEBOUNCE_MS = 500

interface WorkbenchElectronApi {
  videoWorkbench?: {
    submit: (payload: VideoWorkbenchSubmitPayload) => Promise<VideoWorkbenchSubmitResult>
    // 可选:preload 桥可能是旧版（热更新时序），调用点一律用 `?.` 并有降级分支
    cancel?: (taskId: string) => Promise<SeedanceCancelResult>
    reconcile?: (items: VideoWorkbenchReconcileItem[]) => Promise<VideoWorkbenchReconcileResult[]>
  }
  seedance?: {
    onTaskUpdate: (cb: (update: SeedanceTaskUpdate) => void) => () => void
  }
}

function getApi(): WorkbenchElectronApi | undefined {
  return (window as Window & { electronAPI?: WorkbenchElectronApi }).electronAPI
}

/** 快照里素材展示名的截断上限(防长文件名撑上下文)。 */
const SNAPSHOT_MATERIAL_NAME_MAX = 40

/** 快照素材条目:只带展示名,绝不携带 URL/base64 全文(Codex #5544/#6426 教训)。 */
export interface WorkbenchMaterialBrief {
  name: string
}

/**
 * Material → 紧凑清单条目:名字截 40 字符;asset:// 来源补简短 assetId 尾缀
 * (人像库可反查),名字里已含 id(toMaterial 占位名)则不重复加。
 */
function materialBrief(material: VideoWorkbenchMaterial): WorkbenchMaterialBrief {
  let name =
    material.name.length > SNAPSHOT_MATERIAL_NAME_MAX
      ? `${material.name.slice(0, SNAPSHOT_MATERIAL_NAME_MAX)}…`
      : material.name
  if (material.src.startsWith('asset://')) {
    const shortId = material.src.slice(8, 20)
    if (shortId && !name.includes(shortId)) name = `${name}@${shortId}`
  }
  return { name }
}

/** MCP status 工具返回的单卡快照(截断 prompt,别撑爆模型上下文)。 */
export interface WorkbenchCardSnapshot {
  cardId: string
  /** 所属「页」id(页名从 status 顶层 boards 表查,卡上不重复带,省 token)。 */
  boardId?: string
  order: number
  prompt: string
  model: string
  resolution: string
  ratio: string
  duration: number
  generateAudio: boolean
  mode: string
  seed?: number
  webSearch: boolean
  referenceCounts: { images: number; videos: number; audios: number }
  /** 紧凑素材清单(每类本就有 9/3/3 上限,只列名字)。 */
  references: {
    images: WorkbenchMaterialBrief[]
    videos: WorkbenchMaterialBrief[]
    audios: WorkbenchMaterialBrief[]
  }
  status: string
  taskId?: string
  error?: string
  localPath?: string
  remoteUrl?: string
}

export function snapshotCard(card: VideoWorkbenchCard): WorkbenchCardSnapshot {
  return {
    cardId: card.id,
    ...(card.boardId ? { boardId: card.boardId } : {}),
    order: card.order,
    prompt: card.prompt.length > 120 ? `${card.prompt.slice(0, 120)}…` : card.prompt,
    model: card.model,
    resolution: card.resolution,
    ratio: card.ratio,
    duration: card.duration,
    generateAudio: card.generateAudio,
    mode: card.mode,
    ...(card.seed !== undefined ? { seed: card.seed } : {}),
    webSearch: card.webSearch === true,
    referenceCounts: {
      images: card.referenceImages.length,
      videos: card.referenceVideos.length,
      audios: card.referenceAudios.length,
    },
    references: {
      images: card.referenceImages.map(materialBrief),
      videos: card.referenceVideos.map(materialBrief),
      audios: card.referenceAudios.map(materialBrief),
    },
    status: card.status,
    ...(card.taskId ? { taskId: card.taskId } : {}),
    ...(card.error ? { error: card.error } : {}),
    ...(card.localPath ? { localPath: card.localPath } : {}),
    ...(card.remoteUrl ? { remoteUrl: card.remoteUrl } : {}),
  }
}

/** 全局摘要里的单页概览。 */
export interface WorkbenchBoardBrief {
  id: string
  name: string
  cardCount: number
}

/** 全局状态计数(跨页聚合)。 */
export interface WorkbenchStatusCounts {
  draft: number
  preparing: number
  queued: number
  running: number
  succeeded: number
  failed: number
}

/**
 * 工作台全局摘要:写操作(add/update/start/remove)统一回带,等于每次
 * 写操作强制观测一次全局现状(Codex prompting 指南:工具输出是 agent
 * 最强的事实来源,大结果压缩成紧凑 schema)。体积 O(页数),极小。
 */
export interface WorkbenchSummary {
  activeBoardId: string
  boards: WorkbenchBoardBrief[]
  statusCounts: WorkbenchStatusCounts
}

export function snapshotWorkbench(
  state: Pick<VideoWorkbenchState, 'cards' | 'boards' | 'activeBoardId'>,
): WorkbenchSummary {
  const statusCounts: WorkbenchStatusCounts = {
    draft: 0,
    preparing: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
  }
  const cardCountByBoard = new Map<string, number>()
  for (const card of state.cards) {
    if (card.status in statusCounts) {
      statusCounts[card.status as keyof WorkbenchStatusCounts] += 1
    }
    if (card.boardId) {
      cardCountByBoard.set(card.boardId, (cardCountByBoard.get(card.boardId) ?? 0) + 1)
    }
  }
  return {
    activeBoardId: state.activeBoardId,
    boards: [...state.boards]
      .sort((a, b) => a.order - b.order)
      .map((b) => ({ id: b.id, name: b.name, cardCount: cardCountByBoard.get(b.id) ?? 0 })),
    statusCounts,
  }
}

export interface StartResult {
  started: string[]
  skipped: Array<{ cardId: string; reason: string }>
}

/** 单张卡片的取消结果（`billed` 直接来自上游分档，见 SeedanceCancelResult）。 */
export interface CancelResult {
  cardId: string
  /** 上游是否仍会为这次生成计费（running 阶段的取消只是本地放弃）。 */
  billed: boolean
  reason?: string
}

export interface VideoWorkbenchState {
  /** 全部页的卡片扁平存放(跨页任务回流仍能按 clientId/taskId 对齐);页面按 boardId 过滤展示。 */
  cards: VideoWorkbenchCard[]
  /** 「页」(工作区)列表,按 order 排。 */
  boards: VideoWorkbenchBoard[]
  activeBoardId: string
  hydrated: boolean
  /**
   * 编排意图的版本号,看板 IR 的乐观并发令牌(详见 types/videoWorkbench.ts)。
   *
   * **新增会改动 boards/cards 内容的 action 时,记得在返回里带上
   * `revision: state.revision + 1`** —— 漏了会让 agent 的 apply 拿着过期令牌
   * 却校验通过,静默盖掉用户的改动。
   *
   * 反过来,生成状态的回流(applyTaskUpdate / startCards 的状态写入 / 取消)
   * 刻意**不**递增:那些不是编排意图,而且一个跑着的任务会让每次 apply 都撞
   * 冲突,功能等于废掉。
   */
  revision: number

  /**
   * 撤销/重做栈,存的是「那一刻的编排意图」快照(见 workbenchHistory.ts)。
   *
   * 入栈完全由 revision 变化驱动 —— 不需要在 action 里逐个埋点,也因此天然
   * 只覆盖编排改动,跑着的任务不会因为一次撤销从卡片上消失。不持久化:
   * 重启后从零开始,和所有编辑器一样。
   */
  undoStack: WorkbenchIntent[]
  redoStack: WorkbenchIntent[]

  /** 首次进入页面 / 首个 MCP 调用时从 IndexedDB 恢复(幂等)。 */
  ensureHydrated: () => Promise<void>
  /** 新建页并切换过去(缺省自动命名「页面 N」)。返回新页 id。 */
  addBoard: (name?: string) => string
  switchBoard: (id: string) => void
  /** 重命名页(trim 后为空拒绝)。 */
  renameBoard: (id: string, name: string) => boolean
  /** 删除页(连带删卡)。仅剩一页时拒绝;删的是当前页则切到相邻页。 */
  removeBoard: (id: string) => boolean
  /** 批量追加卡片到当前页(UI 的「+」= addCards([{}]))。返回新卡 id 列表。 */
  addCards: (inputs: VideoWorkbenchCardInput[]) => string[]
  /** 更新卡片可编辑字段(生成中的卡片拒绝编辑)。 */
  updateCard: (id: string, patch: VideoWorkbenchCardInput) => boolean
  removeCard: (id: string) => void
  /** 拖拽排序:把卡片移到目标下标。 */
  moveCard: (id: string, toIndex: number) => void
  /** 追加参考素材(拖放/文件选择,自动截断到上限)。 */
  addMaterials: (id: string, kind: MaterialKind, materials: VideoWorkbenchMaterial[]) => void
  removeMaterial: (id: string, kind: MaterialKind, index: number) => void
  /** 素材拖拽换位:同类列表内把 fromIndex 挪到 toIndex(0 起,越界收敛)。 */
  moveMaterial: (id: string, kind: MaterialKind, fromIndex: number, toIndex: number) => void
  /** 「默认上传人像库」全局开关(localStorage 持久化,默认关)。 */
  autoImportPortrait: boolean
  setAutoImportPortrait: (enabled: boolean) => void
  /** 启动生成:缺省=全部可启动卡片;可指定 id 列表。并发提交。 */
  startCards: (ids?: string[]) => Promise<StartResult>
  /**
   * 取消/放弃进行中的卡片。返回每张卡的计费口径 —— 上游只允许取消 queued
   * (不计费),running 无法取消(照样扣费),UI 据此写文案。
   */
  cancelCards: (ids: string[]) => Promise<CancelResult[]>
  /**
   * 启动时对账:主进程任务表是纯内存的,重启后就空了,但上游任务还在跑。
   * 把进行中的卡片交回主进程重新接管并恢复轮询;上游查不到的落 failed。
   */
  reconcileInFlight: () => Promise<void>
  /** seedance:task-update 广播入口(仅消费 source==='workbench')。 */
  applyTaskUpdate: (update: SeedanceTaskUpdate) => void

  /** 导出整个工作台为声明式 IR(带 revision 令牌)。 */
  exportIR: () => WorkbenchIR
  /**
   * 声明式回写整个工作台。revision 对不上直接拒绝(除非 force),渲染中的卡片
   * 规格定格、在飞的卡片拒绝删除,逐项结果都在返回里。
   */
  applyIR: (ir: WorkbenchIR, opts?: WorkbenchApplyOptions) => Promise<WorkbenchApplyResult>

  /** 撤销上一步编排改动(含 agent 的整板 applyIR)。栈空则返回 ok:false。 */
  undo: () => Promise<WorkbenchRestoreResult>
  /** 重做被撤销的一步。任何新编辑都会清空重做栈。 */
  redo: () => Promise<WorkbenchRestoreResult>
}

/**
 * 按生成模式把卡片素材拆成提交载荷的媒体字段:
 * - text2video 不携带任何素材;
 * - first_frame / first_last_frame 把参考图第 1/2 张拆成 firstFrame/lastFrame
 *   (主进程 buildContent 据此打 first_frame/last_frame role);
 * - extend_video 只带视频;reference_images 只带图;其余模式全量。
 */
export function buildModeMedia(card: VideoWorkbenchCard): Pick<
  VideoWorkbenchSubmitPayload,
  'firstFrame' | 'lastFrame' | 'referenceImages' | 'referenceVideos' | 'referenceAudios'
> {
  const images = card.referenceImages.map((m) => m.src)
  const videos = card.referenceVideos.map((m) => m.src)
  const audios = card.referenceAudios.map((m) => m.src)
  switch (card.mode) {
    case 'text2video':
      return { referenceImages: [], referenceVideos: [], referenceAudios: [] }
    case 'first_frame':
      return {
        ...(images[0] ? { firstFrame: images[0] } : {}),
        referenceImages: [],
        referenceVideos: [],
        referenceAudios: [],
      }
    case 'first_last_frame':
      return {
        ...(images[0] ? { firstFrame: images[0] } : {}),
        ...(images[1] ? { lastFrame: images[1] } : {}),
        referenceImages: [],
        referenceVideos: [],
        referenceAudios: [],
      }
    case 'reference_images':
      return { referenceImages: images, referenceVideos: [], referenceAudios: [] }
    case 'extend_video':
      return { referenceImages: [], referenceVideos: videos, referenceAudios: [] }
    case 'multimodal_ref':
    case 'edit_video':
      return { referenceImages: images, referenceVideos: videos, referenceAudios: audios }
    default: {
      const exhaustive: never = card.mode
      void exhaustive
      return { referenceImages: images, referenceVideos: videos, referenceAudios: audios }
    }
  }
}

/** 卡片当前是否允许(重新)提交生成。 */
export function canStart(card: VideoWorkbenchCard): { ok: boolean; reason?: string } {
  if (!card.prompt.trim()) return { ok: false, reason: '提示词为空' }
  if (card.status === 'preparing' || card.status === 'queued' || card.status === 'running') {
    return { ok: false, reason: '任务进行中' }
  }
  // 上游硬约束(文档 2.2):音频不能单独作为唯一参考输入。
  const media = buildModeMedia(card)
  const hasAudio = (media.referenceAudios?.length ?? 0) > 0
  const hasVisual =
    !!media.firstFrame || (media.referenceImages?.length ?? 0) > 0 || (media.referenceVideos?.length ?? 0) > 0
  if (hasAudio && !hasVisual) {
    return { ok: false, reason: '音频不能单独作参考,请再加至少一张图片或一段视频' }
  }
  // mini/fast 不支持 1080p(文档 9.2 价格表仅 480p/720p 档)。
  if (card.resolution === '1080p' && card.model !== '2.0') {
    return { ok: false, reason: '1080p 仅 Seedance 2.0 满血支持' }
  }
  return { ok: true }
}

type SetState = (
  fn: (state: VideoWorkbenchState) => Partial<VideoWorkbenchState>,
) => void

/**
 * 把卡片写成 cancelled。**只在卡片仍在飞时写** —— 取消请求往返期间上游结果可能
 * 刚好到达（applyTaskUpdate 已落 succeeded），此时绝不能用 cancelled 覆盖掉一个
 * 已经拿到手的好结果。
 */
function writeCancelled(
  set: SetState,
  cardId: string,
  patch: Partial<VideoWorkbenchCard>,
): void {
  let after: VideoWorkbenchCard | null = null
  set((state) => ({
    cards: state.cards.map((c) => {
      if (c.id !== cardId || !isActiveStatus(c.status)) return c
      after = { ...c, status: 'cancelled', cancelRequested: undefined, ...patch, updatedAt: Date.now() }
      return after
    }),
  }))
  if (after) persistNow(after)
}

/** 同上语义的 failed 写入（仅对仍在飞的卡片生效）。 */
function writeFailed(set: SetState, cardId: string, error: string): void {
  let after: VideoWorkbenchCard | null = null
  set((state) => ({
    cards: state.cards.map((c) => {
      if (c.id !== cardId || !isActiveStatus(c.status)) return c
      after = { ...c, status: 'failed', error, updatedAt: Date.now() }
      return after
    }),
  }))
  if (after) persistNow(after)
}

function toReconcileItem(card: VideoWorkbenchCard): VideoWorkbenchReconcileItem {
  return {
    taskId: card.taskId!,
    ...(card.clientId ? { clientId: card.clientId } : {}),
    prompt: card.prompt,
    model: card.model,
    resolution: card.resolution,
    ratio: card.ratio,
    duration: card.duration,
    ...(card.startedAt ? { createdAt: card.startedAt } : {}),
  }
}

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

function schedulePersist(card: VideoWorkbenchCard): void {
  const prev = persistTimers.get(card.id)
  if (prev) clearTimeout(prev)
  persistTimers.set(
    card.id,
    setTimeout(() => {
      persistTimers.delete(card.id)
      void getWorkbenchDb().put(card).catch((e) => {
        console.warn('[VideoWorkbench] 卡片持久化失败(忽略):', e)
      })
    }, PERSIST_DEBOUNCE_MS),
  )
}

function persistNow(card: VideoWorkbenchCard): void {
  const prev = persistTimers.get(card.id)
  if (prev) {
    clearTimeout(prev)
    persistTimers.delete(card.id)
  }
  void getWorkbenchDb().put(card).catch((e) => {
    console.warn('[VideoWorkbench] 卡片持久化失败(忽略):', e)
  })
}

let hydrationPromise: Promise<void> | null = null

/** 「默认上传人像库」开关的 localStorage 键。 */
export const AUTO_IMPORT_PORTRAIT_KEY = 'vw-auto-import-portrait'

/** 当前激活「页」的 localStorage 键(轻量元数据,不进 IndexedDB)。 */
export const ACTIVE_BOARD_KEY = 'vw-active-board'

/** 自动命名「页面 N」:从 boards.length+1 起找未占用的编号。 */
function nextBoardName(boards: VideoWorkbenchBoard[]): string {
  const taken = new Set(boards.map((b) => b.name))
  let n = boards.length + 1
  while (taken.has(`页面 ${n}`)) n += 1
  return `页面 ${n}`
}

function writeActiveBoard(id: string): void {
  try {
    globalThis.localStorage?.setItem(ACTIVE_BOARD_KEY, id)
  } catch {
    // localStorage 不可用时仅内存生效
  }
}

function toFileUrl(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

/** 历史条目 model 字段:带上分辨率/时长,历史页徽章一眼可见规格。 */
function workbenchHistoryModel(card: VideoWorkbenchCard): string {
  const dur = card.duration === -1 ? '智能时长' : `${card.duration}s`
  return `seedance-${card.model} · ${card.resolution} · ${dur}`
}

/**
 * 生成成功(persistence=done)→ 写一条「历史记录」(type codex-video,与聊天
 * generate_video 的 SeedanceTaskListener 同口径)。优先 COS 永久 URL,本地
 * file:// 兜底。防重由卡片上的 historyRecorded 标记保证(applyTaskUpdate 里
 * 与状态更新同步落下并持久化),这里只管写。best-effort:失败不影响卡片。
 */
async function recordCardHistory(card: VideoWorkbenchCard): Promise<void> {
  const durableUrl = card.remoteUrl ?? (card.localPath ? toFileUrl(card.localPath) : undefined)
  if (!durableUrl) return
  try {
    const history = ServiceRegistry.get<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
    if (!history) return
    await history.init()
    await history.addToHistory('codex-video', card.prompt, [durableUrl], card.ratio, workbenchHistoryModel(card))
  } catch (error) {
    console.error('[VideoWorkbench] 写入历史记录失败(忽略):', error)
  }
}

function readAutoImportPortrait(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_IMPORT_PORTRAIT_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 一次整板写入的计划:内存里的新状态 + 只列真正变了的落盘增量。
 * 看板 IR 的 apply 与撤销/重做共用同一套提交路径。
 */
interface WorkbenchWritePlan {
  next: {
    boards: VideoWorkbenchBoard[]
    cards: VideoWorkbenchCard[]
    activeBoardId: string
    revision: number
  }
  persist: {
    cards: VideoWorkbenchCard[]
    removeCardIds: string[]
    boards: VideoWorkbenchBoard[]
    removeBoardIds: string[]
  }
}

type WorkbenchSetter = (partial: Partial<VideoWorkbenchState>) => void

/**
 * 计划的同步部分:掐掉待落盘的防抖写、换上新状态、记住当前页。
 *
 * 与落盘拆成两半是因为调用方要在「订阅者别把这次写当成新编辑」的闸内执行同步
 * 部分,而闸绝不能跨 await —— 否则数据库写的那几毫秒里用户的编辑会漏进撤销栈。
 */
function applyPlanToState(set: WorkbenchSetter, plan: WorkbenchWritePlan): void {
  // 一条 500ms 前排好的旧内容写入会在整板写之后落地,把刚写好的卡片打回旧值。
  for (const id of [...plan.persist.cards.map((c) => c.id), ...plan.persist.removeCardIds]) {
    const timer = persistTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      persistTimers.delete(id)
    }
  }
  set(plan.next)
  writeActiveBoard(plan.next.activeBoardId)
}

/**
 * 计划的落盘部分:逐张 put/remove,但只写真正变了的 —— 不复用 removeCard/moveCard
 * 那套「顺手重写整页」的路径,一次整板写改 50 张卡不该产生 50 倍写放大。
 */
async function flushPlanToDb(plan: WorkbenchWritePlan): Promise<void> {
  const db = getWorkbenchDb()
  await Promise.all([
    ...plan.persist.cards.map((card) =>
      db.put(card).catch((e) => {
        console.warn('[VideoWorkbench] 整板写卡片持久化失败(忽略):', e)
      }),
    ),
    ...plan.persist.removeCardIds.map((id) => db.remove(id).catch(() => {})),
    ...plan.persist.boards.map((board) => db.putBoard(board).catch(() => {})),
    ...plan.persist.removeBoardIds.map((id) => db.removeBoard(id).catch(() => {})),
  ])
}

/**
 * 撤销/重做自己也会 bump revision。这个闸让入栈订阅者别把「还原」当成一次新
 * 编辑记账,否则撤销一次就压进一条新历史,重做永远轮不到。
 */
let restoringHistory = false

/** 上一次入栈的合并标记(见 workbenchHistory.shouldCoalesce)。 */
let historyCursor: HistoryCursor | null = null

const initialBoard = createDefaultBoard()

export const useVideoWorkbenchStore = create<VideoWorkbenchState>()((set, get) => ({
  cards: [],
  boards: [initialBoard],
  activeBoardId: initialBoard.id,
  hydrated: false,
  revision: 0,
  undoStack: [],
  redoStack: [],
  autoImportPortrait: readAutoImportPortrait(),

  setAutoImportPortrait: (enabled) => {
    set({ autoImportPortrait: enabled })
    try {
      globalThis.localStorage?.setItem(AUTO_IMPORT_PORTRAIT_KEY, enabled ? '1' : '0')
    } catch {
      // localStorage 不可用(隐私模式等)时仅内存生效
    }
  },

  ensureHydrated: async () => {
    if (get().hydrated) return
    hydrationPromise ??= (async () => {
      try {
        const db = getWorkbenchDb()
        const [stored, storedBoards] = await Promise.all([db.list(), db.listBoards()])

        // 页列表:db 有则以 db 为准;没有(全新用户 / v1 老库)则把内存默认页
        // 落库 —— 老用户的单页草稿数据由下面的 boardId 迁移进这第一页。
        let boards = storedBoards
        if (boards.length === 0) {
          boards = get().boards
          for (const b of boards) void db.putBoard(b).catch(() => {})
        }
        const firstBoardId = boards[0].id
        const boardIds = new Set(boards.map((b) => b.id))

        // 重启后「进行中」状态已无人推进(任务在主进程内存里,重启即丢),
        // 统一落成 failed 并给出可读原因,可一键重试。
        // 旧库卡片没有 mode/webSearch/boardId 字段(渐进新增),读出时补默认值;
        // boardId 缺失/失效 → 迁入第一页(单页老数据自动迁移,不丢卡)。
        const normalized = stored.map((raw) => {
          const boardId = raw.boardId && boardIds.has(raw.boardId) ? raw.boardId : firstBoardId
          const card = { ...raw, boardId, mode: normalizeMode(raw.mode), webSearch: raw.webSearch === true }
          const next =
            card.status === 'preparing' || card.status === 'queued' || card.status === 'running'
              ? { ...card, status: 'failed' as const, error: card.error ?? '应用重启,任务状态丢失(可重试)' }
              : card
          if (next.boardId !== raw.boardId) void db.put(next).catch(() => {})
          return next
        })

        // 当前页:localStorage 记忆,失效则回第一页
        let activeBoardId = firstBoardId
        try {
          const saved = globalThis.localStorage?.getItem(ACTIVE_BOARD_KEY)
          if (saved && boardIds.has(saved)) activeBoardId = saved
        } catch {
          // localStorage 不可用则回第一页
        }

        set((state) => {
          // hydrate 与首个 addCards 竞态时,保留内存中已有的新卡(排在恢复卡之后);
          // 其 boardId 若指向被替换掉的临时默认页,归并到第一页。
          const extras = state.cards
            .filter((c) => !normalized.some((n) => n.id === c.id))
            .map((c) => (c.boardId && boardIds.has(c.boardId) ? c : { ...c, boardId: firstBoardId }))
          let cards = [...normalized, ...extras]
          for (const b of boards) cards = reorderBoard(cards, b.id)
          return { cards, boards, activeBoardId, hydrated: true }
        })
      } catch (e) {
        console.warn('[VideoWorkbench] 历史卡片恢复失败(忽略):', e)
        set({ hydrated: true })
      }
    })()
    await hydrationPromise
  },

  addBoard: (name) => {
    const boards = get().boards
    const trimmed = name?.trim()
    const board: VideoWorkbenchBoard = {
      id: createId(),
      name: trimmed || nextBoardName(boards),
      order: boards.length,
      createdAt: Date.now(),
    }
    set((state) => ({
      boards: [...state.boards, board],
      activeBoardId: board.id,
      revision: state.revision + 1,
    }))
    writeActiveBoard(board.id)
    void getWorkbenchDb().putBoard(board).catch((e) => {
      console.warn('[VideoWorkbench] 页持久化失败(忽略):', e)
    })
    return board.id
  },

  switchBoard: (id) => {
    if (!get().boards.some((b) => b.id === id)) return
    set({ activeBoardId: id })
    writeActiveBoard(id)
  },

  renameBoard: (id, name) => {
    const trimmed = name.trim()
    if (!trimmed) return false
    const exists = get().boards.some((b) => b.id === id)
    if (!exists) return false
    // 名字没变就是无操作:不 bump revision,也不重写库 —— 输入框失焦提交同名
    // 很常见,白让 agent 手里的 IR 令牌失效不值。
    let renamed: VideoWorkbenchBoard | null = null
    set((state) => {
      const boards = state.boards.map((b) => {
        if (b.id !== id || b.name === trimmed) return b
        renamed = { ...b, name: trimmed }
        return renamed
      })
      return renamed ? { boards, revision: state.revision + 1 } : {}
    })
    if (!renamed) return true
    void getWorkbenchDb().putBoard(renamed).catch(() => {})
    return true
  },

  removeBoard: (id) => {
    const state = get()
    if (state.boards.length <= 1 || !state.boards.some((b) => b.id === id)) return false
    const removedCards = state.cards.filter((c) => c.boardId === id)
    const boards = state.boards
      .filter((b) => b.id !== id)
      .map((b, i) => (b.order === i ? b : { ...b, order: i }))
    const activeBoardId = state.activeBoardId === id ? boards[0].id : state.activeBoardId
    set({
      boards,
      activeBoardId,
      cards: state.cards.filter((c) => c.boardId !== id),
      revision: state.revision + 1,
    })
    writeActiveBoard(activeBoardId)
    const db = getWorkbenchDb()
    void db.removeBoard(id).catch(() => {})
    for (const b of boards) void db.putBoard(b).catch(() => {})
    for (const card of removedCards) {
      const timer = persistTimers.get(card.id)
      if (timer) {
        clearTimeout(timer)
        persistTimers.delete(card.id)
      }
      void db.remove(card.id).catch(() => {})
    }
    return true
  },

  addCards: (inputs) => {
    const created: VideoWorkbenchCard[] = []
    set((state) => {
      const base = state.cards.filter((c) => c.boardId === state.activeBoardId).length
      inputs.forEach((input, i) => created.push(buildCard(input, base + i, state.activeBoardId)))
      return { cards: [...state.cards, ...created], revision: state.revision + 1 }
    })
    for (const card of created) persistNow(card)
    void getWorkbenchDb().evict()
    return created.map((c) => c.id)
  },

  updateCard: (id, patch) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => {
      const cards = state.cards.map((card) => {
        if (card.id !== id) return card
        // 进行中的任务参数已定格提交,不允许改(与音频页任务快照语义一致)
        if (card.status === 'preparing' || card.status === 'queued' || card.status === 'running') return card
        updated = {
          ...card,
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.resolution !== undefined ? { resolution: patch.resolution } : {}),
          ...(patch.ratio !== undefined ? { ratio: patch.ratio } : {}),
          ...(patch.duration !== undefined ? { duration: normalizeDuration(patch.duration) } : {}),
          ...(patch.generateAudio !== undefined ? { generateAudio: patch.generateAudio } : {}),
          ...(patch.mode !== undefined ? { mode: normalizeMode(patch.mode) } : {}),
          // seed: null=清除(恢复随机);undefined=不动
          ...(patch.seed === null
            ? { seed: undefined }
            : patch.seed !== undefined
              ? { seed: normalizeSeed(patch.seed) }
              : {}),
          ...(patch.webSearch !== undefined ? { webSearch: patch.webSearch === true } : {}),
          ...(patch.referenceImages !== undefined
            ? { referenceImages: clampMaterials(patch.referenceImages.map(toMaterial), 'referenceImages') }
            : {}),
          ...(patch.referenceVideos !== undefined
            ? { referenceVideos: clampMaterials(patch.referenceVideos.map(toMaterial), 'referenceVideos') }
            : {}),
          ...(patch.referenceAudios !== undefined
            ? { referenceAudios: clampMaterials(patch.referenceAudios.map(toMaterial), 'referenceAudios') }
            : {}),
          updatedAt: Date.now(),
        }
        // 模式切换后按新模式截断超限素材(soraui 是清空,这里保守只截断)
        if (patch.mode !== undefined) {
          updated = {
            ...updated,
            referenceImages: updated.referenceImages.slice(0, modeLimit(updated.mode, 'image')),
            referenceVideos: updated.referenceVideos.slice(0, modeLimit(updated.mode, 'video')),
            referenceAudios: updated.referenceAudios.slice(0, modeLimit(updated.mode, 'audio')),
          }
        }
        return updated
      })
      return updated ? { cards, revision: state.revision + 1 } : {}
    })
    if (updated) schedulePersist(updated)
    return updated !== null
  },

  removeCard: (id) => {
    let boardId: string | undefined
    let found = false
    set((state) => {
      const removed = state.cards.find((c) => c.id === id)
      if (!removed) return {}
      found = true
      boardId = removed.boardId
      return {
        cards: reorderBoard(state.cards.filter((c) => c.id !== id), removed.boardId),
        revision: state.revision + 1,
      }
    })
    if (!found) return
    const timer = persistTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      persistTimers.delete(id)
    }
    void getWorkbenchDb().remove(id).catch(() => {})
    // 兄弟卡 order 变了,补写 —— 只是这一页的兄弟,别把整个工作台重写一遍。
    for (const card of get().cards) {
      if (card.boardId === boardId) schedulePersist(card)
    }
  },

  moveCard: (id, toIndex) => {
    // toIndex 为卡片所属页内的目标下标;只重排该页,其他页原样。
    let boardId: string | undefined
    set((state) => {
      const moved = state.cards.find((c) => c.id === id)
      if (!moved) return {}
      const positions: number[] = []
      const boardCards: VideoWorkbenchCard[] = []
      state.cards.forEach((c, idx) => {
        if (c.boardId === moved.boardId) {
          positions.push(idx)
          boardCards.push(c)
        }
      })
      const from = boardCards.findIndex((c) => c.id === id)
      const clamped = Math.max(0, Math.min(boardCards.length - 1, toIndex))
      if (from === clamped) return {}
      boardId = moved.boardId
      const reordered = [...boardCards]
      const [item] = reordered.splice(from, 1)
      reordered.splice(clamped, 0, item)
      const next = [...state.cards]
      positions.forEach((pos, i) => {
        next[pos] = reordered[i]
      })
      return { cards: reorderBoard(next, moved.boardId), revision: state.revision + 1 }
    })
    // 只补写这一页 —— 别的页 order 没动。
    for (const card of get().cards) {
      if (card.boardId === boardId) schedulePersist(card)
    }
  },

  addMaterials: (id, kind, materials) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => {
      const cards = state.cards.map((card) => {
        if (card.id !== id) return card
        updated = {
          ...card,
          [kind]: clampMaterials([...card[kind], ...materials], kind),
          updatedAt: Date.now(),
        }
        return updated
      })
      return updated ? { cards, revision: state.revision + 1 } : {}
    })
    if (updated) schedulePersist(updated)
  },

  moveMaterial: (id, kind, fromIndex, toIndex) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => {
      const cards = state.cards.map((card) => {
        if (card.id !== id) return card
        const list = card[kind]
        if (fromIndex < 0 || fromIndex >= list.length) return card
        const clamped = Math.max(0, Math.min(list.length - 1, toIndex))
        if (fromIndex === clamped) return card
        const next = [...list]
        const [moved] = next.splice(fromIndex, 1)
        next.splice(clamped, 0, moved)
        updated = { ...card, [kind]: next, updatedAt: Date.now() }
        return updated
      })
      return updated ? { cards, revision: state.revision + 1 } : {}
    })
    if (updated) schedulePersist(updated)
  },

  removeMaterial: (id, kind, index) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => {
      const cards = state.cards.map((card) => {
        if (card.id !== id) return card
        if (index < 0 || index >= card[kind].length) return card
        updated = { ...card, [kind]: card[kind].filter((_, i) => i !== index), updatedAt: Date.now() }
        return updated
      })
      return updated ? { cards, revision: state.revision + 1 } : {}
    })
    if (updated) schedulePersist(updated)
  },

  startCards: async (ids) => {
    const api = getApi()?.videoWorkbench
    const result: StartResult = { started: [], skipped: [] }
    if (!api?.submit) {
      for (const id of ids ?? get().cards.map((c) => c.id)) {
        result.skipped.push({ cardId: id, reason: '视频服务未就绪(preload 桥缺失)' })
      }
      return result
    }

    // 缺省(不带 ids)只启动当前页的卡片 —— 页与页之间互相隔离
    const targets = get().cards.filter((c) =>
      ids ? ids.includes(c.id) : c.boardId === get().activeBoardId,
    )
    if (ids) {
      for (const id of ids) {
        if (!targets.some((c) => c.id === id)) result.skipped.push({ cardId: id, reason: '卡片不存在' })
      }
    }

    const submissions: Array<Promise<void>> = []
    for (const card of targets) {
      const gate = canStart(card)
      if (!gate.ok) {
        // 缺省全量启动时,draft 空卡静默跳过即可;显式指定 id 才值得报原因
        if (ids || gate.reason !== '提示词为空') {
          result.skipped.push({ cardId: card.id, reason: gate.reason! })
        }
        continue
      }

      const clientId = `wb-${card.id}-${Date.now()}`
      let submitted: VideoWorkbenchCard | null = null
      set((state) => ({
        cards: state.cards.map((c) => {
          if (c.id !== card.id) return c
          // 重启必须把上一轮的产物清干净:残留 localPath 会让播放器继续显示
          // 旧视频;残留 historyRecorded 会把第二轮及以后的结果永久挡在
          // 历史页之外(applyTaskUpdate 的写历史门是 !card.historyRecorded)。
          submitted = {
            ...c,
            status: 'preparing',
            clientId,
            taskId: undefined,
            videoUrl: undefined,
            error: undefined,
            persistence: undefined,
            localPath: undefined,
            remoteUrl: undefined,
            actualSeed: undefined,
            completionTokens: undefined,
            historyRecorded: undefined,
            cancelRequested: undefined,
            // 秒表起点。不能用 updatedAt —— 每条进度广播都会 bump 它，秒表会归零。
            startedAt: Date.now(),
            updatedAt: Date.now(),
          }
          return submitted
        }),
      }))
      if (submitted) persistNow(submitted)
      result.started.push(card.id)

      const payload: VideoWorkbenchSubmitPayload = {
        clientId,
        prompt: card.prompt.trim(),
        model: card.model,
        resolution: card.resolution,
        ratio: card.ratio,
        duration: card.duration,
        generateAudio: card.generateAudio,
        ...(card.seed !== undefined ? { seed: card.seed } : {}),
        ...(card.webSearch ? { webSearch: true } : {}),
        ...buildModeMedia(card),
      }

      submissions.push(
        api
          .submit(payload)
          .then((res) => {
            let after: VideoWorkbenchCard | null = null
            let lateCancelTaskId: string | undefined
            set((state) => ({
              cards: state.cards.map((c) => {
                if (c.id !== card.id || c.clientId !== clientId) return c
                if (!res.success) {
                  after = { ...c, status: 'failed', error: res.error, updatedAt: Date.now() }
                  return after
                }
                // preparing 期间用户点了取消:直到现在才拿到 taskId,而此刻任务
                // 几乎必然还在 queued —— 上游唯一允许真取消(不计费)的窗口,
                // 立刻补发。状态保持 cancelled,绝不因提交成功而推回 queued。
                if (c.cancelRequested) {
                  lateCancelTaskId = res.taskId
                  after = {
                    ...c,
                    taskId: res.taskId,
                    status: 'cancelled',
                    cancelRequested: undefined,
                    updatedAt: Date.now(),
                  }
                  return after
                }
                after =
                  // 广播可能先一步把状态推到 queued/running/succeeded,别倒回去
                  c.status === 'preparing'
                    ? { ...c, taskId: res.taskId, status: 'queued', updatedAt: Date.now() }
                    : { ...c, taskId: res.taskId, updatedAt: Date.now() }
                return after
              }),
            }))
            if (after) persistNow(after)
            if (lateCancelTaskId) void api.cancel?.(lateCancelTaskId)
          })
          .catch((e) => {
            let after: VideoWorkbenchCard | null = null
            set((state) => ({
              cards: state.cards.map((c) => {
                if (c.id !== card.id || c.clientId !== clientId) return c
                after = {
                  ...c,
                  status: 'failed',
                  error: e instanceof Error ? e.message : String(e),
                  updatedAt: Date.now(),
                }
                return after
              }),
            }))
            if (after) persistNow(after)
          }),
      )
    }

    await Promise.all(submissions)
    return result
  },

  cancelCards: async (ids) => {
    const api = getApi()?.videoWorkbench
    const results: CancelResult[] = []
    const targets = get().cards.filter((c) => ids.includes(c.id) && isActiveStatus(c.status))

    for (const card of targets) {
      // 还没 taskId(createTask 未返回):无从取消,先记意图。submit 一 resolve
      // 就补发 —— 见 startCards 的 cancelRequested 分支。
      if (!card.taskId) {
        writeCancelled(set, card.id, {
          cancelRequested: true,
          error: '已请求取消,等任务提交到上游后立即取消',
        })
        results.push({ cardId: card.id, billed: false, reason: '任务尚未提交到上游' })
        continue
      }

      let res: SeedanceCancelResult
      try {
        res = (await api?.cancel?.(card.taskId)) ?? {
          ok: false,
          billed: true,
          reason: '视频服务未就绪(preload 桥缺失)',
        }
      } catch (e) {
        res = { ok: false, billed: true, reason: e instanceof Error ? e.message : String(e) }
      }

      // 主进程说「已完成/不在跟踪表」时也照样在本地停下:要么结果广播已经把卡片
      // 推到终态(writeCancelled 会让路,不覆盖好结果),要么主进程重启过、这张卡
      // 再等下去也没人喂它。
      writeCancelled(set, card.id, { ...(res.reason ? { error: res.reason } : {}) })
      results.push({ cardId: card.id, billed: res.billed, ...(res.reason ? { reason: res.reason } : {}) })
    }
    return results
  },

  reconcileInFlight: async () => {
    const api = getApi()?.videoWorkbench
    const active = get().cards.filter((c) => isActiveStatus(c.status))
    if (active.length === 0) return

    // 没 taskId = 重启前 createTask 就没成功,上游根本没有这个任务,无从对账。
    for (const orphan of active.filter((c) => !c.taskId)) {
      writeFailed(set, orphan.id, '应用重启前任务未提交成功,请重新生成')
    }

    const items = active.filter((c) => c.taskId)
    if (items.length === 0 || !api?.reconcile) return

    let results: VideoWorkbenchReconcileResult[] = []
    try {
      results = (await api.reconcile(items.map(toReconcileItem))) ?? []
    } catch (e) {
      // 对账本身失败(IPC 抖动)不动卡片:下次启动还有机会,别把还在跑的任务错杀。
      console.warn('[workbench] reconcile failed:', e)
      return
    }

    const unknown = new Map(
      results.filter((r) => r.outcome === 'unknown').map((r) => [r.taskId, r.reason]),
    )
    for (const card of items) {
      const reason = unknown.has(card.taskId!) ? unknown.get(card.taskId!) : undefined
      if (!unknown.has(card.taskId!)) continue
      writeFailed(set, card.id, `重启后无法查询该任务${reason ? `:${reason}` : '(可能已过期)'}`)
    }
  },

  applyTaskUpdate: (update) => {
    if (update.source !== 'workbench') return
    let after: VideoWorkbenchCard | null = null
    let shouldRecordHistory = false
    set((state) => ({
      cards: state.cards.map((card) => {
        const match =
          (update.clientId && card.clientId === update.clientId) ||
          (card.taskId && card.taskId === update.taskId)
        if (!match) return card
        let next: VideoWorkbenchCard = {
          ...card,
          status: update.status,
          taskId: update.taskId,
          ...(update.videoUrl ? { videoUrl: update.videoUrl } : {}),
          ...(update.localPath ? { localPath: update.localPath } : {}),
          ...(update.remoteUrl ? { remoteUrl: update.remoteUrl } : {}),
          ...(typeof update.actualSeed === 'number' ? { actualSeed: update.actualSeed } : {}),
          ...(typeof update.completionTokens === 'number' ? { completionTokens: update.completionTokens } : {}),
          persistence: update.persistence,
          ...(update.error ? { error: update.error } : {}),
          updatedAt: Date.now(),
        }
        // 生成成功且落盘完成 → 写一条历史记录。防重标记与状态更新同一次
        // set 落下(并随 persistNow 持久化),重复 done 广播 / 重载后再广播都不重写。
        if (
          next.status === 'succeeded' &&
          next.persistence === 'done' &&
          !card.historyRecorded &&
          (next.remoteUrl || next.localPath)
        ) {
          next = { ...next, historyRecorded: true }
          shouldRecordHistory = true
        }
        after = next
        return next
      }),
    }))
    if (after) persistNow(after)
    if (after && shouldRecordHistory) void recordCardHistory(after)
  },

  exportIR: () => exportWorkbenchIR(get()),

  applyIR: async (ir, opts) => {
    const plan = planApplyIR(get(), ir, opts)
    if (!plan.next || !plan.persist) return plan.result
    const write = { next: plan.next, persist: plan.persist }
    applyPlanToState(set, write)
    await flushPlanToDb(write)
    return plan.result
  },

  undo: () => restoreStep(set, get(), 'undo'),
  redo: () => restoreStep(set, get(), 'redo'),
}))

/**
 * 撤销与重做是同一段逻辑的镜像:从一个栈弹出目标快照,把「当前」压进另一个栈。
 *
 * 计划被拒(例如还原后会超过卡片上限)时**保留栈顶**,用户腾出空间还能再试 ——
 * 弹掉会让那一步永久消失。
 */
function restoreStep(
  set: WorkbenchSetter,
  state: VideoWorkbenchState,
  direction: 'undo' | 'redo',
): Promise<WorkbenchRestoreResult> {
  const from = direction === 'undo' ? state.undoStack : state.redoStack
  const target = from.at(-1)
  if (!target) {
    return Promise.resolve(
      refusedRestore(state.revision, direction === 'undo' ? '没有可撤销的步骤' : '没有可重做的步骤'),
    )
  }

  const plan = planRestore(state, target)
  if (!plan.result.ok) return Promise.resolve(plan.result)

  // 断开合并游标:还原之后接着打字,不该并进被撤销掉的那一次编辑里。
  historyCursor = null

  const rest = from.slice(0, -1)
  const other = pushHistory(
    direction === 'undo' ? state.redoStack : state.undoStack,
    captureIntent(state),
  )
  const stacks: Partial<VideoWorkbenchState> =
    direction === 'undo' ? { undoStack: rest, redoStack: other } : { redoStack: rest, undoStack: other }

  // no-op 在实践中够不到(每个 action 只在真的改了东西时才 bump revision),但真
  // 撞上了也得把这一步弹掉,否则按撤销像是卡住了。
  if (!plan.next || !plan.persist) {
    set(stacks)
    return Promise.resolve(plan.result)
  }

  const write = { next: plan.next, persist: plan.persist }
  restoringHistory = true
  try {
    applyPlanToState(set, write)
    set(stacks)
  } finally {
    restoringHistory = false
  }
  return flushPlanToDb(write).then(() => plan.result)
}

/**
 * 入栈钩子:revision 变了就说明编排意图变了,把变更**之前**的那份意图压进撤销栈。
 *
 * 挂在订阅上而不是逐个 action 里埋点 —— revision 的递增条件已经精确等于「这是一次
 * 编排改动」(生成状态回流刻意不递增),而埋点在十几个 action 里必然会漏,新加的
 * action 更会忘。代价是这里的 setState 是重入的:它不动 revision,所以下一轮
 * 订阅回调会在第二行直接返回,不会递归。
 *
 * 但「一次编排改动」不等于「一步撤销」:提示词框逐字符调 updateCard,revision 必须
 * 跟着涨(它是 IR 的并发令牌,粗了就会让 agent 拿过期 IR 盖掉击键),而撤销的步
 * 边界得比它粗。所以步边界单独由合并键决定 —— 这也是 tldraw 的分工:store 记录
 * 一切,history 自己判断哪些相邻变更算同一步。
 */
useVideoWorkbenchStore.subscribe((state, prev) => {
  if (restoringHistory || state.revision === prev.revision) return

  const key = coalesceKeyFor(prev, state)
  const now = Date.now()
  const coalesce = shouldCoalesce(historyCursor, key, now)
  // 续上一步:刷新 at,让连续打字一直并进同一步,停手才断。
  historyCursor = { key, at: now }
  // 并入栈顶那份快照即可 —— 快照记的是「这次逻辑编辑之前」的状态,编辑还在进行中,
  // 已有的快照就已经是对的。(tldraw 靠 squash 累加 diff;快照是绝对值,压制就够了。)
  if (coalesce) return

  useVideoWorkbenchStore.setState({
    undoStack: pushHistory(prev.undoStack, captureIntent(prev)),
    // 有了新编辑,原来那条重做分支已经不可能接回去了。
    redoStack: [],
  })
})

/**
 * 订阅 seedance:task-update 广播(source==='workbench' 的进度/结果回流)。
 *
 * 引用计数是必需的,不是防御性设计:AppLayout 挂一份常驻,工作台页再挂一份。
 * 页面被 `<Activity mode="hidden">` 隐藏时 React 会销毁 effect,其 cleanup 只把
 * 计数减 1,底层订阅由 AppLayout 那份撑住。若订阅生命周期跟着页面走,切走标签页
 * 期间完成的任务广播就无人接收(全局 SeedanceTaskListener 对 source==='workbench'
 * 直接 return,没有兜底),卡片会永久停在「渲染中」且不写历史。
 *
 * 计数归零才真正退订。返回的句柄幂等,重复调用只减一次。
 */
let taskUnsubscribe: (() => void) | null = null
let taskMountCount = 0

export function mountWorkbenchTaskListener(): () => void {
  const api = getApi()?.seedance
  if (!api?.onTaskUpdate) return () => {}

  if (!taskUnsubscribe) {
    taskUnsubscribe = api.onTaskUpdate((update) => {
      useVideoWorkbenchStore.getState().applyTaskUpdate(update)
    })
  }
  taskMountCount += 1

  let released = false
  return () => {
    if (released) return
    released = true
    taskMountCount = Math.max(0, taskMountCount - 1)
    if (taskMountCount === 0 && taskUnsubscribe) {
      taskUnsubscribe()
      taskUnsubscribe = null
    }
  }
}

/** 测试用:重置模块级订阅/水合状态。 */
export function resetWorkbenchStoreForTest(): void {
  hydrationPromise = null
  taskUnsubscribe = null
  taskMountCount = 0
  restoringHistory = false
  historyCursor = null
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  const board = createDefaultBoard()
  // 归零 revision 本身就是一次 revision 变化 —— 不关闸的话入栈订阅者会在这次
  // setState 之后把上一个用例的状态压回撤销栈,清栈等于没清。
  restoringHistory = true
  try {
    useVideoWorkbenchStore.setState({
      cards: [],
      boards: [board],
      activeBoardId: board.id,
      hydrated: false,
      revision: 0,
      undoStack: [],
      redoStack: [],
      autoImportPortrait: false,
    })
  } finally {
    restoringHistory = false
  }
}
