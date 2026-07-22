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
import type { SeedanceTaskUpdate } from '../../../../types/seedance'
import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchCardInput,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
  VideoWorkbenchSubmitPayload,
  VideoWorkbenchSubmitResult,
} from '../../../../types/videoWorkbench'
import type { HistoryDataService } from '../history'
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import { WORKBENCH_MODES, modeLimit } from './modes'
import { getWorkbenchDb } from './WorkbenchDb'

export const MAX_REFERENCE_IMAGES = 9
export const MAX_REFERENCE_VIDEOS = 3
export const MAX_REFERENCE_AUDIOS = 3

/** 卡片持久化防抖窗口(打字高频更新不打爆 IndexedDB)。 */
const PERSIST_DEBOUNCE_MS = 500

type MaterialKind = 'referenceImages' | 'referenceVideos' | 'referenceAudios'

const MATERIAL_LIMITS: Record<MaterialKind, number> = {
  referenceImages: MAX_REFERENCE_IMAGES,
  referenceVideos: MAX_REFERENCE_VIDEOS,
  referenceAudios: MAX_REFERENCE_AUDIOS,
}

interface WorkbenchElectronApi {
  videoWorkbench?: {
    submit: (payload: VideoWorkbenchSubmitPayload) => Promise<VideoWorkbenchSubmitResult>
  }
  seedance?: {
    onTaskUpdate: (cb: (update: SeedanceTaskUpdate) => void) => () => void
  }
}

function getApi(): WorkbenchElectronApi | undefined {
  return (window as Window & { electronAPI?: WorkbenchElectronApi }).electronAPI
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `wb-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 字符串源 → Material(展示名从路径/URL 猜)。 */
export function toMaterial(src: string | VideoWorkbenchMaterial): VideoWorkbenchMaterial {
  if (typeof src !== 'string') return src
  if (src.startsWith('data:')) return { name: '(内嵌素材)', src }
  if (src.startsWith('asset://')) return { name: `素材库 ${src.slice(8, 20)}…`, src }
  const clean = src.split(/[?#]/)[0]
  const base = clean.split(/[\\/]/).pop() || src.slice(0, 32)
  return { name: base, src }
}

/** 归一化 mode 输入(未知值回退全能参考)。 */
function normalizeMode(mode: unknown): VideoWorkbenchMode {
  return (WORKBENCH_MODES.find((m) => m.value === mode)?.value ?? 'multimodal_ref') as VideoWorkbenchMode
}

/** seed 归一化:非法/负数 → undefined(随机)。 */
function normalizeSeed(seed: unknown): number | undefined {
  const n = Number(seed)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.min(4294967295, Math.round(n))
}

/** 时长归一化:-1 = 智能时长(模型自动决定,文档 8.1);其余收敛 4–15;非法回退 5。 */
function normalizeDuration(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 5
  if (n === -1) return -1
  return Math.min(15, Math.max(4, Math.round(n)))
}

function clampMaterials(list: VideoWorkbenchMaterial[], kind: MaterialKind): VideoWorkbenchMaterial[] {
  return list.slice(0, MATERIAL_LIMITS[kind])
}

/** CardInput → 新卡片(缺省用 Seedance 默认规格;boardId 缺省由 addCards 填当前页)。 */
export function buildCard(input: VideoWorkbenchCardInput, order: number, boardId?: string): VideoWorkbenchCard {
  const now = Date.now()
  return {
    id: createId(),
    ...(boardId ? { boardId } : {}),
    order,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    prompt: input.prompt ?? '',
    model: input.model ?? '2.0',
    resolution: input.resolution ?? '720p',
    ratio: input.ratio ?? '16:9',
    duration: normalizeDuration(input.duration ?? 5),
    generateAudio: input.generateAudio !== false,
    mode: normalizeMode(input.mode),
    ...(normalizeSeed(input.seed) !== undefined ? { seed: normalizeSeed(input.seed) } : {}),
    webSearch: input.webSearch === true,
    referenceImages: clampMaterials((input.referenceImages ?? []).map(toMaterial), 'referenceImages'),
    referenceVideos: clampMaterials((input.referenceVideos ?? []).map(toMaterial), 'referenceVideos'),
    referenceAudios: clampMaterials((input.referenceAudios ?? []).map(toMaterial), 'referenceAudios'),
  }
}

/** MCP status 工具返回的单卡快照(截断 prompt,别撑爆模型上下文)。 */
export interface WorkbenchCardSnapshot {
  cardId: string
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
  status: string
  taskId?: string
  error?: string
  localPath?: string
  remoteUrl?: string
}

export function snapshotCard(card: VideoWorkbenchCard): WorkbenchCardSnapshot {
  return {
    cardId: card.id,
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
    status: card.status,
    ...(card.taskId ? { taskId: card.taskId } : {}),
    ...(card.error ? { error: card.error } : {}),
    ...(card.localPath ? { localPath: card.localPath } : {}),
    ...(card.remoteUrl ? { remoteUrl: card.remoteUrl } : {}),
  }
}

export interface StartResult {
  started: string[]
  skipped: Array<{ cardId: string; reason: string }>
}

export interface VideoWorkbenchState {
  /** 全部页的卡片扁平存放(跨页任务回流仍能按 clientId/taskId 对齐);页面按 boardId 过滤展示。 */
  cards: VideoWorkbenchCard[]
  /** 「页」(工作区)列表,按 order 排。 */
  boards: VideoWorkbenchBoard[]
  activeBoardId: string
  hydrated: boolean

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
  /** seedance:task-update 广播入口(仅消费 source==='workbench')。 */
  applyTaskUpdate: (update: SeedanceTaskUpdate) => void
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

/** 页内 order 压实(只动指定页的卡,其他页原样)。 */
function reorderBoard(cards: VideoWorkbenchCard[], boardId: string | undefined): VideoWorkbenchCard[] {
  let i = 0
  return cards.map((c) => {
    if (c.boardId !== boardId) return c
    const next = c.order === i ? c : { ...c, order: i }
    i += 1
    return next
  })
}

let hydrationPromise: Promise<void> | null = null

/** 「默认上传人像库」开关的 localStorage 键。 */
export const AUTO_IMPORT_PORTRAIT_KEY = 'vw-auto-import-portrait'

/** 当前激活「页」的 localStorage 键(轻量元数据,不进 IndexedDB)。 */
export const ACTIVE_BOARD_KEY = 'vw-active-board'

function createDefaultBoard(order = 0, name?: string): VideoWorkbenchBoard {
  return { id: createId(), name: name ?? `页面 ${order + 1}`, order, createdAt: Date.now() }
}

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

const initialBoard = createDefaultBoard()

export const useVideoWorkbenchStore = create<VideoWorkbenchState>()((set, get) => ({
  cards: [],
  boards: [initialBoard],
  activeBoardId: initialBoard.id,
  hydrated: false,
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
    set((state) => ({ boards: [...state.boards, board], activeBoardId: board.id }))
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
    let renamed: VideoWorkbenchBoard | null = null
    set((state) => ({
      boards: state.boards.map((b) => {
        if (b.id !== id) return b
        renamed = { ...b, name: trimmed }
        return renamed
      }),
    }))
    if (!renamed) return false
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
      return { cards: [...state.cards, ...created] }
    })
    for (const card of created) persistNow(card)
    void getWorkbenchDb().evict()
    return created.map((c) => c.id)
  },

  updateCard: (id, patch) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => ({
      cards: state.cards.map((card) => {
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
      }),
    }))
    if (updated) schedulePersist(updated)
    return updated !== null
  },

  removeCard: (id) => {
    set((state) => {
      const removed = state.cards.find((c) => c.id === id)
      if (!removed) return state
      return { cards: reorderBoard(state.cards.filter((c) => c.id !== id), removed.boardId) }
    })
    const timer = persistTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      persistTimers.delete(id)
    }
    void getWorkbenchDb().remove(id).catch(() => {})
    // 兄弟卡 order 变了,补写
    for (const card of get().cards) schedulePersist(card)
  },

  moveCard: (id, toIndex) => {
    // toIndex 为卡片所属页内的目标下标;只重排该页,其他页原样。
    set((state) => {
      const moved = state.cards.find((c) => c.id === id)
      if (!moved) return state
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
      if (from === clamped) return state
      const reordered = [...boardCards]
      const [item] = reordered.splice(from, 1)
      reordered.splice(clamped, 0, item)
      const next = [...state.cards]
      positions.forEach((pos, i) => {
        next[pos] = reordered[i]
      })
      return { cards: reorderBoard(next, moved.boardId) }
    })
    for (const card of get().cards) schedulePersist(card)
  },

  addMaterials: (id, kind, materials) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => ({
      cards: state.cards.map((card) => {
        if (card.id !== id) return card
        updated = {
          ...card,
          [kind]: clampMaterials([...card[kind], ...materials], kind),
          updatedAt: Date.now(),
        }
        return updated
      }),
    }))
    if (updated) schedulePersist(updated)
  },

  moveMaterial: (id, kind, fromIndex, toIndex) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => ({
      cards: state.cards.map((card) => {
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
      }),
    }))
    if (updated) schedulePersist(updated)
  },

  removeMaterial: (id, kind, index) => {
    let updated: VideoWorkbenchCard | null = null
    set((state) => ({
      cards: state.cards.map((card) => {
        if (card.id !== id) return card
        updated = { ...card, [kind]: card[kind].filter((_, i) => i !== index), updatedAt: Date.now() }
        return updated
      }),
    }))
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
          submitted = {
            ...c,
            status: 'preparing',
            clientId,
            taskId: undefined,
            videoUrl: undefined,
            error: undefined,
            persistence: undefined,
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
            set((state) => ({
              cards: state.cards.map((c) => {
                if (c.id !== card.id || c.clientId !== clientId) return c
                after = res.success
                  ? // 广播可能先一步把状态推到 queued/running/succeeded,别倒回去
                    c.status === 'preparing'
                    ? { ...c, taskId: res.taskId, status: 'queued', updatedAt: Date.now() }
                    : { ...c, taskId: res.taskId, updatedAt: Date.now() }
                  : { ...c, status: 'failed', error: res.error, updatedAt: Date.now() }
                return after
              }),
            }))
            if (after) persistNow(after)
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
}))

/**
 * 订阅 seedance:task-update 广播(source==='workbench' 的进度/结果回流)。
 * 由页面 mount 时调用;返回退订函数。模块级守卫防重复订阅。
 */
let taskSubscription: (() => void) | null = null

export function mountWorkbenchTaskListener(): () => void {
  if (taskSubscription) return taskSubscription
  const api = getApi()?.seedance
  if (!api?.onTaskUpdate) return () => {}
  const unsub = api.onTaskUpdate((update) => {
    useVideoWorkbenchStore.getState().applyTaskUpdate(update)
  })
  taskSubscription = () => {
    unsub()
    taskSubscription = null
  }
  return taskSubscription
}

/** 测试用:重置模块级订阅/水合状态。 */
export function resetWorkbenchStoreForTest(): void {
  hydrationPromise = null
  taskSubscription = null
  for (const t of persistTimers.values()) clearTimeout(t)
  persistTimers.clear()
  const board = createDefaultBoard()
  useVideoWorkbenchStore.setState({
    cards: [],
    boards: [board],
    activeBoardId: board.id,
    hydrated: false,
    autoImportPortrait: false,
  })
}
