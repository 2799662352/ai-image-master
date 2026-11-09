import { describe, expect, it } from 'vitest'
import { DEFAULT_IMAGE_CHANNEL_ID, IMAGE_CHANNELS } from '../imageChannels'
import {
  FALLBACK_PLACEMENT,
  IMAGE_CHANNEL_PLACEMENT,
  MAX_FEATURED_TOTAL,
  MAX_RECENT_SHOWN,
  SERIES_ORDER,
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

  it('常用渠道的 order 唯一', () => {
    const orders = Object.values(IMAGE_CHANNEL_PLACEMENT)
      .filter((p) => p.tier === 'featured')
      .map((p) => p.order)
    expect(orders.every((o) => typeof o === 'number')).toBe(true)
    expect(new Set(orders).size).toBe(orders.length)
  })

  it('每个渠道都写了所属系列 —— 常用 / 备用也不例外(「按系列」要完整,用户 2026-11-09 要求)', () => {
    for (const [id, placement] of Object.entries(IMAGE_CHANNEL_PLACEMENT)) {
      expect(placement.group, `${id}(${placement.tier})缺系列`).toBeTruthy()
    }
  })

  it('系列名都登记在 SERIES_ORDER 里(新增系列要决定它在左栏的位置)', () => {
    const groups = new Set(Object.values(IMAGE_CHANNEL_PLACEMENT).map((p) => p.group))
    const unknown = [...groups].filter((g) => !SERIES_ORDER.includes(g as string))
    expect(unknown).toEqual([])
  })

  it('默认渠道在常用里(2026-11-06 起是腾讯 GPT Image 2.6 Sunburst,产品要求)', () => {
    expect(DEFAULT_IMAGE_CHANNEL_ID).toBe('custom-model-og-v2.6-s')
    expect(resolveChannelPlacement(DEFAULT_IMAGE_CHANNEL_ID).tier).toBe('featured')
    // 提示要讲明它是默认渠道;价格警示不写(用户 2026-11-06:界面里「不用提示贵」)
    const hint = resolveChannelPlacement(DEFAULT_IMAGE_CHANNEL_ID).hint ?? ''
    expect(hint).toMatch(/默认渠道/)
    expect(hint).not.toMatch(/贵/)
  })

  it('原默认渠道腾讯 image2 仍在常用里,但不再自称默认', () => {
    const placement = resolveChannelPlacement('custom-imagemodel-gt')
    expect(placement.tier).toBe('featured')
    expect(placement.hint ?? '').not.toMatch(/默认渠道/)
  })

  it('常用渠道里默认渠道排第二,其余按用户 2026-10-30 点名的顺序', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    expect(ids(layout.featured)).toEqual([
      'doubao-seedream-5-0-pro-260628',
      'custom-model-og-v2.6-s',
      'custom-imagemodel-gt',
      'custom-model-og-v2.5-f',
      'custom-model-og-v2.5-s',
      'gemini-nano-banana-2.1',
      'wan2.7-image-pro',
    ])
  })

  it('NovelAI 四个都在「按系列 · 风格化」,并带按张计费的价格量级', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    const style = layout.seriesGroups.find((g) => g.label === '风格化')
    expect(style).toBeTruthy()
    const nai = style!.options.filter((o) => o.id.startsWith('nai-diffusion-'))
    expect(nai).toHaveLength(4)
    expect(nai.every((o) => o.placement.priceHint === '≈¥0.6/张')).toBe(true)
  })

  it('腾讯 2.6:Sunburst 是默认(常用)、Flare 只在系列里,但两个都在「按系列 · GPT Image 系列」;都不写价格量级(没有确认过的口径),也不写「贵」之类的价格警示', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    const group = layout.seriesGroups.find((g) => g.label === 'GPT Image 系列')
    expect(group).toBeTruthy()
    const seriesV26 = group!.options.filter((o) => o.id.startsWith('custom-model-og-v2.6-'))
    expect(ids(seriesV26)).toEqual(['custom-model-og-v2.6-f', 'custom-model-og-v2.6-s'])
    const featuredV26 = layout.featured.filter((o) => o.id.startsWith('custom-model-og-v2.6-'))
    expect(ids(featuredV26)).toEqual(['custom-model-og-v2.6-s'])
    expect(seriesV26.every((o) => o.placement.priceHint === undefined)).toBe(true)
    expect(seriesV26.every((o) => !/贵/.test(o.placement.hint ?? '') && !/贵/.test(o.description))).toBe(true)
  })

  it('用户 2026-11-09 点名的:Nano Banana 2.1 在 Gemini 系列;腾讯 2.6 Sunburst / 2.5 / image2 与官转 2.5 都在 GPT Image 系列', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    const series = (label: string) => ids(layout.seriesGroups.find((g) => g.label === label)?.options ?? [])
    expect(series('Gemini 系列')).toEqual(['gemini-3.1-flash-image', 'gemini-nano-banana-2.1'])
    expect(series('GPT Image 系列')).toEqual(
      expect.arrayContaining([
        'custom-model-og-v2.6-s',
        'custom-model-og-v2.6-f',
        'custom-model-og-v2.5-f',
        'custom-model-og-v2.5-s',
        'custom-imagemodel-gt',
        'gpt-image-2.6-flare',
        'gpt-image-2.6-sunburst',
        'gpt-image-2.5-flare',
        'gpt-image-2.5-sunburst',
      ]),
    )
  })

  it('官转的 2.6 Sunburst / 2.5 Flare / Sunburst 是备用渠道,跟随各自的腾讯同款排序', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    // 默认渠道腾讯 2.6-s 在常用第二位,它的官转同款排在 2.5 两条之前。
    expect(ids(layout.backup)).toEqual(['gpt-image-2.6-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst'])
    expect(layout.backup.every((o) => o.placement.channelLabel === '官转')).toBe(true)
  })

  // 2.6 Flare(官转)的腾讯同款 og-v2.6-f 不在常用里,没有可指的 backupOf —— 只在「按系列」里出现,
  // 不能为了「凑齐」把它硬塞进备用(备用必须指向常用里的渠道,守卫钉着)。
  it('官转 2.6 Flare 只在 GPT Image 系列里,不在常用 / 备用', () => {
    const layout = arrangeChannelMenu(placeImageChannels())
    expect(ids(layout.featured)).not.toContain('gpt-image-2.6-flare')
    expect(ids(layout.backup)).not.toContain('gpt-image-2.6-flare')
    const gpt = layout.seriesGroups.find((g) => g.label === 'GPT Image 系列')!
    expect(ids(gpt.options)).toContain('gpt-image-2.6-flare')
    const hint = placeImageChannels().find((o) => o.id === 'gpt-image-2.6-flare')!.placement.hint ?? ''
    expect(hint).not.toMatch(/贵/)
  })

  it('placeImageChannels 不改注册表顺序、也不污染入参', () => {
    const placed = placeImageChannels()
    expect(ids(placed)).toEqual(IMAGE_CHANNELS.map((c) => c.id))
    expect((IMAGE_CHANNELS[0] as { placement?: unknown }).placement).toBeUndefined()
  })
})

describe('arrangeChannelMenu', () => {
  const placed = placeImageChannels()

  it('摆放表之外的渠道进「按系列 · 其他」,不会挤进常用', () => {
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
    expect(layout.seriesGroups.at(-1)?.label).toBe('其他')
    expect(ids(layout.seriesGroups.at(-1)!.options)).toEqual([extra.id])
  })

  it('表外的新系列排在已登记系列之后、「其他」之前', () => {
    const mk = (id: string, group?: string): PlacedImageChannel => ({
      id,
      label: id,
      fullLabel: id,
      description: 'x',
      miauOnly: false,
      placement: group ? { tier: 'more', group } : FALLBACK_PLACEMENT,
    })
    const layout = arrangeChannelMenu([mk('orphan'), mk('new-a', '某新系列'), ...placed])
    const labels = layout.seriesGroups.map((g) => g.label)
    expect(labels.slice(0, SERIES_ORDER.length)).toEqual([...SERIES_ORDER])
    expect(labels.slice(SERIES_ORDER.length)).toEqual(['某新系列', '其他'])
  })

  it('用户钉的渠道追加到常用末尾,并从备用里拿走,但仍在自己的系列里', () => {
    const layout = arrangeChannelMenu(placed, { pinnedIds: ['nai-diffusion-5-full', 'gpt-image-2.5-flare'] })
    expect(ids(layout.featured).slice(-2)).toEqual(['nai-diffusion-5-full', 'gpt-image-2.5-flare'])
    expect(layout.pinnedIds).toEqual(['nai-diffusion-5-full', 'gpt-image-2.5-flare'])
    expect(ids(layout.backup)).toEqual(['gpt-image-2.6-sunburst', 'gpt-image-2.5-sunburst'])
    const style = layout.seriesGroups.find((g) => g.label === '风格化')!
    expect(ids(style.options)).toContain('nai-diffusion-5-full')
    const gpt = layout.seriesGroups.find((g) => g.label === 'GPT Image 系列')!
    expect(ids(gpt.options)).toContain('gpt-image-2.5-flare')
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

  it('系列按 SERIES_ORDER 的固定顺序,组内保持注册表顺序', () => {
    const layout = arrangeChannelMenu(placed)
    expect(layout.seriesGroups.map((g) => g.label)).toEqual([
      'GPT Image 系列',
      'Gemini 系列',
      '火山豆包',
      '阿里百炼',
      '风格化',
    ])
    const style = layout.seriesGroups.find((g) => g.label === '风格化')!
    expect(ids(style.options)).toEqual([
      'youchuan-v8.2',
      'youchuan-v8.2-turbo',
      'nai-diffusion-5-full',
      'nai-diffusion-5-curated',
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
    ])
  })

  it('按系列恰好列出全部渠道各一次(不论常用 / 备用 / 被钉);常用、备用里的渠道都能在系列里找到', () => {
    const layout = arrangeChannelMenu(placed, { pinnedIds: ['nai-diffusion-5-full', 'gpt-image-2.5-flare'] })
    const inSeries = layout.seriesGroups.flatMap((g) => ids(g.options))
    expect([...inSeries].sort()).toEqual(ids(placed).sort())
    for (const option of [...layout.featured, ...layout.backup]) {
      const home = layout.seriesGroups.find((g) => g.label === option.placement.group)
      expect(ids(home?.options ?? []), `${option.id} 不在自己的系列里`).toContain(option.id)
    }
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
