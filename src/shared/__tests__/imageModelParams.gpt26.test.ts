import { describe, expect, it } from 'vitest'
import {
  GIF_FRAME_LONG_EDGE,
  GIF_MAX_FRAME_COUNT,
  GIF_SHEET_MAX_PIXELS,
  gifSafeSize,
  gifSvgFamilyOf,
  GPT_IMAGE_26_DEFAULT_SVG_MODEL,
  GPT_IMAGE_26_MODEL_IDS,
  GPT_IMAGE_26_PARAM_SPECS,
  gifSvgUnsupportedReason,
  isGptImage26Model,
  isTencentImage26Model,
  resolveGifSvgFields,
  resolveGptImage26Fields,
  resolveModelParams,
  TENCENT_IMAGE_26_DEFAULT_SVG_EFFORT,
  TENCENT_IMAGE_26_MODEL_IDS,
  TENCENT_IMAGE_26_PARAM_SPECS,
  TENCENT_IMAGE_26_SVG_MODEL,
  type ModelParamSpec,
} from '../imageModelParams'

/**
 * apiyi 官转 GPT Image 2.6 的 GIF / SVG 输出参数。
 *
 * 依据:apiyi 文档 `gpt-image-2-6`(output_format ∈ png|jpeg|webp|svg|gif;GIF 帧数 2–64、
 * 每帧时长 20–2000 ms;SVG 必须带嵌套 `svg.model`)+ 2026-11-09 经 Miau 网关实测
 * (GIF 真 2 帧 / 100 ms;SVG 返回合法矢量)。
 *
 * 外发形状是**嵌套**的:`svg: { model }`,而参数表的键是平铺的 `svg_model` —— 翻译只在
 * `resolveGptImage26Fields` 一处做,界面 / MCP / ApiService 共用。
 */

const specOf = (key: string): ModelParamSpec => GPT_IMAGE_26_PARAM_SPECS.find((s) => s.key === key)!

describe('GPT Image 2.6 模型识别', () => {
  it('只认 apiyi 官转两条,腾讯 2.6 / 2.5 官转都不是', () => {
    expect([...GPT_IMAGE_26_MODEL_IDS]).toEqual(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])
    for (const id of GPT_IMAGE_26_MODEL_IDS) expect(isGptImage26Model(id)).toBe(true)
    for (const id of ['custom-model-og-v2.6-f', 'custom-model-og-v2.6-s', 'gpt-image-2.5-flare', 'gpt-image-2', undefined, '']) {
      expect(isGptImage26Model(id)).toBe(false)
    }
  })
})

describe('GPT Image 2.6 参数表', () => {
  it('键 = 输出格式 / 帧数 / 每帧时长 / SVG 写手模型,而且一个都没有默认值(不设置 = 不外发)', () => {
    expect(GPT_IMAGE_26_PARAM_SPECS.map((s) => s.key)).toEqual([
      'output_format',
      'frame_count',
      'frame_duration_ms',
      'svg_model',
    ])
    for (const spec of GPT_IMAGE_26_PARAM_SPECS) expect(spec.defaultValue, spec.key).toBeUndefined()
  })

  it('输出格式只给 png / gif / svg(jpeg / webp 不是这次要开的能力)', () => {
    expect(specOf('output_format').type).toBe('select')
    expect(specOf('output_format').options?.map((o) => o.key)).toEqual(['png', 'gif', 'svg'])
  })

  it('帧数 2–16 整数(上游实测:超过 16 报 400 或静默丢弃整个 GIF 配置)、每帧时长 20–2000 整数', () => {
    expect(GIF_MAX_FRAME_COUNT).toBe(16)
    expect(specOf('frame_count')).toMatchObject({ type: 'number', integer: true, min: 2, max: 16 })
    expect(specOf('frame_duration_ms')).toMatchObject({ type: 'number', integer: true, min: 20, max: 2000, step: 10 })
  })

  it('SVG 写手模型:默认项排第一,三个都是文档点名测过的', () => {
    const keys = specOf('svg_model').options?.map((o) => o.key)
    expect(keys).toEqual(['gpt-4.1-mini', 'gpt-5.6-terra', 'gpt-6-luna'])
    expect(GPT_IMAGE_26_DEFAULT_SVG_MODEL).toBe('gpt-4.1-mini')
  })

  it('越界值被拒绝而不是纠正', () => {
    const bad = resolveModelParams(GPT_IMAGE_26_PARAM_SPECS, { frame_count: 1, frame_duration_ms: 5000, output_format: 'jpeg' })
    expect(bad.errors).toHaveLength(3)
    const ok = resolveModelParams(GPT_IMAGE_26_PARAM_SPECS, { frame_count: '9', frame_duration_ms: 200, output_format: 'gif' })
    expect(ok.errors).toEqual([])
    expect(ok.values).toEqual({ frame_count: 9, frame_duration_ms: 200, output_format: 'gif' })
  })
})

/**
 * GIF 尺寸:上游先把所有帧拼成一张 sprite sheet 再编码(2026-11-09 实测),约束是**整张拼图**
 * ≤ 3840×2160 像素、最长边 ≤ 3840 —— 而 App 的 1K / 2K / 4K 档(1280² 起)是按「每一帧」给的,
 * 全部超限:2 帧 1280² → 400「No supported sheet fits 2 GIF frames…」。
 * 实测放行 / 拒绝(方图,每帧边长):2 帧 960 ✓ / 1024 ✗ / 1280 ✗;4 帧 768 ✓ / 1024 ✗;
 * 9 帧 960 ✓(3×3 = 2880² 恰好等于预算)/ 1024 ✗ / 1280 ✗;16 帧 640 ✓ / 512 ✓;非方图 2 帧 1344×768 ✓。
 */
describe('gifSafeSize:把「每帧尺寸」收进上游的拼图预算', () => {
  const sheetPixels = (size: string, frames: number): number => {
    const [w, h] = size.split('x').map(Number) as [number, number]
    const cells = frames <= 8 ? 8 : frames === 9 ? 9 : 16
    return w * h * cells
  }

  it('App 的 1K / 2K / 4K 方图档(1280² / 2048² / 2880²)按帧数收成实测放行的尺寸', () => {
    for (const tier of ['1280x1280', '2048x2048', '2880x2880']) {
      expect(gifSafeSize(tier, 2), tier).toBe('960x960')
      expect(gifSafeSize(tier, 4), tier).toBe('960x960')
      expect(gifSafeSize(tier, 9), tier).toBe('960x960')
      expect(gifSafeSize(tier, 16), tier).toBe('720x720')
    }
  })

  it('不填帧数 = 上游默认 9 帧', () => {
    expect(gifSafeSize('1280x1280', undefined)).toBe('960x960')
  })

  it('比例保持、16 的倍数、最长边 ≤ 960;非方图按像素预算再收', () => {
    expect(gifSafeSize('2048x1152', 9)).toBe('960x528')
    expect(gifSafeSize('1152x2048', 9)).toBe('528x960')
    for (const size of ['2048x1152', '1152x2048', '1536x1024', '1024x1536', '2688x1152', '1280x1280']) {
      for (const frames of [2, 3, 4, 8, 9, 10, 12, 16]) {
        const out = gifSafeSize(size, frames)
        const [w, h] = out.split('x').map(Number) as [number, number]
        expect(w % 16, `${size} ${frames} → ${out}`).toBe(0)
        expect(h % 16, `${size} ${frames} → ${out}`).toBe(0)
        expect(Math.max(w, h), `${size} ${frames} → ${out}`).toBeLessThanOrEqual(960)
        expect(sheetPixels(out, frames), `${size} ${frames} → ${out}`).toBeLessThanOrEqual(GIF_SHEET_MAX_PIXELS)
        // 比例偏差不超过一个 16 像素的取整格
        const [w0, h0] = size.split('x').map(Number) as [number, number]
        expect(Math.abs(w / h - w0 / h0) / (w0 / h0), `${size} ${frames} → ${out}`).toBeLessThan(0.05)
      }
    }
  })

  it('本来就小的尺寸不放大', () => {
    expect(gifSafeSize('512x512', 2)).toBe('512x512')
    expect(gifSafeSize('640x360', 9)).toBe('640x352')
  })

  it('没有尺寸(比例 auto)/ 认不出的尺寸 → 方图,同样收进预算', () => {
    expect(gifSafeSize(undefined, 2)).toBe('960x960')
    expect(gifSafeSize('auto', 16)).toBe('720x720')
    expect(gifSafeSize('', 9)).toBe('960x960')
  })
})

describe('gifSvgUnsupportedReason:agent 要了动图 / 矢量却落在不支持的模型上', () => {
  it('别的模型 + GIF / SVG / 只有 GIF·SVG 专属参数 → 中文原因,里面带全部四个可用的模型 id', () => {
    for (const model of ['gpt-image-2.5-flare', 'custom-model-og-v2.5-s', 'custom-model-og-v2', 'gpt-image-2', undefined]) {
      for (const params of [
        { output_format: 'gif' },
        { output_format: 'svg' },
        { frame_count: 4 },
        { frame_duration_ms: 100 },
        { svg_model: 'gpt-6-luna' },
        { svg_effort: 'low' },
      ]) {
        const reason = gifSvgUnsupportedReason(model, params)
        expect(reason, `${model} ${JSON.stringify(params)}`).toMatch(/gpt-image-2\.6-flare/)
        expect(reason).toMatch(/gpt-image-2\.6-sunburst/)
        expect(reason).toMatch(/custom-model-og-v2\.6-f/)
        expect(reason).toMatch(/custom-model-og-v2\.6-s/)
      }
    }
  })

  it('2.6 官转两条、腾讯 2.6 两条都放行(参数是否合法另有校验)', () => {
    for (const model of [...GPT_IMAGE_26_MODEL_IDS, ...TENCENT_IMAGE_26_MODEL_IDS]) {
      expect(gifSvgUnsupportedReason(model, { output_format: 'gif' })).toBeNull()
      expect(gifSvgUnsupportedReason(model, { output_format: 'svg' })).toBeNull()
    }
  })

  // 写手选项两家不一样:apiyi 选写手模型(svg_model),腾讯选推理强度(svg_effort)。
  // 串了键,ApiService 会照「只发当前模型声明过的键」悄悄丢掉 —— agent 以为选了,其实没生效。
  it('apiyi 上给 svg_effort / 腾讯上给 svg_model → 拒绝并指向正确的键', () => {
    for (const model of TENCENT_IMAGE_26_MODEL_IDS) {
      const reason = gifSvgUnsupportedReason(model, { output_format: 'svg', svg_model: 'gpt-6-luna' })
      expect(reason, model).toMatch(/svg_effort/)
    }
    for (const model of GPT_IMAGE_26_MODEL_IDS) {
      const reason = gifSvgUnsupportedReason(model, { output_format: 'svg', svg_effort: 'none' })
      expect(reason, model).toMatch(/svg_model/)
    }
    // 各用各的键 = 放行
    expect(gifSvgUnsupportedReason('custom-model-og-v2.6-s', { output_format: 'svg', svg_effort: 'none' })).toBeNull()
    expect(gifSvgUnsupportedReason('gpt-image-2.6-flare', { output_format: 'svg', svg_model: 'gpt-6-luna' })).toBeNull()
  })

  it('没要 GIF / SVG 一律放行:没设 / png / 空值 / 别的参数 / 非对象', () => {
    for (const params of [undefined, null, 'x', {}, { output_format: 'png' }, { output_format: '' }, { frame_count: '' }, { hd: true, chaos: 20 }]) {
      expect(gifSvgUnsupportedReason('gpt-image-2.5-flare', params), JSON.stringify(params)).toBeNull()
    }
  })
})

describe('resolveGptImage26Fields:平铺参数 → 外发字段', () => {
  it('什么都没设 = 普通 PNG,不外发任何额外字段', () => {
    expect(resolveGptImage26Fields({})).toEqual({ fields: {} })
    expect(resolveGptImage26Fields({ output_format: 'png' })).toEqual({ fields: {} })
  })

  it('GIF:output_format + 用户给的帧参数,没给的不发(上游默认 9 帧 / 200 ms)', () => {
    expect(resolveGptImage26Fields({ output_format: 'gif' })).toEqual({ fields: { output_format: 'gif' } })
    expect(resolveGptImage26Fields({ output_format: 'gif', frame_count: 4, frame_duration_ms: 120 })).toEqual({
      fields: { output_format: 'gif', frame_count: 4, frame_duration_ms: 120 },
    })
  })

  it('SVG:翻成嵌套的 svg.model,没选写手模型时用默认项(上游要求必带)', () => {
    expect(resolveGptImage26Fields({ output_format: 'svg' })).toEqual({
      fields: { output_format: 'svg', svg: { model: GPT_IMAGE_26_DEFAULT_SVG_MODEL } },
    })
    expect(resolveGptImage26Fields({ output_format: 'svg', svg_model: 'gpt-6-luna' })).toEqual({
      fields: { output_format: 'svg', svg: { model: 'gpt-6-luna' } },
    })
  })

  it('帧参数只在 GIF 下合法:PNG / SVG 带了就拒绝(文档:不要与非 GIF 一起用)', () => {
    for (const values of [
      { frame_count: 4 },
      { frame_duration_ms: 100 },
      { output_format: 'png', frame_count: 4 },
      { output_format: 'svg', frame_duration_ms: 100 },
    ]) {
      const r = resolveGptImage26Fields(values)
      expect(r, JSON.stringify(values)).toHaveProperty('error')
      expect((r as { error: string }).error).toMatch(/GIF/)
    }
  })

  it('SVG 写手模型只在 SVG 下合法', () => {
    for (const values of [{ svg_model: 'gpt-6-luna' }, { output_format: 'gif', svg_model: 'gpt-6-luna' }]) {
      const r = resolveGptImage26Fields(values)
      expect(r, JSON.stringify(values)).toHaveProperty('error')
      expect((r as { error: string }).error).toMatch(/SVG/)
    }
  })
})

// ───────────────────────── 腾讯 TokenHub 2.6(custom-model-og-v2.6-f / -s) ─────────────────────────
//
// 依据(2026-11-09 经 Miau 生产网关实测,sora-ui #324 / sora-ui-backend #177 同口径):
// - 拼图规则与 apiyi 相同(2 帧 960² ✓、16 帧 720² ✓、不填帧数 = 9 帧 / 200 ms),
//   但**费用随拼图面积走**:默认画质(high)下 512² 9 帧 ≈ ¥0.51,所以每帧长边取 512
//   (与画布一致),不沿用 apiyi 的 960;
// - SVG 写手固定 `gpt-5.4-mini`,只开放推理强度 none / low(medium 约 110 s、high 上游断连);
// - 结果带真实后缀(.gif / .svg)与正确 Content-Type。

const tencentSpecOf = (key: string): ModelParamSpec => TENCENT_IMAGE_26_PARAM_SPECS.find((s) => s.key === key)!

describe('腾讯 2.6 模型识别 / 家族', () => {
  it('只认 custom-model-og-v2.6-f / -s;apiyi 官转 / 2.5 / v2 都不是', () => {
    expect([...TENCENT_IMAGE_26_MODEL_IDS]).toEqual(['custom-model-og-v2.6-f', 'custom-model-og-v2.6-s'])
    for (const id of TENCENT_IMAGE_26_MODEL_IDS) expect(isTencentImage26Model(id)).toBe(true)
    for (const id of ['gpt-image-2.6-flare', 'custom-model-og-v2.5-f', 'custom-model-og-v2', 'custom-imagemodel-gt', undefined, '']) {
      expect(isTencentImage26Model(id)).toBe(false)
    }
  })

  it('gifSvgFamilyOf:apiyi 两条 → apiyi,腾讯两条 → tokenhub,其余 null', () => {
    for (const id of GPT_IMAGE_26_MODEL_IDS) expect(gifSvgFamilyOf(id)).toBe('apiyi')
    for (const id of TENCENT_IMAGE_26_MODEL_IDS) expect(gifSvgFamilyOf(id)).toBe('tokenhub')
    for (const id of ['gpt-image-2.5-flare', 'custom-model-og-v2.5-s', 'gpt-image-2', undefined, null, 3]) {
      expect(gifSvgFamilyOf(id)).toBeNull()
    }
  })
})

describe('腾讯 2.6 参数表', () => {
  it('键 = 输出格式 / 帧数 / 每帧时长 / SVG 推理强度,一个都没有默认值(不设置 = 不外发)', () => {
    expect(TENCENT_IMAGE_26_PARAM_SPECS.map((s) => s.key)).toEqual([
      'output_format',
      'frame_count',
      'frame_duration_ms',
      'svg_effort',
    ])
    for (const spec of TENCENT_IMAGE_26_PARAM_SPECS) expect(spec.defaultValue, spec.key).toBeUndefined()
  })

  it('前三项与 apiyi 是同一份定义(界面 / MCP 不会各说各话),不含 svg_model', () => {
    for (const key of ['output_format', 'frame_count', 'frame_duration_ms']) {
      expect(tencentSpecOf(key), key).toEqual(specOf(key))
    }
    expect(TENCENT_IMAGE_26_PARAM_SPECS.some((s) => s.key === 'svg_model')).toBe(false)
    expect(GPT_IMAGE_26_PARAM_SPECS.some((s) => s.key === 'svg_effort')).toBe(false)
  })

  it('输出格式只给 png / gif / svg(jpeg / complexity 不在这次开放范围)', () => {
    expect(tencentSpecOf('output_format').options?.map((o) => o.key)).toEqual(['png', 'gif', 'svg'])
    expect(TENCENT_IMAGE_26_PARAM_SPECS.some((s) => s.key === 'complexity')).toBe(false)
  })

  it('SVG 推理强度只开 none / low(medium 约 110 s / 7.6 万 token,high 上游断连)', () => {
    expect(tencentSpecOf('svg_effort')).toMatchObject({ type: 'select', advanced: true })
    expect(tencentSpecOf('svg_effort').options?.map((o) => o.key)).toEqual(['none', 'low'])
    expect(TENCENT_IMAGE_26_SVG_MODEL).toBe('gpt-5.4-mini')
    expect(TENCENT_IMAGE_26_DEFAULT_SVG_EFFORT).toBe('low')
    const bad = resolveModelParams(TENCENT_IMAGE_26_PARAM_SPECS, { svg_effort: 'medium' })
    expect(bad.errors).toHaveLength(1)
  })
})

describe('gifSafeSize:每帧长边上限随渠道(腾讯 512 / apiyi 960)', () => {
  it('上限表', () => {
    expect(GIF_FRAME_LONG_EDGE).toEqual({ apiyi: 960, tokenhub: 512 })
  })

  it('不传上限 = apiyi 原有行为(960),已有调用方不受影响', () => {
    expect(gifSafeSize('1280x1280', 9)).toBe('960x960')
    expect(gifSafeSize('1280x1280', 9, GIF_FRAME_LONG_EDGE.apiyi)).toBe('960x960')
  })

  it('腾讯:App 的 1K / 2K / 4K 方图档统统收成 512²,与帧数无关(16 帧也只要 2048² 的拼图)', () => {
    for (const tier of ['1280x1280', '2048x2048', '2880x2880']) {
      for (const frames of [2, 4, 8, 9, 16, undefined]) {
        expect(gifSafeSize(tier, frames, GIF_FRAME_LONG_EDGE.tokenhub), `${tier} ${frames}`).toBe('512x512')
      }
    }
  })

  it('腾讯:非方图按比例,最长边 512,16 的倍数(16:9 = 512x288,9:16 = 288x512)', () => {
    expect(gifSafeSize('1280x720', 9, 512)).toBe('512x288')
    expect(gifSafeSize('720x1280', 9, 512)).toBe('288x512')
    expect(gifSafeSize('2048x1152', 16, 512)).toBe('512x288')
    for (const size of ['2048x1152', '1152x2048', '1536x1024', '1024x1536', '2688x1152', '1280x1280']) {
      const out = gifSafeSize(size, 16, 512)
      const [w, h] = out.split('x').map(Number) as [number, number]
      expect(w % 16, `${size} → ${out}`).toBe(0)
      expect(h % 16, `${size} → ${out}`).toBe(0)
      expect(Math.max(w, h), `${size} → ${out}`).toBeLessThanOrEqual(512)
      expect(w * h * 16, `${size} → ${out}`).toBeLessThanOrEqual(GIF_SHEET_MAX_PIXELS)
    }
  })

  it('腾讯:没有尺寸(比例 auto)→ 512 方图;本来就小的不放大', () => {
    expect(gifSafeSize(undefined, 2, 512)).toBe('512x512')
    expect(gifSafeSize('auto', 16, 512)).toBe('512x512')
    expect(gifSafeSize('384x384', 2, 512)).toBe('384x384')
  })
})

describe('resolveGifSvgFields:按家族翻译外发字段', () => {
  it('apiyi 家族 = resolveGptImage26Fields(完全不变)', () => {
    for (const values of [{}, { output_format: 'gif', frame_count: 4 }, { output_format: 'svg', svg_model: 'gpt-6-luna' }, { frame_count: 4 }]) {
      expect(resolveGifSvgFields(values, 'apiyi'), JSON.stringify(values)).toEqual(resolveGptImage26Fields(values))
    }
  })

  it('腾讯 PNG / 什么都没设 = 不外发任何额外字段', () => {
    expect(resolveGifSvgFields({}, 'tokenhub')).toEqual({ fields: {} })
    expect(resolveGifSvgFields({ output_format: 'png' }, 'tokenhub')).toEqual({ fields: {} })
  })

  it('腾讯 GIF:与 apiyi 同形,没给的帧参数不发(上游默认 9 帧 / 200 ms)', () => {
    expect(resolveGifSvgFields({ output_format: 'gif' }, 'tokenhub')).toEqual({ fields: { output_format: 'gif' } })
    expect(resolveGifSvgFields({ output_format: 'gif', frame_count: 8, frame_duration_ms: 100 }, 'tokenhub')).toEqual({
      fields: { output_format: 'gif', frame_count: 8, frame_duration_ms: 100 },
    })
  })

  it('腾讯 SVG:嵌套 svg.model = gpt-5.4-mini + reasoning.effort,没选时用 low', () => {
    expect(resolveGifSvgFields({ output_format: 'svg' }, 'tokenhub')).toEqual({
      fields: { output_format: 'svg', svg: { model: 'gpt-5.4-mini', reasoning: { effort: 'low' } } },
    })
    expect(resolveGifSvgFields({ output_format: 'svg', svg_effort: 'none' }, 'tokenhub')).toEqual({
      fields: { output_format: 'svg', svg: { model: 'gpt-5.4-mini', reasoning: { effort: 'none' } } },
    })
  })

  it('腾讯:帧参数只在 GIF、推理强度只在 SVG 下合法,否则拒绝不纠正', () => {
    for (const values of [{ frame_count: 4 }, { output_format: 'svg', frame_duration_ms: 100 }]) {
      const r = resolveGifSvgFields(values, 'tokenhub')
      expect((r as { error: string }).error, JSON.stringify(values)).toMatch(/GIF/)
    }
    for (const values of [{ svg_effort: 'none' }, { output_format: 'gif', svg_effort: 'low' }, { output_format: 'png', svg_effort: 'low' }]) {
      const r = resolveGifSvgFields(values, 'tokenhub')
      expect((r as { error: string }).error, JSON.stringify(values)).toMatch(/SVG/)
    }
  })
})