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
import { DEFAULT_PROJECT_ID } from '../../../../types/videoWorkbench'
import type { SeedanceModelAlias } from '../../../../types/seedance'
import { capabilitiesFor } from '../../../../types/seedance'
import { WORKBENCH_MODES } from './modes'
import { coerceDocumentOrLink, serializeDocumentOrLink } from '../../../../shared/wan3Document'

/**
 * 值不在这个模型的支持集里就退回默认值。
 *
 * 退回而不是报错：切模型是个随手动作，为此弹一个错误对话框太重；但**留着**
 * 一个必被上游拒的值更糟 —— 用户要等一次网络往返才看到失败，而且失败信息里
 * 不会提「因为你换了模型」。
 */
function clampToSupported<T extends string>(
  value: T | undefined,
  supported: readonly string[],
  fallback: T,
): T {
  return value && supported.includes(value) ? value : fallback
}

/** 万相的官方默认画幅是 `adaptive`（跟随素材）；Seedance 家族是 16:9。 */
function defaultRatioFor(model: SeedanceModelAlias): VideoWorkbenchSpec['ratio'] {
  return capabilitiesFor(model).ratios.includes('adaptive') ? 'adaptive' : '16:9'
}

// 素材条数上限没有「与模型无关」的版本 —— 2.0 家族 9/3/3、2.5 是 30/10/10。
// 这里曾摆着一组 MAX_REFERENCE_* 常量「给不知道模型的旧调用点用」,结果 2.5 接进来
// 之后正是这些默认值在背地里把第 10 张图切掉:界面按能力表显示 9/30,落 state 那一刀
// 却按 9 切。上限只有一个来源 —— {@link materialLimitFor}，必须带模型。

export type MaterialKind = 'referenceImages' | 'referenceVideos' | 'referenceAudios'

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

/**
 * 时长归一化:-1 = 智能时长(模型自动决定,文档 8.1);其余按**该模型**的区间
 * 收敛(2.0 家族 4–15,2.5 4–30);非法回退 5。
 *
 * 区间必须跟模型走 —— 写死 15 会把用户在 2.5 上选的 30 秒在**建卡那一刻**就
 * 悄悄夹成 15,卡片显示 15、成片也 15,没有任何报错说明发生过什么。
 */
export function normalizeDuration(value: unknown, model: SeedanceModelAlias = '2.0'): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return 5
  if (n === -1) return -1
  const { min, max } = capabilitiesFor(model).duration
  return Math.min(max, Math.max(min, Math.round(n)))
}

/**
 * 「编辑视频」锁死智能时长。
 *
 * 上游 `taskMode="edit"` 的时长固定为 -1,给任何固定秒数都会被
 * `validateSeedanceRequest` 拒(types/seedance.ts)。所以固定秒数在这个模式下
 * **不是一个可选项** —— 让它选得出来、只在提交时报错,等于摆一个必踩的坑。
 *
 * 只锁 edit:`extend`(延长视频)上游没有这条限制,它的秒数是真能指定的。
 */
export function lockDurationForMode(mode: VideoWorkbenchMode, duration: number): number {
  return mode === 'edit_video' ? -1 : duration
}

/** 该模型下某类素材的条数上限（2.5 是 30/10/10，2.0 家族 9/3/3）。 */
export function materialLimitFor(kind: MaterialKind, model: SeedanceModelAlias = '2.0'): number {
  const caps = capabilitiesFor(model)
  return kind === 'referenceImages'
    ? caps.maxImages
    : kind === 'referenceVideos'
      ? caps.maxVideos
      : caps.maxAudios
}

export function clampMaterials(
  list: VideoWorkbenchMaterial[],
  kind: MaterialKind,
  model: SeedanceModelAlias = '2.0',
): VideoWorkbenchMaterial[] {
  return list.slice(0, materialLimitFor(kind, model))
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
  const model = input.model ?? '2.0'
  const mode = normalizeMode(input.mode)
  return {
    prompt: input.prompt ?? '',
    model,
    // 分辨率**刻意不收敛**：不支持的组合由 `canStart` 拦下并说明原因（「1080p
    // 只有 2.0 支持」），那比悄悄把用户选的档位改掉更好。
    resolution: input.resolution ?? '720p',
    // 画幅则必须收敛，因为它没有那层 canStart 检查，而且 `<select>` 的 value
    // 落在选项之外时会渲染成**空白** —— 用户看到的是一个没有值的下拉框。
    ratio: clampToSupported(input.ratio, capabilitiesFor(model).ratios, defaultRatioFor(model)),
    duration: lockDurationForMode(mode, normalizeDuration(input.duration ?? 5, model)),
    generateAudio: input.generateAudio !== false,
    mode,
    ...(seed !== undefined ? { seed } : {}),
    webSearch: input.webSearch !== false,
    // 归一成序列化形态:UI 写 JSON、MCP 写裸 URL,两种都认(coerce)。
    // 认不出的(坏数据/手改过的持久化)当没设置,而不是原样留着等提交时才炸。
    ...(() => {
      const doc = coerceDocumentOrLink(input.documentOrLink)
      return doc ? { documentOrLink: serializeDocumentOrLink(doc) } : {}
    })(),
    referenceImages: clampMaterials((input.referenceImages ?? []).map(toMaterial), 'referenceImages', model),
    referenceVideos: clampMaterials((input.referenceVideos ?? []).map(toMaterial), 'referenceVideos', model),
    referenceAudios: clampMaterials((input.referenceAudios ?? []).map(toMaterial), 'referenceAudios', model),
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
    ...(spec.documentOrLink ? { documentOrLink: spec.documentOrLink } : {}),
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
    // 序列化字符串直接比:同一个槽位值序列化结果稳定(字段顺序由 serialize 固定)。
    && (a.documentOrLink ?? '') === (b.documentOrLink ?? '')
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

export function createDefaultBoard(order = 0, name?: string, projectId = DEFAULT_PROJECT_ID): VideoWorkbenchBoard {
  return { id: createId(), projectId, name: name ?? `页面 ${order + 1}`, order, createdAt: Date.now() }
}
