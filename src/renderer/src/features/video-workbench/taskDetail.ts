/**
 * 「任务详情」面板的数据层 —— 把一张卡上散落的标识 / 请求参数 / 结果 / 版本收成
 * 一份给人看、也能整份复制的文档。纯函数,不碰 DOM,面板只负责摆。
 *
 * ## 为什么要有这一页
 *
 * 卡片脚注一直只露 `task: <taskId>`。那是**网关签发的号**,只对我们这一侧有意义;
 * 用户拿着它去找火山 / 阿里对账,对方一律不认 —— 他们认的是网关**之后那一跳**的
 * 任务号(`cgt-…` / DashScope uuid),也就是 `upstreamTaskId`。这一页把它摆在
 * 最显眼的位置,再顺手把排障要翻 IndexedDB 才能看到的东西(实际递上去的参数、
 * 三级结果地址、计费口径、历次版本)一并摆出来。
 *
 * ## 三条纪律
 *
 * 1. **素材只记名字与地址,data: 字节绝不进文档。** 「复制全部」会被贴进聊天 /
 *    工单,几 MB 的 base64 贴进去谁都没法看。
 * 2. **缺就说缺,不编。** 上游号还没回传就写「网关尚未回传」并标 `missing`,
 *    不拿网关号冒充;从没提交过的卡,任务 ID 那行也标 missing。
 * 3. **直连没有「另一跳」。** 自填 Key 直连时 `taskId` 本身就是供应商那边的号,
 *    上游任务 ID 行直接给它并说明原因 —— 用户要的是「拿哪个号去找供应商」,
 *    不是字段名的教条。
 */

import type {
  VideoWorkbenchCard,
  VideoWorkbenchMaterial,
  VideoWorkbenchVersion,
} from '../../../../types/videoWorkbench'
import type { VideoBillingSource, VideoModelAlias } from '../../../../types/seedance'
import { getModeSpec } from './modes'

export interface TaskDetailField {
  key: string
  label: string
  value: string
  /** 值可一键复制(各类 ID、地址)。缺失行不给。 */
  copy?: boolean
  /** 灰字补充:供应商归属、为什么为空、口径说明。 */
  hint?: string
  /** 本地文件路径:面板据此给「在文件夹中显示」。 */
  path?: string
  /** 值缺失,`value` 是占位说明而不是数据。 */
  missing?: boolean
}

export interface TaskDetailSection {
  key: 'ids' | 'request' | 'timing' | 'result' | 'versions'
  title: string
  fields: TaskDetailField[]
}

export interface TaskDetail {
  title: string
  sections: TaskDetailSection[]
  /** 这张卡实际递给上游的请求参数(素材只记名字与地址)。面板作 JSON 块展示。 */
  request: Record<string, unknown>
  /** 整份详情的 JSON 文本,给「复制全部」。 */
  json: string
}

export interface TaskDetailOptions {
  /** 卡片在页内的位置(0 起),标题显示 #01 起。 */
  index: number
  /** 「耗时」的现在时刻;省略取 Date.now()。测试注入用。 */
  now?: number
}

const INLINE_PLACEHOLDER = '(内嵌 data: 图,已省略)'

/** 网关之后那一跳是谁家 —— 决定上游任务号该拿去找谁。 */
function upstreamVendor(model: VideoModelAlias): string {
  return model.startsWith('wan') ? '阿里云百炼 · DashScope' : '火山引擎 · Ark'
}

function billingLabel(billing: VideoBillingSource | undefined): string {
  switch (billing) {
    case 'platform':
      return '平台额度(经网关)'
    case 'own-key':
      return '自填 Key(直连)'
    case undefined:
      return '未记录(旧卡片)'
    default: {
      const exhaustive: never = billing
      return String(exhaustive)
    }
  }
}

function statusLabel(status: VideoWorkbenchCard['status']): string {
  switch (status) {
    case 'draft':
      return '草稿'
    case 'preparing':
      return '准备中'
    case 'queued':
      return '排队中'
    case 'running':
      return '渲染中'
    case 'succeeded':
      return '已完成'
    case 'failed':
      return '失败'
    case 'cancelled':
      return '已取消'
    default: {
      const exhaustive: never = status
      return String(exhaustive)
    }
  }
}

function persistenceLabel(persistence: VideoWorkbenchCard['persistence']): string {
  switch (persistence) {
    case 'idle':
      return '未开始'
    case 'running':
      return '正在落盘 / 转存'
    case 'done':
      return '已落盘并转存'
    case 'failed':
      return '落盘失败(后台重试中)'
    case undefined:
      return '—'
    default: {
      const exhaustive: never = persistence
      return String(exhaustive)
    }
  }
}

function formatTime(ts: number | undefined): string {
  if (ts === undefined) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes === 0) return `${seconds} 秒`
  return `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`
}

function materialBrief(m: VideoWorkbenchMaterial): { name: string; src: string } {
  return { name: m.name, src: m.src.startsWith('data:') ? INLINE_PLACEHOLDER : m.src }
}

function isTerminal(status: VideoWorkbenchCard['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled'
}

function requestOf(card: VideoWorkbenchCard): Record<string, unknown> {
  return {
    prompt: card.prompt,
    model: card.model,
    mode: card.mode,
    modeLabel: getModeSpec(card.mode).label,
    resolution: card.resolution,
    ratio: card.ratio,
    duration: card.duration,
    generateAudio: card.generateAudio,
    webSearch: card.webSearch === true,
    ...(card.seed !== undefined ? { seed: card.seed } : {}),
    ...(card.documentOrLink ? { documentOrLink: card.documentOrLink } : {}),
    referenceImages: card.referenceImages.map(materialBrief),
    referenceVideos: card.referenceVideos.map(materialBrief),
    referenceAudios: card.referenceAudios.map(materialBrief),
  }
}

function idFields(card: VideoWorkbenchCard): TaskDetailField[] {
  const direct = card.billing === 'own-key'
  const submitted = Boolean(card.taskId)
  const vendor = upstreamVendor(card.model)

  const taskId: TaskDetailField = submitted
    ? {
        key: 'taskId',
        label: direct ? '任务 ID(直连)' : '任务 ID(网关)',
        value: card.taskId!,
        copy: true,
        ...(direct ? {} : { hint: '网关签发,只在本应用与网关之间有效;找供应商请用下一行。' }),
      }
    : { key: 'taskId', label: '任务 ID', value: '尚未提交到上游', missing: true }

  let upstream: TaskDetailField
  if (card.upstreamTaskId) {
    upstream = { key: 'upstreamTaskId', label: '上游任务 ID', value: card.upstreamTaskId, copy: true, hint: `${vendor} —— 找供应商对账用这个号。` }
  } else if (direct && submitted) {
    upstream = {
      key: 'upstreamTaskId',
      label: '上游任务 ID',
      value: card.taskId!,
      copy: true,
      hint: `直连 ${vendor},任务 ID 即供应商那边的号,没有另一跳。`,
    }
  } else if (submitted) {
    upstream = { key: 'upstreamTaskId', label: '上游任务 ID', value: '网关尚未回传', missing: true, hint: `${vendor}。首轮轮询后一般就有;老卡片可能一直没有。` }
  } else {
    upstream = { key: 'upstreamTaskId', label: '上游任务 ID', value: '尚未提交到上游', missing: true }
  }

  return [
    taskId,
    upstream,
    card.clientId
      ? { key: 'clientId', label: '客户端请求 ID', value: card.clientId, copy: true, hint: '本机提交时生成,用来把广播对回这张卡。' }
      : { key: 'clientId', label: '客户端请求 ID', value: '—', missing: true },
    { key: 'cardId', label: '卡片 ID', value: card.id, copy: true },
    { key: 'billing', label: '计费来源', value: billingLabel(card.billing) },
  ]
}

function timingFields(card: VideoWorkbenchCard, now: number): TaskDetailField[] {
  const fields: TaskDetailField[] = [
    { key: 'startedAt', label: '提交时间', value: formatTime(card.startedAt) },
    { key: 'updatedAt', label: '最后更新', value: formatTime(card.updatedAt) },
  ]
  if (card.startedAt !== undefined) {
    const end = isTerminal(card.status) ? card.updatedAt : now
    fields.push({ key: 'elapsed', label: isTerminal(card.status) ? '总耗时' : '已耗时', value: formatElapsed(end - card.startedAt) })
  }
  return fields
}

function billedField(card: VideoWorkbenchCard): TaskDetailField | undefined {
  if (typeof card.billedSeconds === 'number') {
    return { key: 'billed', label: '计费口径(秒)', value: `${card.billedSeconds} 秒`, hint: '上游实际出片秒数,按秒计费的模型用它。' }
  }
  if (typeof card.completionTokens === 'number') {
    return {
      key: 'billed',
      label: '计费口径(completion tokens)',
      value: card.completionTokens.toLocaleString('en-US'),
      hint: '上游回传的 usage.completion_tokens。',
    }
  }
  return undefined
}

function resultFields(card: VideoWorkbenchCard): TaskDetailField[] {
  const fields: TaskDetailField[] = [{ key: 'status', label: '状态', value: statusLabel(card.status) }]
  if (card.error) fields.push({ key: 'error', label: '错误', value: card.error })
  fields.push(
    card.localPath
      ? { key: 'localPath', label: '成片(本地)', value: card.localPath, copy: true, path: card.localPath }
      : { key: 'localPath', label: '成片(本地)', value: '—', missing: true },
    card.remoteUrl
      ? { key: 'remoteUrl', label: '成片(云端)', value: card.remoteUrl, copy: true, hint: 'COS 永久地址,跨设备可播。' }
      : { key: 'remoteUrl', label: '成片(云端)', value: '—', missing: true },
  )
  if (card.videoUrl) {
    fields.push({ key: 'videoUrl', label: '上游临时地址', value: card.videoUrl, copy: true, hint: '有效期未知,仅作兜底。' })
  }
  fields.push({ key: 'persistence', label: '落盘', value: persistenceLabel(card.persistence) })
  if (typeof card.actualSeed === 'number') {
    fields.push({ key: 'actualSeed', label: '实际 seed', value: String(card.actualSeed), copy: true, hint: '上游实际使用的种子,填回可复现。' })
  }
  const billed = billedField(card)
  if (billed) fields.push(billed)
  return fields
}

function versionLine(v: VideoWorkbenchVersion): string {
  const parts = [formatTime(v.createdAt), `task ${v.taskId ?? '—'}`, `上游 ${v.upstreamTaskId ?? '—'}`]
  if (v.localPath) parts.push(v.localPath)
  else if (v.remoteUrl) parts.push(v.remoteUrl)
  return parts.join(' · ')
}

function versionFields(versions: VideoWorkbenchVersion[]): TaskDetailField[] {
  return versions.map((v) => ({ key: `version-${v.seq}`, label: `v${v.seq}`, value: versionLine(v) }))
}

function versionJson(v: VideoWorkbenchVersion): Record<string, unknown> {
  return {
    seq: v.seq,
    createdAt: v.createdAt,
    taskId: v.taskId ?? null,
    upstreamTaskId: v.upstreamTaskId ?? null,
    ...(v.localPath ? { localPath: v.localPath } : {}),
    ...(v.remoteUrl ? { remoteUrl: v.remoteUrl } : {}),
    ...(v.videoUrl ? { videoUrl: v.videoUrl } : {}),
    ...(v.actualSeed !== undefined ? { actualSeed: v.actualSeed } : {}),
    ...(v.completionTokens !== undefined ? { completionTokens: v.completionTokens } : {}),
    ...(v.billedSeconds !== undefined ? { billedSeconds: v.billedSeconds } : {}),
    prompt: v.spec.prompt,
  }
}

export function buildTaskDetail(card: VideoWorkbenchCard, opts: TaskDetailOptions): TaskDetail {
  const now = opts.now ?? Date.now()
  const request = requestOf(card)
  const versions = card.versions ?? []

  const sections: TaskDetailSection[] = [
    { key: 'ids', title: '标识', fields: idFields(card) },
    { key: 'timing', title: '时间', fields: timingFields(card, now) },
    { key: 'result', title: '结果', fields: resultFields(card) },
  ]
  if (versions.length > 0) sections.push({ key: 'versions', title: '历史版本', fields: versionFields(versions) })

  const doc = {
    cardId: card.id,
    position: opts.index + 1,
    status: card.status,
    ids: {
      taskId: card.taskId ?? null,
      upstreamTaskId: card.upstreamTaskId ?? null,
      clientId: card.clientId ?? null,
    },
    billing: card.billing ?? null,
    upstreamVendor: upstreamVendor(card.model),
    request,
    timing: {
      startedAt: card.startedAt ?? null,
      updatedAt: card.updatedAt,
    },
    result: {
      error: card.error ?? null,
      localPath: card.localPath ?? null,
      remoteUrl: card.remoteUrl ?? null,
      videoUrl: card.videoUrl ?? null,
      persistence: card.persistence ?? null,
      actualSeed: card.actualSeed ?? null,
      completionTokens: card.completionTokens ?? null,
      billedSeconds: card.billedSeconds ?? null,
    },
    versions: versions.map(versionJson),
  }

  return {
    title: `#${String(opts.index + 1).padStart(2, '0')} · 任务详情`,
    sections,
    request,
    json: JSON.stringify(doc, null, 2),
  }
}
