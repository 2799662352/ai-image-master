// 工程文件 `*.catwb.json` —— 一部剧的 URL-first 备份格式(设计稿 §6)。
//
// 全部纯函数:构建、加固解析、导出前的待上传清点、导入前的展开。不碰 store、不碰
// IPC,单测直接喂对象。上传与写盘由 exportProject.ts / 主进程负责。
//
// 三条硬约束:
// - 文件里**只有 https 地址**:没有 base64、没有本地路径、没有 asset://。所以
//   buildProjectFile 对任何解析不到 https 的素材整份拒绝 —— 宁可不写,不写半个文件。
// - **不带任何内部 id**:导入永远新建一部剧,同一文件导两次是两部独立的剧。
// - `formatVersion` 独立于 `WORKBENCH_IR_VERSION`:只在文件结构变化时递增;读入时
//   高于本机可读 → 拒绝并提示更新客户端,未知字段一律放行(向前兼容)。

import {
  ALL_VIDEO_MODEL_ALIASES,
  type SeedanceModelAlias,
} from '../../../../types/seedance'
import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchCardInput,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
  VideoWorkbenchProject,
} from '../../../../types/videoWorkbench'
import { MATERIAL_KINDS, type MaterialKind } from './cardSpec'

export const PROJECT_FILE_FORMAT = 'catimation-workbench-project'
export const PROJECT_FILE_VERSION = 1
export const PROJECT_FILE_EXT = '.catwb.json'
/** 50 MB:URL 方案下正常文件几十到几百 KB,这个闸只防误选 / 恶意文件。 */
export const PROJECT_FILE_MAX_BYTES = 50 * 1024 * 1024

export interface ProjectFileMaterial {
  name: string
  /** 必为 https。 */
  src: string
}

export interface ProjectFileVersion {
  seq: number
  remoteUrl?: string
  prompt: string
}

/** 结果是只读注解:导入后已完成/失败保留状态与云端地址,其余一律草稿。 */
export interface ProjectFileResult {
  status: 'draft' | 'succeeded' | 'failed'
  remoteUrl?: string
  error?: string
  versions?: ProjectFileVersion[]
}

export interface ProjectFileCard {
  prompt: string
  model: string
  resolution: string
  ratio: string
  duration: number
  generateAudio: boolean
  mode: string
  seed?: number
  webSearch: boolean
  documentOrLink?: string
  referenceImages: ProjectFileMaterial[]
  referenceVideos: ProjectFileMaterial[]
  referenceAudios: ProjectFileMaterial[]
  summary?: string
  result?: ProjectFileResult
}

export interface ProjectFileBoard {
  name: string
  summary?: string
  cards: ProjectFileCard[]
}

export interface WorkbenchProjectFile {
  format: typeof PROJECT_FILE_FORMAT
  formatVersion: number
  app: { name: string; version: string }
  exportedAt: string
  project: { name: string; createdAt: number; updatedAt: number; summary?: string }
  boards: ProjectFileBoard[]
}

export interface ProjectFileSummary {
  segments: number
  cards: number
  materials: number
  exportedAt: string
  appVersion: string
}

export function isHttpsUrl(src: string): boolean {
  return /^https?:\/\//i.test(src)
}

// ---------------------------------------------------------------------------
// 导出前清点
// ---------------------------------------------------------------------------

export type ExportPendingItem =
  | { kind: 'material'; cardId: string; field: MaterialKind; index: number; src: string }
  | { kind: 'result'; cardId: string; src: string }

export interface ExportTargets {
  segments: number
  cards: number
  materials: number
  /** 导出前必须先换成 https 的东西:本地/内联素材、只有本地副本的成片。 */
  pending: ExportPendingItem[]
}

/** 素材导出时用哪个地址;拿不到 https 返回 null(= 待上传)。 */
function exportableSrc(m: VideoWorkbenchMaterial): string | null {
  if (isHttpsUrl(m.src)) return m.src
  if (m.src.startsWith('asset://') && m.previewUrl && isHttpsUrl(m.previewUrl)) return m.previewUrl
  return null
}

function ownCards(boards: readonly VideoWorkbenchBoard[], cards: readonly VideoWorkbenchCard[]): VideoWorkbenchCard[] {
  const ids = new Set(boards.map((b) => b.id))
  return cards.filter((c) => !!c.boardId && ids.has(c.boardId))
}

export function collectExportTargets(
  boards: readonly VideoWorkbenchBoard[],
  cards: readonly VideoWorkbenchCard[],
): ExportTargets {
  const own = ownCards(boards, cards)
  const pending: ExportPendingItem[] = []
  let materials = 0
  for (const card of own) {
    if (card.status === 'succeeded' && !card.remoteUrl && card.localPath) {
      pending.push({ kind: 'result', cardId: card.id, src: card.localPath })
    }
    for (const field of MATERIAL_KINDS) {
      card[field].forEach((m, index) => {
        materials += 1
        if (exportableSrc(m) === null) pending.push({ kind: 'material', cardId: card.id, field, index, src: m.src })
      })
    }
  }
  return { segments: boards.length, cards: own.length, materials, pending }
}

// ---------------------------------------------------------------------------
// 构建
// ---------------------------------------------------------------------------

export interface BuildProjectFileInput {
  project: VideoWorkbenchProject
  /** 可以传全部分段,这里按 projectId 过滤。 */
  boards: readonly VideoWorkbenchBoard[]
  cards: readonly VideoWorkbenchCard[]
  app: { name: string; version: string }
  now: number
  /** 非 https 的源(本地路径 / data:)→ 已上传得到的 https;拿不到返回 null。 */
  resolve: (src: string) => string | null
}

export type BuildProjectFileResult =
  | { ok: true; file: WorkbenchProjectFile }
  | { ok: false; reason: string }

function resolveMaterial(
  m: VideoWorkbenchMaterial,
  resolve: BuildProjectFileInput['resolve'],
): ProjectFileMaterial | null {
  const src = exportableSrc(m) ?? resolve(m.src)
  return src && isHttpsUrl(src) ? { name: m.name, src } : null
}

function exportResult(card: VideoWorkbenchCard, resolve: BuildProjectFileInput['resolve']): ProjectFileResult {
  if (card.status === 'failed') {
    return { status: 'failed', ...(card.error ? { error: card.error } : {}) }
  }
  if (card.status !== 'succeeded') return { status: 'draft' }
  const remoteUrl = card.remoteUrl ?? (card.localPath ? resolve(card.localPath) ?? undefined : undefined)
  // 一张「已完成」却没有任何云端地址的卡,导出去就是一张空卡:老实标草稿。
  if (!remoteUrl || !isHttpsUrl(remoteUrl)) return { status: 'draft' }
  const versions = (card.versions ?? []).map((v) => {
    const url = v.remoteUrl ?? (v.localPath ? resolve(v.localPath) ?? undefined : undefined)
    return { seq: v.seq, ...(url && isHttpsUrl(url) ? { remoteUrl: url } : {}), prompt: v.spec.prompt }
  })
  return { status: 'succeeded', remoteUrl, ...(versions.length > 0 ? { versions } : {}) }
}

export function buildProjectFile(input: BuildProjectFileInput): BuildProjectFileResult {
  const own = input.boards
    .filter((b) => b.projectId === input.project.id)
    .sort((a, b) => a.order - b.order)
  const missing: string[] = []
  const boards: ProjectFileBoard[] = own.map((board) => {
    const cards = input.cards
      .filter((c) => c.boardId === board.id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map((card): ProjectFileCard => {
        const materials = (field: MaterialKind): ProjectFileMaterial[] =>
          card[field].flatMap((m) => {
            const out = resolveMaterial(m, input.resolve)
            if (!out) missing.push(m.name || m.src)
            return out ? [out] : []
          })
        return {
          prompt: card.prompt,
          model: card.model,
          resolution: card.resolution,
          ratio: card.ratio,
          duration: card.duration,
          generateAudio: card.generateAudio,
          mode: card.mode,
          ...(card.seed !== undefined ? { seed: card.seed } : {}),
          webSearch: card.webSearch,
          ...(card.documentOrLink ? { documentOrLink: card.documentOrLink } : {}),
          referenceImages: materials('referenceImages'),
          referenceVideos: materials('referenceVideos'),
          referenceAudios: materials('referenceAudios'),
          ...(card.summary ? { summary: card.summary } : {}),
          result: exportResult(card, input.resolve),
        }
      })
    return { name: board.name, ...(board.summary ? { summary: board.summary } : {}), cards }
  })
  if (missing.length > 0) {
    return { ok: false, reason: `${missing.length} 个素材没有云端地址,无法导出:${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}` }
  }
  return {
    ok: true,
    file: {
      format: PROJECT_FILE_FORMAT,
      formatVersion: PROJECT_FILE_VERSION,
      app: { name: input.app.name, version: input.app.version },
      exportedAt: new Date(input.now).toISOString(),
      project: {
        name: input.project.name,
        createdAt: input.project.createdAt,
        updatedAt: input.project.updatedAt,
        ...(input.project.summary ? { summary: input.project.summary } : {}),
      },
      boards,
    },
  }
}

// ---------------------------------------------------------------------------
// 加固解析
// ---------------------------------------------------------------------------

export type ParseProjectFileResult =
  | { ok: true; file: WorkbenchProjectFile; summary: ProjectFileSummary }
  | { ok: false; code: 'too-large' | 'invalid' | 'format' | 'version'; reason: string }

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

class InvalidProjectFile extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') throw new InvalidProjectFile(`${what} 必须是字符串`)
  return v
}

function optStr(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined
  return str(v, what)
}

function num(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvalidProjectFile(`${what} 必须是数字`)
  return v
}

function optNum(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined
  return num(v, what)
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new InvalidProjectFile(`${what} 必须是数组`)
  return v
}

function parseMaterials(v: unknown, what: string): ProjectFileMaterial[] {
  if (v === undefined) return []
  return arr(v, what).map((m, i) => {
    if (!isRecord(m)) throw new InvalidProjectFile(`${what}[${i}] 必须是对象`)
    return { name: str(m.name, `${what}[${i}].name`), src: str(m.src, `${what}[${i}].src`) }
  })
}

function parseResult(v: unknown, what: string): ProjectFileResult | undefined {
  if (v === undefined) return undefined
  if (!isRecord(v)) throw new InvalidProjectFile(`${what} 必须是对象`)
  const status = str(v.status, `${what}.status`)
  if (status !== 'draft' && status !== 'succeeded' && status !== 'failed') {
    throw new InvalidProjectFile(`${what}.status 取值非法`)
  }
  const versions = v.versions === undefined
    ? undefined
    : arr(v.versions, `${what}.versions`).map((x, i) => {
        if (!isRecord(x)) throw new InvalidProjectFile(`${what}.versions[${i}] 必须是对象`)
        const remoteUrl = optStr(x.remoteUrl, `${what}.versions[${i}].remoteUrl`)
        return {
          seq: num(x.seq, `${what}.versions[${i}].seq`),
          ...(remoteUrl ? { remoteUrl } : {}),
          prompt: str(x.prompt, `${what}.versions[${i}].prompt`),
        }
      })
  const remoteUrl = optStr(v.remoteUrl, `${what}.remoteUrl`)
  const error = optStr(v.error, `${what}.error`)
  return {
    status,
    ...(remoteUrl ? { remoteUrl } : {}),
    ...(error ? { error } : {}),
    ...(versions ? { versions } : {}),
  }
}

function parseCard(v: unknown, what: string): ProjectFileCard {
  if (!isRecord(v)) throw new InvalidProjectFile(`${what} 必须是对象`)
  const seed = optNum(v.seed, `${what}.seed`)
  const documentOrLink = optStr(v.documentOrLink, `${what}.documentOrLink`)
  const summary = optStr(v.summary, `${what}.summary`)
  const result = parseResult(v.result, `${what}.result`)
  return {
    prompt: str(v.prompt, `${what}.prompt`),
    model: typeof v.model === 'string' ? v.model : '',
    resolution: typeof v.resolution === 'string' ? v.resolution : '',
    ratio: typeof v.ratio === 'string' ? v.ratio : '',
    duration: typeof v.duration === 'number' ? v.duration : 5,
    generateAudio: v.generateAudio !== false,
    mode: typeof v.mode === 'string' ? v.mode : '',
    ...(seed !== undefined ? { seed } : {}),
    webSearch: v.webSearch !== false,
    ...(documentOrLink ? { documentOrLink } : {}),
    referenceImages: parseMaterials(v.referenceImages, `${what}.referenceImages`),
    referenceVideos: parseMaterials(v.referenceVideos, `${what}.referenceVideos`),
    referenceAudios: parseMaterials(v.referenceAudios, `${what}.referenceAudios`),
    ...(summary ? { summary } : {}),
    ...(result ? { result } : {}),
  }
}

export function parseProjectFile(text: string): ParseProjectFileResult {
  // 字符数是字节数的下界:字符超闸,字节必然超闸。主进程读文件时另有按字节的闸。
  if (text.length > PROJECT_FILE_MAX_BYTES) {
    return { ok: false, code: 'too-large', reason: '文件超过 50 MB,不像是工程文件' }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text, (key, value) => {
      // JSON.parse 本身不会用 __proto__ 键改原型,但拒掉它们能让后面任何
      // `Object.assign` / 展开都不必再想这件事。
      if (FORBIDDEN_KEYS.has(key)) throw new InvalidProjectFile(`不允许的键:${key}`)
      return value
    })
  } catch (e) {
    return { ok: false, code: 'invalid', reason: e instanceof InvalidProjectFile ? e.message : '不是合法的 JSON' }
  }
  try {
    if (!isRecord(raw)) throw new InvalidProjectFile('顶层必须是对象')
    if (raw.format !== PROJECT_FILE_FORMAT) {
      return { ok: false, code: 'format', reason: '不是 CATIMATION 工程文件' }
    }
    const formatVersion = num(raw.formatVersion, 'formatVersion')
    if (formatVersion > PROJECT_FILE_VERSION) {
      return {
        ok: false,
        code: 'version',
        reason: `这个工程文件由更新的客户端导出(格式 v${formatVersion}),请先更新 CATIMATION 再导入`,
      }
    }
    if (!isRecord(raw.app)) throw new InvalidProjectFile('app 必须是对象')
    const app = { name: str(raw.app.name, 'app.name'), version: str(raw.app.version, 'app.version') }
    const exportedAt = str(raw.exportedAt, 'exportedAt')
    if (!isRecord(raw.project)) throw new InvalidProjectFile('project 必须是对象')
    const projectSummary = optStr(raw.project.summary, 'project.summary')
    const project = {
      name: str(raw.project.name, 'project.name'),
      createdAt: num(raw.project.createdAt, 'project.createdAt'),
      updatedAt: num(raw.project.updatedAt, 'project.updatedAt'),
      ...(projectSummary ? { summary: projectSummary } : {}),
    }
    const boards = arr(raw.boards, 'boards').map((b, i): ProjectFileBoard => {
      if (!isRecord(b)) throw new InvalidProjectFile(`boards[${i}] 必须是对象`)
      const summary = optStr(b.summary, `boards[${i}].summary`)
      return {
        name: str(b.name, `boards[${i}].name`),
        ...(summary ? { summary } : {}),
        cards: arr(b.cards, `boards[${i}].cards`).map((c, j) => parseCard(c, `boards[${i}].cards[${j}]`)),
      }
    })
    const file: WorkbenchProjectFile = { format: PROJECT_FILE_FORMAT, formatVersion, app, exportedAt, project, boards }
    return { ok: true, file, summary: summarize(file) }
  } catch (e) {
    return { ok: false, code: 'invalid', reason: e instanceof Error ? e.message : String(e) }
  }
}

export function summarize(file: WorkbenchProjectFile): ProjectFileSummary {
  let cards = 0
  let materials = 0
  for (const b of file.boards) {
    cards += b.cards.length
    for (const c of b.cards) materials += c.referenceImages.length + c.referenceVideos.length + c.referenceAudios.length
  }
  return { segments: file.boards.length, cards, materials, exportedAt: file.exportedAt, appVersion: file.app.version }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export function uniqueProjectName(name: string, existing: readonly string[]): string {
  const base = name.trim() || '导入的剧'
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base} (${n})`)) n += 1
  return `${base} (${n})`
}

export interface ImportCardPlan {
  input: VideoWorkbenchCardInput
  summary?: string
  result?: ProjectFileResult
}

export interface ImportPlan {
  boards: Array<{ name: string; summary?: string; cards: ImportCardPlan[] }>
}

const KNOWN_MODELS = new Set<string>(ALL_VIDEO_MODEL_ALIASES)
const RESOLUTIONS = new Set(['480p', '720p', '1080p'])
const RATIOS = new Set(['16:9', '9:16', '4:3', '3:4', '1:1', '21:9', 'adaptive'])

/**
 * 文件 → store 能吃的分段/卡片输入。规格字段认不出的就省略,让 normalizeSpec 补默认
 * 值 —— normalizeSpec 对未知模型会直接抛(查能力表),这里必须先挡住。
 */
export function planImport(file: WorkbenchProjectFile): ImportPlan {
  return {
    boards: file.boards.map((b) => ({
      name: b.name,
      ...(b.summary ? { summary: b.summary } : {}),
      cards: b.cards.map((c): ImportCardPlan => ({
        input: {
          prompt: c.prompt,
          ...(KNOWN_MODELS.has(c.model) ? { model: c.model as SeedanceModelAlias } : {}),
          ...(RESOLUTIONS.has(c.resolution) ? { resolution: c.resolution as VideoWorkbenchCardInput['resolution'] } : {}),
          ...(RATIOS.has(c.ratio) ? { ratio: c.ratio as VideoWorkbenchCardInput['ratio'] } : {}),
          duration: c.duration,
          generateAudio: c.generateAudio,
          ...(c.mode ? { mode: c.mode as VideoWorkbenchMode } : {}),
          ...(c.seed !== undefined ? { seed: c.seed } : {}),
          webSearch: c.webSearch,
          ...(c.documentOrLink ? { documentOrLink: c.documentOrLink } : {}),
          referenceImages: c.referenceImages.map((m) => ({ name: m.name, src: m.src })),
          referenceVideos: c.referenceVideos.map((m) => ({ name: m.name, src: m.src })),
          referenceAudios: c.referenceAudios.map((m) => ({ name: m.name, src: m.src })),
        },
        ...(c.summary ? { summary: c.summary } : {}),
        ...(c.result ? { result: c.result } : {}),
      })),
    })),
  }
}
