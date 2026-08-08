import { describe, expect, it } from 'vitest'

import { ApiService } from '../ApiService'

/**
 * 千问 Image 3.0 Pro 的参考图必须走 DashScope 原生 `input.messages`。
 *
 * 这条测试的由来（2026-08-08 实测）：初次接入时沿用了 Seedream 的形状，结果参考图
 * 被发成顶层 `image` 字段 —— 而网关的字段映射表里根本没有 `image`（接入说明 §3.2），
 * 它被静默丢弃，表现为「传了参考图但模型完全没看」，**不报任何错**。
 *
 * 根因是「构造 input.messages」此前挂在 `sequentialGroup`（万相的组图能力）上，
 * 而千问有参考图却没有组图。两件事已解耦到 `dashscopeNativeInput`。
 */
describe('qwen-image-3.0-pro 请求体', () => {
  const service = new ApiService()
  const cfg = service.getAllModels()['qwen-image-3.0-pro']

  const build = (referenceImages?: string[], extra: Record<string, unknown> = {}) =>
    (service as unknown as {
      buildRequestBody: (o: Record<string, unknown>) => Record<string, unknown>
    }).buildRequestBody({
      prompt: '和参考图一模一样',
      model: 'qwen-image-3.0-pro',
      ratio: '1:1',
      resolution: '2K',
      referenceImages,
      count: 1,
      modelConfig: cfg,
      ...extra,
    })

  it('带参考图时用 input.messages，且 image 在 text 之前', () => {
    const body = build(['https://example.com/ref.png'])
    expect(body.input).toEqual({
      messages: [{
        role: 'user',
        content: [
          { image: 'https://example.com/ref.png' },
          { text: '和参考图一模一样' },
        ],
      }],
    })
  })

  it('绝不把参考图放进顶层 image —— 那个字段会被网关丢弃', () => {
    const body = build(['https://example.com/ref.png'])
    expect(body.image).toBeUndefined()
    expect(body.images).toBeUndefined()
  })

  it('无参考图时 messages 只有 text', () => {
    const body = build()
    expect(body.input).toEqual({
      messages: [{ role: 'user', content: [{ text: '和参考图一模一样' }] }],
    })
  })

  it('parameters 用星号尺寸，prompt_extend 跟随官方默认开启', () => {
    const parameters = build().parameters as Record<string, unknown>
    // 官方文档「建议开启…对描述较简单的提示词效果提升明显」。代价是上游可能改写
    // 分辨率，取舍见 DEFAULT_MODELS 里的注释。
    expect(parameters.prompt_extend).toBe(true)
    expect(String(parameters.size)).toMatch(/^\d+\*\d+$/)
    expect(parameters.n).toBe(1)
  })

  it('参考图截断到官方上限 3 张，而不是让整次请求被上游拒', () => {
    const body = build([
      'https://e.com/1.png',
      'https://e.com/2.png',
      'https://e.com/3.png',
      'https://e.com/4.png',
    ])
    const content = (body.input as { messages: Array<{ content: Array<Record<string, string>> }> })
      .messages[0].content
    const images = content.filter((part) => 'image' in part)
    expect(images).toHaveLength(3)
    expect(images.map((p) => p.image)).toEqual([
      'https://e.com/1.png',
      'https://e.com/2.png',
      'https://e.com/3.png',
    ])
  })

  it('不发万相专属的 thinking_mode / enable_sequential', () => {
    const parameters = build().parameters as Record<string, unknown>
    expect(parameters.thinking_mode).toBeUndefined()
    expect(parameters.enable_sequential).toBeUndefined()
  })

  /**
   * 官方只用两条规则约束尺寸：面积 512² ~ 2048²、宽高比 1:8 ~ 8:1。这里**按规则算**
   * 而不是逐档硬写期望值 —— 以后调尺寸表也会自动被守住，不用同步改测试。
   */
  it('每一档尺寸都满足官方的面积与宽高比约束', () => {
    const MIN_AREA = 512 * 512
    const MAX_AREA = 2048 * 2048
    const map = cfg.resolutionMap as Record<string, Record<string, string>>
    const seen: string[] = []

    for (const [ratio, byTier] of Object.entries(map)) {
      for (const [tier, size] of Object.entries(byTier)) {
        const [w, h] = size.split('x').map(Number)
        const label = `${ratio} ${tier} = ${size}`
        seen.push(label)
        expect(Number.isFinite(w) && Number.isFinite(h), label).toBe(true)
        expect(w * h, `${label} 面积越界`).toBeGreaterThanOrEqual(MIN_AREA)
        expect(w * h, `${label} 面积越界`).toBeLessThanOrEqual(MAX_AREA)
        const aspect = w / h
        expect(aspect, `${label} 宽高比越界`).toBeGreaterThanOrEqual(1 / 8)
        expect(aspect, `${label} 宽高比越界`).toBeLessThanOrEqual(8)
      }
    }
    // 别让这条测试在表被清空时假绿。
    expect(seen.length).toBeGreaterThanOrEqual(20)
  })

  it('count 直达 parameters.n，超过官方上限 6 时截断而不是报错', () => {
    expect((build(undefined, { count: 4 }).parameters as Record<string, unknown>).n).toBe(4)
    // 官方 n 上限 6；调用方（MCP schema 允许到 12）传多了就地收敛，不该把整次请求打掉。
    expect((build(undefined, { count: 12 }).parameters as Record<string, unknown>).n).toBe(6)
    expect((build().parameters as Record<string, unknown>).n).toBe(1)
  })

  it('不是万相，多张不该带 enable_sequential —— 千问的 n>1 是独立变体不是组图', () => {
    const p = build(undefined, { count: 5 }).parameters as Record<string, unknown>
    expect('enable_sequential' in p).toBe(false)
    expect('thinking_mode' in p).toBe(false)
  })

  it('seed 与 negative_prompt 会进 parameters，缺省时不出现', () => {
    const withBoth = build(undefined, { seed: 12345, negativePrompt: '模糊, 多手指' })
      .parameters as Record<string, unknown>
    expect(withBoth.seed).toBe(12345)
    expect(withBoth.negative_prompt).toBe('模糊, 多手指')

    const bare = build().parameters as Record<string, unknown>
    expect('seed' in bare).toBe(false)
    expect('negative_prompt' in bare).toBe(false)
  })

  it('seed 收敛到官方区间上限，空白反向词不发', () => {
    const p = build(undefined, { seed: 99999999999, negativePrompt: '   ' })
      .parameters as Record<string, unknown>
    expect(p.seed).toBe(2147483647)
    expect('negative_prompt' in p).toBe(false)
  })

  it('提供 21:9 等宽幅比例 —— 官方规则允许，早先漏配了', () => {
    expect((cfg.ratios ?? []).map((r) => r.key)).toEqual(
      expect.arrayContaining(['21:9', '5:4', '4:5']),
    )
  })
})
