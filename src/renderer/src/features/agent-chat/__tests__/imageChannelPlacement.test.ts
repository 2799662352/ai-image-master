import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_CHANNEL_ID, IMAGE_CHANNELS } from '../imageChannels'
import {
  FALLBACK_PLACEMENT,
  IMAGE_CHANNEL_PLACEMENT,
  MAX_FEATURED_TOTAL,
  MAX_RECENT_SHOWN,
  arrangeChannelMenu,
  channelTriggerBadge,
  placeImageChannels,
  resolveChannelPlacement,
  type PlacedImageChannel,
} from '../imageChannelPlacement'

const ids = (list: readonly { id: string }[]) => list.map((o) => o.id)

describe('摆放表守卫', () => {
  it('注册表里的每个渠道都显式摆放过(新接入的渠道不会悄悄落进「其他」)', () => {
    const missing = IMAGE_CHANNELS.filter((c) => !IMAGE_CHANNEL_PLACEMENT[c.id]).map((c) => c.id)
    expect(missing).toEqual([])
  })

  it('摆放表里没有过期条目(渠道下架后要同步清掉)', () => {
    const known = new Set<string>(IMAGE_CHANNELS.map((c) => c.id))
    const stale = Object.keys(IMAGE_CHANNEL_PLACEMENT).filter((id) => !known.has(id))
    expect(stale).toEqual([])
  })

  it('备用渠道都指向一个存在的常用渠道', () => {
    for (const [id, placement] of Object.entries(IMAGE_CHANNEL_PLACEMENT)) {
      if (placement.tier !== 'backup') continue
      const target = placement.backupOf ? IMAGE_CHANNEL_PLACEMENT[placement.backupOf] : undefined
      expect(target?.tier, `${id} 的 backupOf 要指向常用渠道`).toBe('featured')
    }
  })

  it('常用渠道的 order 唯一、更多渠道都有分组', () => {
    const orders = Object.values(IMAGE_CHANNEL_PLACEMENT)
      .filter((p) => p.tier === 'featured')
      .map((p) => p.order)
    expect(orders.every((o) => typeof o === 'number')).toBe(true)
    expect(new Set(orders).size).toBe(orders.length)
    for (const [id, placement] of Object.entries(IMAGE_CHANNEL_PLACEMENT)) {
      if (placement.tier === 'more') expect(placement.group, `${id} 缺分组`).toBeTruthy()
    }
  })

  it('默认渠道在常用里(默认值没变:腾讯 image2)', () => {
    expect(DEFAULT_IMAGE_CHANNEL_ID).toBe('custom-imagemodel-gt')
    expect(resolveChannelPlacement(DEFAULT_IMAGE_CHANNEL_ID).tier).toBe('featured')
  })

  it('用户点名的六个常用渠道按他给的顺序排在最前', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    expect(ids(layout.featured)).toEqual([
      'doubao-seedream-5-0-pro-260628',
      'custom-imagemodel-gt',
      'custom-model-og-v2.5-f',
      'custom-model-og-v2.5-s',
      'gemini-nano-banana-2.1',
      'wan2.7-image-pro',
    ])
  })

  it('NovelAI 四个都在「更多 · 风格化」,并带按张计费的价格量级', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    const style = layout.moreGroups.find((g) => g.label === '风格化')
    expect(style).toBeTruthy()
    const nai = style!.options.filter((o) => o.id.startsWith('nai-diffusion-'))
    expect(nai).toHaveLength(4)
    expect(nai.every((o) => o.placement.priceHint === '≈¥0.6/张')).toBe(true)
  })

  it('官转的 2.5 Flare / Sunburst 是备用渠道,跟随各自的腾讯同款排序', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    expect(ids(layout.backup)).toEqual(['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    expect(layout.backup.every((o) => o.placement.channelLabel === '官转')).toBe(true)
  })

  it('placeImageChannels 不改注册表顺序、也不污染入参', () => {
    const placed = placeImageChannels()
    expect(ids(placed)).toEqual(IMAGE_CHANNELS.map((c) => c.id))
    expect((IMAGE_CHANNELS[0] as { placement?: unknown }).placement).toBeUndefined()
  })
})

describe('arrangeChannelMenu', () => {
  const placed = placeImageChannels()

  it('摆放表之外的渠道进「更多 · 其他」,不会挤进常用', () => {
    const extra: PlacedImageChannel = {
      id: 'brand-new-channel',
      label: 'New',
      fullLabel: 'Brand New',
      description: 'x',
      miauOnly: false,
      placement: FALLBACK_PLACEMENT,
    }
    const layout = arrangeChannelMenu([...placed, extra])
    expect(layout.featured.some((o) => o.id === extra.id)).toBe(false)
    expect(layout.moreGroups.at(-1)?.label).toBe('其他')
    expect(ids(layout.moreGroups.at(-1)!.options)).toEqual([extra.id])
  })

  it('用户钉的渠道追加到常用末尾,并从备用 / 更多里拿走', () => {
    const layout = arrangeChannelMenu(placed, { pinnedIds: ['nai-diffusion-5-full', 'gpt-image-2.5-flare'] })
    expect(ids(layout.featured).slice(-2)).toEqual(['nai-diffusion-5-full', 'gpt-image-2.5-flare'])
    expect(layout.pinnedIds).toEqual(['nai-diffusion-5-full', 'gpt-image-2.5-flare'])
    expect(ids(layout.backup)).toEqual(['gpt-image-2.5-sunburst'])
    const style = layout.moreGroups.find((g) => g.label === '风格化')!
    expect(ids(style.options)).not.toContain('nai-diffusion-5-full')
  })

  it('钉的 id 在清单里不存在 / 重复 / 已是常用:忽略', () => {
    const layout = arrangeChannelMenu(placed, {
      pinnedIds: ['no-such-channel', 'custom-imagemodel-gt', 'nai-diffusion-5-full', 'nai-diffusion-5-full'],
    })
    expect(layout.pinnedIds).toEqual(['nai-diffusion-5-full'])
  })

  it('常用总数封顶 MAX_FEATURED_TOTAL,满了就不能再钉', () => {
    const many = placed.filter((o) => o.placement.tier !== 'featured').map((o) => o.id)
    const layout = arrangeChannelMenu(placed, { pinnedIds: many })
    expect(layout.featured).toHaveLength(MAX_FEATURED_TOTAL)
    expect(layout.canPinMore).toBe(false)
    expect(arrangeChannelMenu(placed).canPinMore).toBe(true)
  })

  it('最近使用:最新在前、去重、不含常用里的、最多 3 个、忽略不存在的 id', () => {
    const layout = arrangeChannelMenu(placed, {
      recentIds: ['custom-imagemodel-gt', 'ghost', 'nai-diffusion-5-full', 'qwen-image-3.0-pro', 'nai-diffusion-5-full', 'gpt-image-2', 'youchuan-v8.2'],
    })
    expect(ids(layout.recent)).toEqual(['nai-diffusion-5-full', 'qwen-image-3.0-pro', 'gpt-image-2'])
    expect(layout.recent).toHaveLength(MAX_RECENT_SHOWN)
  })

  it('更多的分组按首次出现的顺序,组内保持注册表顺序', () => {
    const layout = arrangeChannelMenu(placed)
    expect(layout.moreGroups.map((g) => g.label)).toEqual(['GPT Image 系列', 'Gemini 系列', '阿里百炼', '风格化'])
    const style = layout.moreGroups.find((g) => g.label === '风格化')!
    expect(ids(style.options)).toEqual([
      'youchuan-v8.2',
      'youchuan-v8.2-turbo',
      'nai-diffusion-5-full',
      'nai-diffusion-5-curated',
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
    ])
  })

  it('每个渠道恰好出现在一个分区里(最近使用只是副本,不算)', () => {
    const layout = arrangeChannelMenu(placed, { pinnedIds: ['nai-diffusion-5-full'] })
    const all = [...ids(layout.featured), ...ids(layout.backup), ...layout.moreGroups.flatMap((g) => ids(g.options))]
    expect(all.sort()).toEqual(ids(placed).sort())
  })
})

describe('channelTriggerBadge', () => {
  it('常用渠道不出小标签;备用渠道用线路名;更多渠道写「更多」', () => {
    const byId = (id: string) => placeImageChannels().find((c) => c.id === id)
    expect(channelTriggerBadge(byId('custom-imagemodel-gt'))).toBeNull()
    expect(channelTriggerBadge(byId('gpt-image-2.5-flare'))).toBe('官转')
    expect(channelTriggerBadge(byId('nai-diffusion-5-full'))).toBe('更多')
    expect(channelTriggerBadge(undefined)).toBeNull()
  })
})
