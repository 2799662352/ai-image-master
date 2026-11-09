import { describe, expect, it } from 'vitest'
import {
  GPT_IMAGE_26_DEFAULT_SVG_MODEL,
  GPT_IMAGE_26_MODEL_IDS,
  GPT_IMAGE_26_PARAM_SPECS,
  gifSvgUnsupportedReason,
  isGptImage26Model,
  resolveGptImage26Fields,
  resolveModelParams,
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

  it('帧数 2–64 整数、每帧时长 20–2000 整数,与文档一致', () => {
    expect(specOf('frame_count')).toMatchObject({ type: 'number', integer: true, min: 2, max: 64 })
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

describe('gifSvgUnsupportedReason:agent 要了动图 / 矢量却落在不支持的模型上', () => {
  it('别的模型 + GIF / SVG / 只有 GIF·SVG 专属参数 → 中文原因,里面带可用的模型 id', () => {
    for (const model of ['custom-model-og-v2.6-s', 'custom-model-og-v2.6-f', 'gpt-image-2.5-flare', 'gpt-image-2', undefined]) {
      for (const params of [{ output_format: 'gif' }, { output_format: 'svg' }, { frame_count: 4 }, { frame_duration_ms: 100 }, { svg_model: 'gpt-6-luna' }]) {
        const reason = gifSvgUnsupportedReason(model, params)
        expect(reason, `${model} ${JSON.stringify(params)}`).toMatch(/gpt-image-2\.6-flare/)
        expect(reason).toMatch(/gpt-image-2\.6-sunburst/)
      }
    }
  })

  it('2.6 官转两条放行(参数是否合法另有校验)', () => {
    for (const model of GPT_IMAGE_26_MODEL_IDS) {
      expect(gifSvgUnsupportedReason(model, { output_format: 'gif' })).toBeNull()
      expect(gifSvgUnsupportedReason(model, { output_format: 'svg' })).toBeNull()
    }
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
