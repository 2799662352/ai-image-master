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
  VideoWorkbenchCard,
  VideoWorkbenchCardInput,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
  VideoWorkbenchSubmitPayload,
  VideoWorkbenchSubmitResult,
} from '../../../../types/videoWorkbench'
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

/** CardInput → 新卡片(缺省用 Seedance 默认规格)。 */
export function buildCard(input: VideoWorkbenchCardInput, order: number): VideoWorkbenchCard {
  const now = Date.now()
  return {
    id: createId(),
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
  cards: VideoWorkbenchCard[]
  hydrated: boolean

  /** 首次进入页面 / 首个 MCP 调用时从 IndexedDB 恢复(幂等)。 */
  ensureHydrated: () => Promise<void>
  /** 批量追加卡片(UI 的「+」= addCards([{}]))。返回新卡 id 列表。 */
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

function reorder(cards: VideoWorkbenchCard[]): VideoWorkbenchCard[] {
  return cards.map((c, i) => (c.order === i ? c : { ...c, order: i }))
}

let hydrationPromise: Promise<void> | null = null

/** 「默认上传人像库」开关的 localStorage 键。 */
export const AUTO_IMPORT_PORTRAIT_KEY = 'vw-auto-import-portrait'

function readAutoImportPortrait(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_IMPORT_PORTRAIT_KEY) === '1'
  } catch {
    return false
  }
}

export const useVideoWorkbenchStore = create<VideoWorkbenchState>()((set, get) => ({
  cards: [],
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
        const stored = await getWorkbenchDb().list()
        // 重启后「进行中」状态已无人推进(任务在主进程内存里,重启即丢),
        // 统一落成 failed 并给出可读原因,可一键重试。
        // 旧库卡片没有 mode/webSearch 字段(本轮新增),读出时补默认值。
        const normalized = stored.map((raw) => {
          const card = { ...raw, mode: normalizeMode(raw.mode), webSearch: raw.webSearch === true }
          return card.status === 'preparing' || card.status === 'queued' || card.status === 'running'
            ? { ...card, status: 'failed' as const, error: card.error ?? '应用重启,任务状态丢失(可重试)' }
            : card
        })
        set((state) => ({
          // hydrate 与首个 addCards 竞态时,保留内存中已有的新卡(排在恢复卡之后)
          cards: reorder([...normalized, ...state.cards.filter((c) => !normalized.some((n) => n.id === c.id))]),
          hydrated: true,
        }))
      } catch (e) {
        console.warn('[VideoWorkbench] 历史卡片恢复失败(忽略):', e)
        set({ hydrated: true })
      }
    })()
    await hydrationPromise
  },

  addCards: (inputs) => {
    const created: VideoWorkbenchCard[] = []
    set((state) => {
      const base = state.cards.length
      inputs.forEach((input, i) => created.push(buildCard(input, base + i)))
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
    set((state) => ({ cards: reorder(state.cards.filter((c) => c.id !== id)) }))
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
    set((state) => {
      const from = state.cards.findIndex((c) => c.id === id)
      if (from < 0) return state
      const clamped = Math.max(0, Math.min(state.cards.length - 1, toIndex))
      if (from === clamped) return state
      const next = [...state.cards]
      const [moved] = next.splice(from, 1)
      next.splice(clamped, 0, moved)
      return { cards: reorder(next) }
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

    const targets = get().cards.filter((c) => (ids ? ids.includes(c.id) : true))
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
    set((state) => ({
      cards: state.cards.map((card) => {
        const match =
          (update.clientId && card.clientId === update.clientId) ||
          (card.taskId && card.taskId === update.taskId)
        if (!match) return card
        after = {
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
        return after
      }),
    }))
    if (after) persistNow(after)
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
  useVideoWorkbenchStore.setState({ cards: [], hydrated: false, autoImportPortrait: false })
}
