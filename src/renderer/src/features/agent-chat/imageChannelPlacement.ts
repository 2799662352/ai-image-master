/**
 * 出图渠道选择器的「摆放表」+ 分层排布 —— Codex 页输入框下面那个两栏面板的数据层。
 *
 * 与 sora-ui 网页版的 ModelPanel 同一套结构(最近使用 / 常用 / 备用渠道 / 更多模型·按系列),
 * 但**摆放表是桌面端自己的**:网页版的表挂在后端清单上,桌面端的渠道清单是
 * `shared/imageChannels` 里写死的精选子集,所以摆放也写在这边。
 *
 * - 摆放只管「放哪一层」,不影响可用性、不改 `IMAGE_CHANNELS` 的顺序(MCP 枚举、默认渠道回落都不看这里);
 * - 清单里有、摆放表里没有的渠道一律进「更多 · 其他」—— 新接入的渠道不会自己挤进常用
 *   (`imageChannelPlacement.test.ts` 里有条守卫:每个渠道都必须显式摆放,漏了会红);
 * - 纯函数、无 React / 存储依赖,方便单测。
 */
import { IMAGE_CHANNELS, type ImageChannel } from './imageChannels'

export type ChannelTier = 'featured' | 'backup' | 'more'

export interface ChannelPlacement {
  tier: ChannelTier
  /** 常用里的固定顺序(升序)。 */
  order?: number
  /** 备用渠道:它是哪个常用渠道的同款(渠道 id)。 */
  backupOf?: string
  /** 线路短名,备用渠道行上显示成小标签(如「官转」)。 */
  channelLabel?: string
  /** 「更多」里的分组名(系列)。 */
  group?: string
  /** 一句话用途,显示在名称下面。 */
  hint?: string
  /** 价格量级。只给确认过口径的渠道填;别的不显示,不拿别家的均价凑数。 */
  priceHint?: string
}

const featured = (order: number, hint: string): ChannelPlacement => ({ tier: 'featured', order, hint })

const backup = (backupOf: string, channelLabel: string, hint: string): ChannelPlacement => ({
  tier: 'backup',
  backupOf,
  channelLabel,
  hint,
})

const more = (group: string, hint: string, priceHint?: string): ChannelPlacement => ({
  tier: 'more',
  group,
  hint,
  ...(priceHint ? { priceHint } : {}),
})

/** NovelAI 按张计费,约 ¥0.6–0.65(1K / 2K 同价),取下沿作量级。 */
const NOVELAI_PRICE_HINT = '≈¥0.6/张'

/**
 * 常用 = 用户 2026-10-30 点名的六个(顺序也照他的);备用渠道 = 常用里腾讯 2.5 两条的官转同款;
 * 其余按系列归到「更多」,NovelAI 与悠船一起放「风格化」。
 */
export const IMAGE_CHANNEL_PLACEMENT: Readonly<Record<string, ChannelPlacement>> = {
  'doubao-seedream-5-0-pro-260628': featured(1, '火山豆包，多图融合，最多 10 张参考图'),
  'custom-imagemodel-gt': featured(2, '未手动选择时的默认渠道，约 30 秒，稳定'),
  'custom-model-og-v2.5-f': featured(3, '速度优先，文生图主力，一次 1–4 张'),
  'custom-model-og-v2.5-s': featured(4, '画质 / 改图精度优先，一次 1–4 张'),
  'gemini-nano-banana-2.1': featured(5, '图中文字、多轮改图一致性更好'),
  'wan2.7-image-pro': featured(6, '阿里万相，超清 / 组图'),

  'gpt-image-2.5-flare': backup('custom-model-og-v2.5-f', '官转', 'OpenAI 官转同款，按 token 计费，可出透明底'),
  'gpt-image-2.5-sunburst': backup('custom-model-og-v2.5-s', '官转', 'OpenAI 官转同款，更锐、改图更稳，可出透明底'),

  'custom-model-og-v2': more('GPT Image 系列', '约 20 秒，比 image2 便宜近 6 倍，可出多张'),
  'gpt-image-2.5-all': more('GPT Image 系列', 'ChatGPT 网页逆向，约 60 秒，尺寸写进提示词'),
  'gpt-image-2': more('GPT Image 系列', '上一代官转，已被 2.5 同价取代'),
  'gpt-image-2-vip': more('GPT Image 系列', '官逆稳定，仅点名 VIP 时用'),
  'gemini-3.1-flash-image': more('Gemini 系列', 'Nano Banana 2，快，多比例 4K'),
  'qwen-image-3.0-pro': more('阿里百炼', '通义千问同步出图，一次 1–6 张，参考图最多 3 张'),
  'youchuan-v8.2': more('风格化', '悠船 Midjourney V8.2 快速，一次 4 张，支持参考图'),
  'youchuan-v8.2-turbo': more('风格化', '悠船 Midjourney V8.2 极速，出图更快，价格更高'),
  'nai-diffusion-5-full': more('风格化', 'NovelAI 动漫插画，角色提示词 ≤22 个，可透明底', NOVELAI_PRICE_HINT),
  'nai-diffusion-5-curated': more('风格化', 'NovelAI V5 精选数据集，能力同 Full', NOVELAI_PRICE_HINT),
  'nai-diffusion-4-5-full': more('风格化', 'NovelAI V4.5 动漫插画，角色提示词 ≤6 个，无透明底', NOVELAI_PRICE_HINT),
  'nai-diffusion-4-5-curated': more('风格化', 'NovelAI V4.5 精选数据集，能力同 Full', NOVELAI_PRICE_HINT),
}

/** 摆放表里没有的渠道落到这里。 */
export const FALLBACK_PLACEMENT: Readonly<ChannelPlacement> = Object.freeze({ tier: 'more', group: '其他' })

export interface PlacedImageChannel extends ImageChannel {
  placement: ChannelPlacement
}

export function resolveChannelPlacement(id: string): ChannelPlacement {
  return IMAGE_CHANNEL_PLACEMENT[id] ?? FALLBACK_PLACEMENT
}

/** 给每个渠道挂上 placement,顺序保持不变。返回新数组,不改入参。 */
export function placeImageChannels(channels: readonly ImageChannel[] = IMAGE_CHANNELS): PlacedImageChannel[] {
  return channels.map((channel) => ({ ...channel, placement: resolveChannelPlacement(channel.id) }))
}

// ─── 分层排布 ─────────────────────────────────────────────────────────

export const MAX_RECENT_SHOWN = 3
/** 常用区(团队常用 + 用户钉的)总数上限:再多就失去「一眼扫完」的意义。 */
export const MAX_FEATURED_TOTAL = 10
const FALLBACK_GROUP = '其他'

export interface ChannelMenuGroup {
  key: string
  label: string
  options: PlacedImageChannel[]
}

export interface ChannelMenuLayout {
  recent: PlacedImageChannel[]
  featured: PlacedImageChannel[]
  /** featured 里属于「用户自己钉的」那部分 id(可取消钉)。 */
  pinnedIds: string[]
  backup: PlacedImageChannel[]
  moreGroups: ChannelMenuGroup[]
  /** 常用区还没满,还能再钉。 */
  canPinMore: boolean
}

export interface ArrangeChannelMenuInput {
  pinnedIds?: readonly string[]
  recentIds?: readonly string[]
  maxRecent?: number
}

const orderOf = (placement: ChannelPlacement | undefined): number => placement?.order ?? Number.POSITIVE_INFINITY

/**
 * 排成「最近使用 / 常用 / 备用渠道 / 更多(按系列)」。
 *
 *   - 常用 = 摆放表里的常用(按 order)+ 用户自己钉上来的(按钉的先后),总数 ≤ MAX_FEATURED_TOTAL;
 *   - 备用渠道跟随各自对应的常用渠道排序;被钉到常用的不再重复出现在备用 / 更多;
 *   - 最近使用:最新在前、去重、不含已在常用里的、最多 MAX_RECENT_SHOWN 个;
 *   - 钉过 / 用过、但当前清单里已不存在的 id 直接忽略,不报错(渠道下架后本地存的 id 会过期)。
 */
export function arrangeChannelMenu(
  options: readonly PlacedImageChannel[],
  input: ArrangeChannelMenuInput = {},
): ChannelMenuLayout {
  const { pinnedIds = [], recentIds = [], maxRecent = MAX_RECENT_SHOWN } = input

  const byId = new Map<string, { option: PlacedImageChannel; index: number }>()
  options.forEach((option, index) => {
    if (!byId.has(option.id)) byId.set(option.id, { option, index })
  })
  const indexOf = (option: PlacedImageChannel) => byId.get(option.id)?.index ?? 0

  const teamFeatured: PlacedImageChannel[] = []
  const backupAll: PlacedImageChannel[] = []
  const moreAll: PlacedImageChannel[] = []
  for (const { option } of byId.values()) {
    const tier = option.placement.tier
    if (tier === 'featured') teamFeatured.push(option)
    else if (tier === 'backup') backupAll.push(option)
    else moreAll.push(option)
  }
  teamFeatured.sort((a, b) => orderOf(a.placement) - orderOf(b.placement) || indexOf(a) - indexOf(b))

  const teamFeaturedIds = new Set(teamFeatured.map((option) => option.id))
  const pinned: PlacedImageChannel[] = []
  for (const id of pinnedIds) {
    if (teamFeaturedIds.has(id) || pinned.some((option) => option.id === id)) continue
    const entry = byId.get(id)
    if (!entry) continue
    if (teamFeatured.length + pinned.length >= MAX_FEATURED_TOTAL) break
    pinned.push(entry.option)
  }
  const pinnedSet = new Set(pinned.map((option) => option.id))
  const featuredList = [...teamFeatured, ...pinned]

  const featuredOrderById = new Map(teamFeatured.map((option) => [option.id, orderOf(option.placement)]))
  const backupOrder = (option: PlacedImageChannel) =>
    featuredOrderById.get(option.placement.backupOf ?? '') ?? Number.POSITIVE_INFINITY
  const backupList = backupAll
    .filter((option) => !pinnedSet.has(option.id))
    .sort((a, b) => backupOrder(a) - backupOrder(b) || indexOf(a) - indexOf(b))

  const groups = new Map<string, PlacedImageChannel[]>()
  for (const option of moreAll.sort((a, b) => indexOf(a) - indexOf(b))) {
    if (pinnedSet.has(option.id)) continue
    const label = option.placement.group ?? FALLBACK_GROUP
    const bucket = groups.get(label)
    if (bucket) bucket.push(option)
    else groups.set(label, [option])
  }
  const moreGroups: ChannelMenuGroup[] = [...groups.entries()].map(([label, bucket]) => ({
    key: label,
    label,
    options: bucket,
  }))

  const featuredIds = new Set(featuredList.map((option) => option.id))
  const recent: PlacedImageChannel[] = []
  for (const id of recentIds) {
    if (recent.length >= maxRecent) break
    const entry = byId.get(id)
    if (!entry || featuredIds.has(id) || recent.some((option) => option.id === id)) continue
    recent.push(entry.option)
  }

  return {
    recent,
    featured: featuredList,
    pinnedIds: pinned.map((option) => option.id),
    backup: backupList,
    moreGroups,
    canPinMore: featuredList.length < MAX_FEATURED_TOTAL,
  }
}

/**
 * 触发按钮上的小标签:选中了「备用渠道 / 更多」里的渠道时提示一下,避免误触后不自知。
 * 常用渠道返回 null。
 */
export function channelTriggerBadge(channel: Pick<PlacedImageChannel, 'placement'> | undefined): string | null {
  const placement = channel?.placement
  if (!placement || placement.tier === 'featured') return null
  return placement.channelLabel ?? '更多'
}
