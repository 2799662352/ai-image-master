// 可灵 4.0 / 4.0 Omni 的分镜(多镜头)—— main / preload / renderer 三端共享的纯类型与纯函数。
//
// 规则出处:腾讯云 VOD AIGC 接入指南 3.9.8(分镜参数),网关实现见 new-api #184
// (`tencentvod/kling.go` 的 `klingMultiShotFromMeta`),网页版同口径实现见 sora-ui #296
// (`canvas/api/video/klingMultiShot.ts`):
//   - 智能分镜 `intelligence`:只给总提示词,模型自己切镜头。**必须有提示词**,不收 multi_prompt;
//   - 自定义分镜 `customize`:1~6 个镜头,每个镜头一段描述(≤512 字)+ 整数秒时长(≥1),
//     各镜头时长之和 = 视频总时长。
// 分镜不改计费 —— 仍按总时长 × 分辨率倍率。
//
// 这个文件**只放纯函数**:不 import 任何运行时模块、不碰 store / IPC。能力表(`seedance.ts`)
// 与工作台的卡片规格都 import 它,所以它不能反过来 import 那两个。

export const KLING_MAX_SHOTS = 6
export const KLING_MAX_SHOT_PROMPT_LENGTH = 512
export const KLING_MIN_SHOT_SECONDS = 1

export interface KlingShot {
  prompt: string
  duration: number
}

/**
 * 卡片 / IPC / MCP 共用的分镜形状。缺省(`undefined`)= 单镜头。
 *
 * 判别字段叫 `type`(与 sora-ui 的 BFF 请求同名);`coerceKlingMultiShot` 同时认 `mode`,
 * 因为模型常把两个写混。
 */
export type KlingMultiShot =
  | { type: 'intelligence' }
  | { type: 'customize'; shots: KlingShot[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toShot(raw: unknown): KlingShot {
  const item = isRecord(raw) ? raw : {}
  const duration = typeof item.duration === 'number' ? item.duration : Number(item.duration)
  return {
    prompt: typeof item.prompt === 'string' ? item.prompt : '',
    // 读不出来的时长记 0 而不是悄悄补 1:`validateKlingMultiShot` 会如实报「时长需为…整数」,
    // 用户看到的是哪一镜有问题,而不是总时长莫名对不上。
    duration: Number.isFinite(duration) ? duration : 0,
  }
}

/**
 * 宽松解析:卡片持久化 / 工程文件 / IPC / MCP 进来的值都先过这一道。
 *
 * - 认不出的、`off` / `single` / `false` / `null` → `null`(单镜头);
 * - `customize` 但 `shots` 缺失 → `null`(没有镜头可言,留一个空壳只会让提交时才炸);
 * - **不裁镜头数、不改时长** —— 超过 6 个、时长之和不对,都留给 {@link validateKlingMultiShot}
 *   说明白,悄悄修正比报错更糟。
 */
export function coerceKlingMultiShot(raw: unknown): KlingMultiShot | null {
  if (!isRecord(raw)) return null
  const kind = raw.type ?? raw.mode
  if (kind === 'intelligence') return { type: 'intelligence' }
  if (kind !== 'customize') return null
  if (!Array.isArray(raw.shots) || raw.shots.length === 0) return null
  return { type: 'customize', shots: raw.shots.map(toShot) }
}

export function sumShotSeconds(shots: ReadonlyArray<KlingShot>): number {
  return shots.reduce((total, shot) => total + (Number.isFinite(shot.duration) ? shot.duration : 0), 0)
}

/**
 * 把总时长拆成 count 份(每份 ≥1 秒,余数从前往后每份多 1 秒)。
 * count 超过总时长时按总时长截断,保证每份 ≥1 秒。
 */
export function splitDuration(total: number, count: number): number[] {
  const safeTotal = Math.max(KLING_MIN_SHOT_SECONDS, Math.floor(total))
  const parts = Math.max(1, Math.min(count, safeTotal))
  const base = Math.floor(safeTotal / parts)
  const extra = safeTotal - base * parts
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0))
}

/** 新开自定义分镜时的初始镜头:两个镜头平分总时长,描述留空。 */
export function defaultKlingShots(totalDuration: number): KlingShot[] {
  return splitDuration(totalDuration, 2).map((duration) => ({ prompt: '', duration }))
}

/**
 * 总时长变了(下拉改时长 / 换模型被收敛)之后,让各镜头时长之和重新等于总时长,描述原样保留:
 * 按原比例缩放并保证每个 ≥1 秒,尾差补在最后一个镜头;镜头数多于总时长秒数时从尾部砍掉多余的镜头。
 * 已经对得上的原样返回**同一个引用**(调用方据此判断要不要写回)。
 */
export function fitKlingShotsToDuration(
  shots: ReadonlyArray<KlingShot>,
  totalDuration: number,
): KlingShot[] {
  const total = Math.max(KLING_MIN_SHOT_SECONDS, Math.floor(totalDuration))
  if (
    shots.length > 0 &&
    shots.length <= total &&
    shots.length <= KLING_MAX_SHOTS &&
    shots.every((shot) => Number.isInteger(shot.duration) && shot.duration >= KLING_MIN_SHOT_SECONDS) &&
    sumShotSeconds(shots) === total
  ) {
    return shots as KlingShot[]
  }
  if (shots.length === 0) return defaultKlingShots(total)

  const kept = shots.slice(0, Math.min(shots.length, total, KLING_MAX_SHOTS))
  const weights = kept.map((shot) =>
    Number.isFinite(shot.duration) && shot.duration > 0 ? shot.duration : KLING_MIN_SHOT_SECONDS,
  )
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const durations = weights.map((weight) =>
    Math.max(KLING_MIN_SHOT_SECONDS, Math.floor((weight / weightSum) * total)),
  )
  // 每个 ≥1 秒的下限可能让合计超出,先从最长的镜头里扣回来;再把剩余的秒数补给最后一个镜头。
  let overflow = durations.reduce((a, b) => a + b, 0) - total
  while (overflow > 0) {
    let longest = 0
    for (let i = 1; i < durations.length; i += 1) {
      if (durations[i] > durations[longest]) longest = i
    }
    if (durations[longest] <= KLING_MIN_SHOT_SECONDS) break
    durations[longest] -= 1
    overflow -= 1
  }
  if (overflow < 0) durations[durations.length - 1] += -overflow
  return kept.map((shot, i) => ({ prompt: shot.prompt, duration: durations[i] }))
}

/**
 * 加一个镜头:新镜头 1 秒、描述留空,这 1 秒从当前最长的镜头里借(它得 ≥2 秒),合计不变。
 * 没得借(每个镜头都只有 1 秒)就让合计多 1 秒 —— 总时长是卡片的事,这里不替它做主,由校验提示。
 * 已经 6 个镜头原样返回同一个引用。
 */
export function addKlingShot(shots: ReadonlyArray<KlingShot>): KlingShot[] {
  if (shots.length >= KLING_MAX_SHOTS) return shots as KlingShot[]
  let longest = -1
  shots.forEach((shot, i) => {
    if (shot.duration > KLING_MIN_SHOT_SECONDS && (longest === -1 || shot.duration >= shots[longest].duration)) {
      longest = i
    }
  })
  const next = shots.map((shot, i) => (i === longest ? { ...shot, duration: shot.duration - 1 } : { ...shot }))
  next.push({ prompt: '', duration: KLING_MIN_SHOT_SECONDS })
  return next
}

/**
 * 删一个镜头:它的时长并给相邻的镜头(优先前一个,删第一个时给后一个),合计不变。
 * 只剩 1 个镜头时原样返回同一个引用(要回到单镜头请切换分镜模式,而不是把镜头删光)。
 */
export function removeKlingShot(shots: ReadonlyArray<KlingShot>, index: number): KlingShot[] {
  if (shots.length <= 1 || index < 0 || index >= shots.length) return shots as KlingShot[]
  const heir = index > 0 ? index - 1 : 1
  const gift = Number.isFinite(shots[index].duration) ? shots[index].duration : 0
  return shots
    .map((shot, i) => (i === heir ? { ...shot, duration: shot.duration + gift } : { ...shot }))
    .filter((_, i) => i !== index)
}

/**
 * 提交前校验;合法返回 `null`。文案与网关(英文原文)一一对应,前端先拦住,
 * 用户不必等 COS 中转 + 提交一整趟才看到英文报错。
 *
 * `prompt` 是卡片的总提示词:智能分镜靠它切镜头,所以必填;自定义分镜以各镜头描述为准,总提示词可以空。
 */
export function validateKlingMultiShot(
  multiShot: KlingMultiShot | null | undefined,
  totalDuration: number,
  prompt?: string,
): string | null {
  if (!multiShot) return null
  if (multiShot.type === 'intelligence') {
    return (prompt ?? '').trim() ? null : '智能分镜需要填写提示词（模型按提示词自己切镜头）'
  }
  const { shots } = multiShot
  if (shots.length === 0) return '自定义分镜至少需要 1 个镜头'
  if (shots.length > KLING_MAX_SHOTS) return `自定义分镜最多 ${KLING_MAX_SHOTS} 个镜头，收到 ${shots.length} 个`
  if (!Number.isInteger(totalDuration) || totalDuration <= 0) return '自定义分镜需要先确定视频总时长（整数秒）'
  let sum = 0
  for (let i = 0; i < shots.length; i += 1) {
    const shot = shots[i]
    const label = `第 ${i + 1} 个镜头`
    const text = shot.prompt.trim()
    if (!text) return `${label}的描述不能为空`
    if ([...text].length > KLING_MAX_SHOT_PROMPT_LENGTH) {
      return `${label}的描述不能超过 ${KLING_MAX_SHOT_PROMPT_LENGTH} 字`
    }
    if (!Number.isInteger(shot.duration) || shot.duration < KLING_MIN_SHOT_SECONDS) {
      return `${label}的时长需为不小于 ${KLING_MIN_SHOT_SECONDS} 秒的整数`
    }
    if (shot.duration > totalDuration) return `${label}的时长不能超过视频总时长 ${totalDuration} 秒`
    sum += shot.duration
  }
  if (sum !== totalDuration) {
    return `各镜头时长之和需等于视频总时长：当前 ${sum} 秒，视频总时长 ${totalDuration} 秒`
  }
  return null
}

/**
 * 自定义分镜下总提示词留空时,拿各镜头描述拼一份顶层提示词:网关 / 任务详情都要一份非空的。
 * (网关对「自定义分镜且没给 prompt」也会自己拼,这里拼是为了让任务详情里看到的和提交的是同一份。)
 */
export function joinKlingShotPrompts(shots: ReadonlyArray<KlingShot>): string {
  return shots.map((shot, i) => `镜头${i + 1}（${shot.duration}秒）：${shot.prompt.trim()}`).join('\n')
}

export function klingMultiShotEquals(
  a: KlingMultiShot | null | undefined,
  b: KlingMultiShot | null | undefined,
): boolean {
  if (!a || !b) return !a && !b
  if (a.type !== b.type) return false
  if (a.type === 'intelligence' || b.type === 'intelligence') return true
  return (
    a.shots.length === b.shots.length &&
    a.shots.every((shot, i) => shot.prompt === b.shots[i].prompt && shot.duration === b.shots[i].duration)
  )
}

/** 卡片 / 面板上的一行摘要。 */
export function klingMultiShotLabel(multiShot: KlingMultiShot | null | undefined): string {
  if (!multiShot) return '单镜头'
  return multiShot.type === 'intelligence' ? '智能分镜' : `分镜 ×${multiShot.shots.length}`
}
