// 提示词素材引用 token 工具 —— 移植自 soraui 旧工作台。
//
// token 形态:`【@图片1】/【@视频2】/【@音频1】`(序号 1 起,对应同类素材列表
// 下标+1)。提交时主进程 normalizeSeedancePromptReferences 只把这层 chip 外壳解成
// 上游认识的 `@图片1`(`@` 保留,其余提示词原样发送),渲染端只负责 token 的插入/
// 删除/序号维护与 chip 展示。

export type MediaTokenKind = 'image' | 'video' | 'audio'

export const MEDIA_TOKEN_RE = /【@(图片|视频|音频)(\d+)】/g

export const KIND_ZH: Record<MediaTokenKind, '图片' | '视频' | '音频'> = {
  image: '图片',
  video: '视频',
  audio: '音频',
}

const ZH_KIND: Record<string, MediaTokenKind> = { 图片: 'image', 视频: 'video', 音频: 'audio' }

export function mediaToken(kind: MediaTokenKind, index1: number): string {
  return `【@${KIND_ZH[kind]}${index1}】`
}

export function parseTokenZh(zh: string): MediaTokenKind {
  return ZH_KIND[zh] ?? 'image'
}

/**
 * 删除某个素材后,把提示词里对应 token 删掉,并把同类更大序号整体 -1。
 * 移植自 soraui JimengStyleEditor.removeMedia(占位符法防连环替换)。
 * @param removedIndex1 被删素材的 1 起序号
 */
export function removeTokenAndReindex(prompt: string, kind: MediaTokenKind, removedIndex1: number): string {
  const zh = KIND_ZH[kind]
  let next = prompt
  // 1. 删除被移除素材的 token(可能带前后空格,压成单空格)
  next = next.split(`【@${zh}${removedIndex1}】`).join('')
  // 2. 更大的序号整体 -1:先换成占位符再回填,避免 4→3 之后又被 3→2 二次替换
  const PH = (i: number) => `\u0000PH_${zh}_${i}\u0000`
  for (let i = removedIndex1 + 1; i <= 99; i++) {
    next = next.split(`【@${zh}${i}】`).join(PH(i - 1))
  }
  for (let i = removedIndex1; i <= 98; i++) {
    next = next.split(PH(i)).join(`【@${zh}${i}】`)
  }
  return next
}

/**
 * 素材在同类列表内从 fromIndex1 挪到 toIndex1(拖拽换位)后,重映射提示词里
 * 的同类 token 序号,让每个 chip 仍指向拖拽前的那份素材(顺序调整不影响引用)。
 * 占位符法防连环替换,与 removeTokenAndReindex 同款。
 */
export function remapTokensForMove(
  prompt: string,
  kind: MediaTokenKind,
  fromIndex1: number,
  toIndex1: number,
): string {
  if (fromIndex1 === toIndex1) return prompt
  const zh = KIND_ZH[kind]
  const lo = Math.min(fromIndex1, toIndex1)
  const hi = Math.max(fromIndex1, toIndex1)
  /** 旧序号 → 新序号(区间外不动)。 */
  const mapIndex = (i: number): number => {
    if (i === fromIndex1) return toIndex1
    if (fromIndex1 < toIndex1) return i > fromIndex1 && i <= toIndex1 ? i - 1 : i
    return i >= toIndex1 && i < fromIndex1 ? i + 1 : i
  }
  const PH = (i: number) => `\u0000MV_${zh}_${i}\u0000`
  let next = prompt
  for (let i = lo; i <= hi; i++) {
    next = next.split(`【@${zh}${i}】`).join(PH(mapIndex(i)))
  }
  for (let i = lo; i <= hi; i++) {
    next = next.split(PH(i)).join(`【@${zh}${i}】`)
  }
  return next
}

export interface AtDetection {
  /** `@` 在纯文本中的下标。 */
  atPosition: number
  /** 从 `@` 到光标的文本(含 @)。 */
  prefix: string
  shouldShow: boolean
}

/**
 * 从光标向前回溯检测 `@` 触发(soraui useTokenAutocomplete.detectAt 同款):
 * 遇到空白/中英文标点停止;要求 @ 前是行首/空白/右括号类字符。
 */
export function detectAtTrigger(text: string, cursor: number): AtDetection | null {
  let atPosition = -1
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i]
    if (/[\s\n\r,，。！？!?;；]/.test(ch)) break
    if (ch === '@') {
      atPosition = i
      break
    }
  }
  if (atPosition === -1) return null
  const prefix = text.substring(atPosition, cursor)
  const isValidPosition = atPosition === 0 || /[\s\n\r】）})\]」』]/.test(text[atPosition - 1])
  return { atPosition, prefix, shouldShow: isValidPosition && prefix.length >= 1 }
}

/**
 * 把建议 token 插进提示词:替换从 `@` 到光标的段,自动补前后空格。
 * 返回新文本与新光标位置。找不到 @ 时原样返回。
 */
export function applyTokenAtCursor(
  text: string,
  cursor: number,
  token: string,
): { text: string; cursor: number } {
  let atPos = -1
  for (let i = cursor - 1; i >= 0; i--) {
    if (text[i] === '@') {
      atPos = i
      break
    }
  }
  if (atPos < 0) return { text, cursor }
  const before = text.substring(0, atPos)
  const after = text.substring(cursor)
  const spaceBefore = before.length > 0 && !/[\s\n]$/.test(before) ? ' ' : ''
  // token 后补一个空格(after 已以空白开头时不重复)
  const spaceAfter = /^[\s\n]/.test(after) ? '' : ' '
  const next = before + spaceBefore + token + spaceAfter + after
  return { text: next, cursor: before.length + spaceBefore.length + token.length + spaceAfter.length }
}
