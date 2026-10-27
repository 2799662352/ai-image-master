/**
 * 出站淘汰旧的工具结果图片。
 *
 * **背景。** Codex 把工具产出的图(`view_image`、MCP 截图、出图结果…)以内联 base64
 * `input_image` 放进 `function_call_output`,之后每一轮都整段重放。官方只在两处处理:
 * 入口缩图,以及模型不支持图片时整体换占位文字;没有「按年龄淘汰旧图」。而 Codex 的
 * token 估算对每张图是固定值(约 1.8k token),与真实字节数无关——图一多,请求体涨到
 * 几十 MB 而估算纹丝不动,**依赖 token 的自动压缩永远等不到触发**,最终网关回
 * 413 / `Bad Request`,整条对话废掉。
 *
 * **这里的做法是社区做法,不是 Codex 官方机制**(Codex 官方没有对应项,查过 main 分支
 * `context_manager/{normalize,history}.rs` 与 PR 搜索)。只作用于经过兼容桥发往第三方
 * 网关(千问 / DeepSeek / xAI / Claude)的那一份请求,**不改 Codex 自己保存的历史**:
 * 想再看那张图,让工具重新产出一次即可。
 *
 * **规则**
 * - 只动工具结果(`function_call_output` / `custom_tool_call_output`)里的内联
 *   `data:` 图。用户贴的图、远程 URL 图、文字结果一概不碰。
 * - 数量窗口:保留最近 `maxKeep` 张,**按块**淘汰(每次一整块 `pruneBlock` 张),
 *   这样边界只在每攒够一块时才后移一次,前缀在多数轮次里字节不变,上游的提示词缓存
 *   不会被每轮的「滑动窗口」打穿。
 * - 只数张数,不看字节大小;**最新的一张永远保留**。
 * - 被淘汰的图原位换成一段 `input_text` 占位,同条里的其它内容、`call_id` 都不变。
 *   占位里带上这张图的**来源**:取配对 `function_call` 参数里的 `path` / `url` 等
 *   (真实 `view_image` 结果里图片本身不带路径,路径在调用参数里,而那条调用还留在历史中)。
 *   模型想再看,按来源重新开一次即可,不必凭记忆回答。取不到来源就用通用占位。
 * - 淘汰集合只会随历史增长而变大、且永远是最老的一批(见测试),所以同一段历史
 *   重放多少次结果都一样。
 */

type JsonObject = Record<string, unknown>

/** 窗口内最多保留的工具图数量。 */
export const STALE_TOOL_IMAGE_MAX_KEEP = 6
/** 淘汰以多少张为一块。窗口实际在 `MAX_KEEP - BLOCK + 1 .. MAX_KEEP` 之间浮动。 */
export const STALE_TOOL_IMAGE_PRUNE_BLOCK = 3
/** 占位文字的固定开头;测试和日志按它识别「这是被淘汰的图」。 */
export const STALE_TOOL_IMAGE_PLACEHOLDER_PREFIX =
  '[older tool image omitted from this request to keep it small'
/** 找不到来源时的占位。 */
export const STALE_TOOL_IMAGE_PLACEHOLDER =
  `${STALE_TOOL_IMAGE_PLACEHOLDER_PREFIX}; call the tool again if you need to see it]`
/** 来源(路径 / 地址)写进占位时的最大长度。 */
export const STALE_TOOL_IMAGE_SOURCE_MAX_CHARS = 300
/**
 * 配对的工具调用参数里,哪些键指向「这张图从哪来」。按顺序取第一个非空字符串。
 * `view_image` 用 `path`;其它读图 / 取图类工具常见的是文件路径或地址。
 */
const SOURCE_ARGUMENT_KEYS = ['path', 'file_path', 'filepath', 'image_path', 'url', 'image_url', 'src']

export interface StaleToolImageOptions {
  maxKeep?: number
  pruneBlock?: number
}

export interface StaleToolImageResult {
  /** 这次被换成占位的图数量。 */
  evicted: number
  /** 这次之后还留着的工具图数量。 */
  retained: number
  /** 被丢掉的 data URL 字符数。 */
  freedBytes: number
}

const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output'])

interface ImageSlot {
  parts: unknown[]
  index: number
  bytes: number
  callId: string | undefined
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function positiveInt(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 1 ? Math.floor(value as number) : fallback
}

/** 按出现顺序(= 时间顺序)收集工具结果里的内联图。 */
function collectToolImageSlots(input: unknown[]): ImageSlot[] {
  const slots: ImageSlot[] = []
  for (const item of input) {
    if (!isJsonObject(item) || typeof item.type !== 'string' || !TOOL_OUTPUT_TYPES.has(item.type)) continue
    const parts = item.output
    if (!Array.isArray(parts)) continue
    const callId = typeof item.call_id === 'string' ? item.call_id : undefined
    parts.forEach((part, index) => {
      if (!isJsonObject(part) || part.type !== 'input_image') return
      const url = part.image_url
      if (typeof url !== 'string' || !url.startsWith('data:')) return
      slots.push({ parts, index, bytes: url.length, callId })
    })
  }
  return slots
}

/** call_id → 该次调用的参数原文。只存字符串,真要用时才解析。 */
function collectCallArguments(input: unknown[]): Map<string, string> {
  const byCallId = new Map<string, string>()
  for (const item of input) {
    if (!isJsonObject(item) || item.type !== 'function_call') continue
    if (typeof item.call_id === 'string' && typeof item.arguments === 'string') {
      byCallId.set(item.call_id, item.arguments)
    }
  }
  return byCallId
}

/**
 * 这张图是从哪来的:取配对调用参数里的路径 / 地址。
 *
 * 这些文字本来就在历史里(同一条调用的参数),写进占位只是让模型不用翻:
 * 想再看这张图,按它重新调一次工具即可。取不到就返回 undefined,占位退回通用文字。
 * 折叠空白并截断,避免一个超长或带换行的参数撑大请求。
 */
function sourceOf(callArguments: string | undefined): string | undefined {
  if (!callArguments) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(callArguments)
  } catch {
    return undefined
  }
  if (!isJsonObject(parsed)) return undefined
  for (const key of SOURCE_ARGUMENT_KEYS) {
    const value = parsed[key]
    if (typeof value !== 'string') continue
    // 控制字符(含换行)统一折成空格再 trim:一条来源只占一行,也不让参数里的换行拆开占位。
    // eslint-disable-next-line no-control-regex
    const flat = value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim()
    if (!flat) continue
    return flat.length > STALE_TOOL_IMAGE_SOURCE_MAX_CHARS
      ? `${flat.slice(0, STALE_TOOL_IMAGE_SOURCE_MAX_CHARS)}…`
      : flat
  }
  return undefined
}

function placeholderText(source: string | undefined): string {
  if (!source) return STALE_TOOL_IMAGE_PLACEHOLDER
  return `${STALE_TOOL_IMAGE_PLACEHOLDER_PREFIX}; source: ${source}. Open it again with the same tool if you need to see it]`
}

/**
 * 就地改写 `body.input`。调用方传进来的必须是自己拥有的副本
 * (`flattenNamespaceTools` 已经深拷贝过)。
 */
export function evictStaleToolImages(
  body: JsonObject,
  options: StaleToolImageOptions = {},
): StaleToolImageResult {
  const none: StaleToolImageResult = { evicted: 0, retained: 0, freedBytes: 0 }
  if (!Array.isArray(body.input)) return none

  const slots = collectToolImageSlots(body.input)
  if (slots.length === 0) return none

  const maxKeep = positiveInt(options.maxKeep, STALE_TOOL_IMAGE_MAX_KEEP)
  const pruneBlock = positiveInt(options.pruneBlock, STALE_TOOL_IMAGE_PRUNE_BLOCK)

  // 只按数量:超出窗口就按整块淘汰;无论如何给最新的一张留位置。不看字节大小
  // (与社区做法一致:Hermes / Strix 都只数张数)。
  const overflow = slots.length - maxKeep
  let evictCount = overflow > 0 ? Math.ceil(overflow / pruneBlock) * pruneBlock : 0
  evictCount = Math.min(evictCount, slots.length - 1)

  const callArguments = evictCount > 0 ? collectCallArguments(body.input) : new Map<string, string>()
  let freedBytes = 0
  for (let i = 0; i < evictCount; i += 1) {
    const slot = slots[i]
    const source = sourceOf(slot.callId ? callArguments.get(slot.callId) : undefined)
    slot.parts[slot.index] = { type: 'input_text', text: placeholderText(source) }
    freedBytes += slot.bytes
  }
  return { evicted: evictCount, retained: slots.length - evictCount, freedBytes }
}
