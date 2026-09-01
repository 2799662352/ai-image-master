import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IMAGE_CHANNEL_ID,
  IMAGE_CHANNEL_IDS,
  IMAGE_CHANNELS,
  findImageChannel,
  isMiauOnlyChannel,
  isSelectableImageChannel,
  resolveImageChannel,
} from '../imageChannels'

describe('imageChannels registry', () => {
  it('defaults to 腾讯 image2', () => {
    expect(DEFAULT_IMAGE_CHANNEL_ID).toBe('custom-imagemodel-gt')
    expect(findImageChannel(DEFAULT_IMAGE_CHANNEL_ID)).toBeDefined()
  })

  it('lists channels in the requested order: SD5 → 腾讯 ×2 → Nano2 → Wan2.7 → Qwen3 → Image2 官方 → VIP', () => {
    expect(IMAGE_CHANNELS.map((c) => c.id)).toEqual([
      'doubao-seedream-5-0-pro-260628',
      'custom-imagemodel-gt',
      'custom-model-og-v2',
      'gemini-3.1-flash-image',
      'wan2.7-image-pro',
      'qwen-image-3.0-pro',
      'gpt-image-2',
      'gpt-image-2-vip',
    ])
  })

  it('marks only the gateway-proxied channels as Miau-only', () => {
    expect(isMiauOnlyChannel('custom-imagemodel-gt')).toBe(true)
    expect(isMiauOnlyChannel('wan2.7-image-pro')).toBe(true)
    expect(isMiauOnlyChannel('doubao-seedream-5-0-pro-260628')).toBe(true)
    expect(isMiauOnlyChannel('gpt-image-2-vip')).toBe(false)
    expect(isMiauOnlyChannel('gpt-image-2')).toBe(false)
    expect(isMiauOnlyChannel('gemini-3.1-flash-image')).toBe(false)
  })

  it('resolves the Seedream 5.0 Pro channel as selectable', () => {
    expect(isSelectableImageChannel('doubao-seedream-5-0-pro-260628')).toBe(true)
    expect(resolveImageChannel('doubao-seedream-5-0-pro-260628')).toBe('doubao-seedream-5-0-pro-260628')
  })

  it('validates selectable ids', () => {
    expect(isSelectableImageChannel('gpt-image-2-vip')).toBe(true)
    expect(isSelectableImageChannel('nope')).toBe(false)
    expect(isSelectableImageChannel(undefined)).toBe(false)
    expect(isSelectableImageChannel(42)).toBe(false)
  })

  it('resolves valid ids as-is and falls back to the default otherwise', () => {
    expect(resolveImageChannel('wan2.7-image-pro')).toBe('wan2.7-image-pro')
    expect(resolveImageChannel('made-up')).toBe(DEFAULT_IMAGE_CHANNEL_ID)
    expect(resolveImageChannel(null)).toBe(DEFAULT_IMAGE_CHANNEL_ID)
  })

  it('gives every channel a non-empty label / fullLabel / description', () => {
    for (const c of IMAGE_CHANNELS) {
      expect(c.label.length).toBeGreaterThan(0)
      expect(c.fullLabel.length).toBeGreaterThan(0)
      expect(c.description.length).toBeGreaterThan(0)
    }
  })

  /**
   * MCP 的模型枚举必须是**推导**出来的,不能再手抄一份。
   *
   * 出图有三条路,以前各有一份清单:`ApiService.DEFAULT_MODELS`(生成页)、
   * 本模块的 `IMAGE_CHANNELS`(聊天选择器)、`imageTools.ts` 的 `modelSchema`
   * (MCP)。加渠道只改一两处的后果是「新模型在有的地方看不见」,而且**不报错**
   * —— 2026-09-01 接 og-image 时就这么漏过。
   *
   * 现在 MCP 从 `shared/imageChannels` 推导。这条守卫钉住它**保持**推导:
   * 有人把 `z.enum(IMAGE_CHANNEL_IDS)` 改回字面量数组的话立刻红。
   *
   * 读源码文本而不是 import:`imageTools.ts` 顶层拉 electron / MCP SDK,
   * 在 vitest 里 import 不动(同 `platformSpendCoverage` 那条守卫的理由)。
   */
  it('MCP 的模型枚举从共享清单推导,不是手抄的字面量', () => {
    const mcpSource = readFileSync(
      resolve(process.cwd(), 'src/main/mcp/tools/imageTools.ts'),
      'utf8',
    )
    // 只断言 `modelSchema` 这一处。文件里别的 `z.enum([...])`(比例、分辨率、
    // 清晰度)用字面量是对的 —— 它们不跟随渠道清单变化。
    expect(mcpSource).toMatch(/const modelSchema = z\s*\.enum\(IMAGE_CHANNEL_IDS\)/)
    expect(mcpSource).toContain("from '../../../shared/imageChannels'")
  })

  /** 推导出来的 id 列表必须与渠道数组逐项一致,顺序也一样。 */
  it('IMAGE_CHANNEL_IDS 与渠道数组同步', () => {
    expect(IMAGE_CHANNEL_IDS).toEqual(IMAGE_CHANNELS.map((c) => c.id))
    expect(IMAGE_CHANNEL_IDS.length).toBeGreaterThan(0)
  })

  // 「字面量不被拓宽」那条不在这里守 —— 它是**编译期**断言,住在
  // `shared/imageChannels.ts` 里(`AssertLiteralChannelIds`)。类型退化任何一次
  // `tsc` 都该拦下,而不是等某个测试文件跑到才发现;在这里再写一条正则匹配源码
  // 只会变成同一件事的第二个说法,而两个说法迟早会不一致。

  /**
   * 每个渠道 id 必须在 `ApiService` 的模型表里真实存在。
   *
   * 渠道清单管「给谁看」,`DEFAULT_MODELS` 管「怎么发请求」(端点、尺寸表、
   * 能力位)。两份按 id 对应,但没有任何编译期联系 —— 在这边加一行、忘了在那边
   * 加配置的话,用户在选择器里选得到,点下去却拿不到端点。
   *
   * 反过来不成立:`DEFAULT_MODELS` 里的模型多得多(经典生成页全都提供),
   * 聊天渠道是精选子集,所以只单向检查。
   */
  it('每个渠道在 ApiService 的模型表里都有配置', async () => {
    const { ApiService } = await import('../../../services/api/ApiService')
    const models = new ApiService().getAllModels()
    for (const channel of IMAGE_CHANNELS) {
      expect(
        models[channel.id],
        `渠道「${channel.fullLabel}」(${channel.id}) 在 ApiService.DEFAULT_MODELS 里没有配置 —— 用户选得到但发不出去`,
      ).toBeDefined()
    }
  })

  /**
   * agent 的技能文档必须提到每个渠道。
   *
   * `SKILL.md` 是 agent 判断「用户说什么就选哪个渠道」的依据。渠道不在里面 =
   * **agent 根本不知道它存在**,用户说「用便宜那个」也点不到 —— 而工具调用本身
   * 不会报错,只是用了别的渠道,谁也看不出漏了什么。
   *
   * 2026-09-01 接 og-image 时就这么漏了;而且那份文档当时已经陈旧一轮
   * (千问 Image 3.0 Pro 加进选择器时也没登记进去,还留着一句「只有六个合法值」)。
   * 两次都没人发现,正因为没有任何东西会因此变红。
   */
  it('agent 的技能文档提到了每个渠道', () => {
    const skill = readFileSync(
      resolve(
        process.cwd(),
        'resources/plugins/catimation-core/skills/catimation-image/SKILL.md',
      ),
      'utf8',
    )
    for (const channel of IMAGE_CHANNELS) {
      expect(skill, `渠道「${channel.fullLabel}」(${channel.id}) 没写进 SKILL.md —— agent 不知道它存在`)
        .toContain(channel.id)
    }
  })

  /** miauOnly 必须与模型配置里的站点绑定一致,否则请求会被送到错误的站点。 */
  it('miauOnly 与模型配置里的站点绑定一致', async () => {
    const { ApiService } = await import('../../../services/api/ApiService')
    const models = new ApiService().getAllModels()
    for (const channel of IMAGE_CHANNELS) {
      const pinned = models[channel.id]?.requiredSiteKey !== undefined
      expect(
        pinned,
        `渠道「${channel.fullLabel}」标了 miauOnly=${channel.miauOnly},但模型配置里 requiredSiteKey ${pinned ? '存在' : '不存在'} —— 两者必须一致`,
      ).toBe(channel.miauOnly)
    }
  })
})
