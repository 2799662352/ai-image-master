// src/renderer/src/features/video-workbench/cardSpec.ts
/**
 * 工作台卡片的纯规格逻辑:输入归一化、素材封装、页内 order 压实。
 *
 * 从 store.ts 抽出来是为了打断循环依赖 —— 看板 IR(workbenchIR.ts)要复用
 * 这些归一化规则才能保证「IR 写进去的值」与「UI 填进去的值」经过同一道闸,
 * 而 store.ts 又要引 IR 的 plan 函数。两边都只依赖这里,谁也不依赖谁。
 *
 * 这里的函数全部无副作用、不碰 store、不碰 IndexedDB。
 */

import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchCardInput,
  VideoWorkbenchCardStatus,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
  VideoWorkbenchSpec,
} from '../../../../types/videoWorkbench'
import { WORKBENCH_MODES } from './modes'

export const MAX_REFERENCE_IMAGES = 9
export const MAX_REFERENCE_VIDEOS = 3
export const MAX_REFERENCE_AUDIOS = 3

export type MaterialKind = 'referenceImages' | 'referenceVideos' | 'referenceAudios'

export const MATERIAL_LIMITS: Record<MaterialKind, number> = {
  referenceImages: MAX_REFERENCE_IMAGES,
  referenceVideos: MAX_REFERENCE_VIDEOS,
  referenceAudios: MAX_REFERENCE_AUDIOS,
}

export const MATERIAL_KINDS = [
  'referenceImages',
  'referenceVideos',
  'referenceAudios',
] as const satisfies readonly MaterialKind[]

export function createId(): string {
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
export function normalizeMode(mode: unknown): VideoWorkbenchMode {
  return (WORKBENCH_MODES.find((m) => m.value === mode)?.value ?? 'multimodal_ref') as VideoWorkbenchMode
}

/**
 * seed 归一化:非法/负数 → undefined(随机)。
 *
 * null 必须走 undefined 分支 —— `Number(null)` 是 0,不显式挡掉的话「清除种子」
 * 会变成「种子锁定为 0」,而 0 是合法种子,结果是每次生成都复现同一帧。
 */
export function normalizeSeed(seed: unknown): number | undefined {
  if (seed === null || seed === undefined) return undefined
  const n = Number(seed)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.min(4294967295, Math.round(n))
}

/** 时长归一化:-1 = 智能时长(模型自动决定,文档 8.1);其余收敛 4–15;非法回退 5。 */
export function normalizeDuration(value: unknown): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 5
  if (n === -1) return -1
  return Math.min(15, Math.max(4, Math.round(n)))
}

export function clampMaterials(
  list: VideoWorkbenchMaterial[],
  kind: MaterialKind,
): VideoWorkbenchMaterial[] {
  return list.slice(0, MATERIAL_LIMITS[kind])
}

/**
 * CardInput → 完整规格,缺省补 Seedance 默认值。
 *
 * 「声明式」的关键:返回的一定是**完整**规格,缺省字段用默认值而不是留空。
 * 所以看板 IR 可以拿它的返回值整块替换旧规格 —— IR 里没写 seed 就等于「用
 * 随机种子」,而不是「沿用上次那个种子」。
 */
export function normalizeSpec(input: VideoWorkbenchCardInput): VideoWorkbenchSpec {
  const seed = normalizeSeed(input.seed)
  return {
    prompt: input.prompt ?? '',
    model: input.model ?? '2.0',
    resolution: input.resolution ?? '720p',
    ratio: input.ratio ?? '16:9',
    duration: normalizeDuration(input.duration ?? 5),
    generateAudio: input.generateAudio !== false,
    mode: normalizeMode(input.mode),
    ...(seed !== undefined ? { seed } : {}),
    webSearch: input.webSearch !== false,
    referenceImages: clampMaterials((input.referenceImages ?? []).map(toMaterial), 'referenceImages'),
    referenceVideos: clampMaterials((input.referenceVideos ?? []).map(toMaterial), 'referenceVideos'),
    referenceAudios: clampMaterials((input.referenceAudios ?? []).map(toMaterial), 'referenceAudios'),
  }
}

/** CardInput → 新卡片(缺省用 Seedance 默认规格;boardId 缺省由 addCards 填当前页)。 */
export function buildCard(
  input: VideoWorkbenchCardInput,
  order: number,
  boardId?: string,
): VideoWorkbenchCard {
  const now = Date.now()
  return {
    id: createId(),
    ...(boardId ? { boardId } : {}),
    order,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    rev: 0,
    ...normalizeSpec(input),
  }
}

/**
 * 从已归一化的卡片里取出规格部分（丢掉运行时字段）。
 *
 * `seed` 只在有值时出现 —— 展开到旧卡片上时才能真正「清掉种子」,
 * 写成 `seed: undefined` 会在对象上留一个 undefined 键,落到 IndexedDB 后
 * 与「从未设过种子」不可区分。
 */
export function pickSpec(spec: VideoWorkbenchSpec): VideoWorkbenchSpec {
  return {
    prompt: spec.prompt,
    model: spec.model,
    resolution: spec.resolution,
    ratio: spec.ratio,
    duration: spec.duration,
    generateAudio: spec.generateAudio,
    mode: spec.mode,
    ...(spec.seed !== undefined ? { seed: spec.seed } : {}),
    webSearch: spec.webSearch,
    referenceImages: spec.referenceImages,
    referenceVideos: spec.referenceVideos,
    referenceAudios: spec.referenceAudios,
  }
}

function materialsEqual(a: VideoWorkbenchMaterial[], b: VideoWorkbenchMaterial[]): boolean {
  if (a.length !== b.length) return false
  return a.every((m, i) => m.src === b[i].src && m.name === b[i].name)
}

/**
 * 规格等值比较 —— 看板 IR 与撤销栈共用。
 *
 * 两处都靠它判断「这张卡真的变了吗」来决定是否落盘,两份实现一旦漂移,
 * 就会出现「IR 认为没变、撤销认为变了」这类只在特定字段上复现的怪账。
 */
export function specEquals(a: VideoWorkbenchSpec, b: VideoWorkbenchSpec): boolean {
  return (
    a.prompt === b.prompt
    && a.model === b.model
    && a.resolution === b.resolution
    && a.ratio === b.ratio
    && a.duration === b.duration
    && a.generateAudio === b.generateAudio
    && a.mode === b.mode
    && a.seed === b.seed
    && a.webSearch === b.webSearch
    && materialsEqual(a.referenceImages, b.referenceImages)
    && materialsEqual(a.referenceVideos, b.referenceVideos)
    && materialsEqual(a.referenceAudios, b.referenceAudios)
  )
}

/** 任务仍在飞（可取消、需要重启对账、规格定格不可改）的状态集合。 */
export function isActiveStatus(status: VideoWorkbenchCardStatus): boolean {
  return status === 'preparing' || status === 'queued' || status === 'running'
}

/** 页内 order 压实(只动指定页的卡,其他页原样)。 */
export function reorderBoard(
  cards: VideoWorkbenchCard[],
  boardId: string | undefined,
): VideoWorkbenchCard[] {
  let i = 0
  return cards.map((c) => {
    if (c.boardId !== boardId) return c
    const next = c.order === i ? c : { ...c, order: i }
    i += 1
    return next
  })
}

export function createDefaultBoard(order = 0, name?: string): VideoWorkbenchBoard {
  return { id: createId(), name: name ?? `页面 ${order + 1}`, order, createdAt: Date.now() }
}
