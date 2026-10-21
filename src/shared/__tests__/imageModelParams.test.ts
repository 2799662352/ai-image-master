import { describe, expect, it } from 'vitest'
import {
  YOUCHUAN_MODEL_IDS,
  YOUCHUAN_V8_PARAM_SPECS,
  isModelParamDefault,
  isYouchuanModel,
  resolveModelParams,
} from '../imageModelParams'

const specOf = (key: string) => YOUCHUAN_V8_PARAM_SPECS.find((s) => s.key === key)!

describe('悠船参数表', () => {
  it('键名唯一,且都是网关读的字段名', () => {
    const keys = YOUCHUAN_V8_PARAM_SPECS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['hd', 'quality', 'chaos', 'stylize', 'raw', 'iw', 'sref', 'sw', 'sv', 'seed', 'no'])
  })

  it('只有原生 2K 有产品默认(默认开、计费 ×1.5),其余全部「不设置 = 自动」', () => {
    const withDefault = YOUCHUAN_V8_PARAM_SPECS.filter((s) => s.defaultValue !== undefined)
    expect(withDefault.map((s) => s.key)).toEqual(['hd'])
    expect(specOf('hd').defaultValue).toBe(true)
    expect(specOf('hd').priceMultiplier).toBe(1.5)
  })

  it('原生 2K 在主区,其余都折叠进高级参数', () => {
    expect(YOUCHUAN_V8_PARAM_SPECS.filter((s) => !s.advanced).map((s) => s.key)).toEqual(['hd'])
  })

  it('两个模型 id 都被识别,别的不认', () => {
    for (const id of YOUCHUAN_MODEL_IDS) expect(isYouchuanModel(id)).toBe(true)
    expect(isYouchuanModel('youchuan-v8.2')).toBe(true)
    expect(isYouchuanModel('youchuan-v8.2-turbo')).toBe(true)
    expect(isYouchuanModel('gpt-image-2')).toBe(false)
    expect(isYouchuanModel(undefined)).toBe(false)
  })
})

describe('resolveModelParams', () => {
  it('什么都不给 = 只带产品默认(原生 2K 开),不发任何别的字段', () => {
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, undefined)).toEqual({
      values: { hd: true },
      errors: [],
    })
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, {})).toEqual({ values: { hd: true }, errors: [] })
  })

  it('用户显式给的 false 要赢过默认的 true', () => {
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { hd: false }).values).toEqual({ hd: false })
  })

  it('「没填」(undefined / null / 空串 / 空数组)当作不设置,既不报错也不覆盖默认', () => {
    const { values, errors } = resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, {
      hd: undefined,
      chaos: null,
      no: '   ',
      sref: [],
      quality: '',
    })
    expect(errors).toEqual([])
    expect(values).toEqual({ hd: true })
  })

  it('合法的高级参数原样带出,并规整类型', () => {
    const { values, errors } = resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, {
      quality: 4, // agent 常把数字档位传成数字
      chaos: '30', // 界面输入框回的是字符串
      stylize: 500,
      raw: true,
      iw: 1.5,
      sref: ['https://example.com/a.png', ' https://example.com/b.png '],
      sw: 200,
      sv: '6',
      seed: 42,
      no: ' text, watermark ',
    })
    expect(errors).toEqual([])
    expect(values).toEqual({
      hd: true,
      quality: '4',
      chaos: 30,
      stylize: 500,
      raw: true,
      iw: 1.5,
      sref: ['https://example.com/a.png', 'https://example.com/b.png'],
      sw: 200,
      sv: 6,
      seed: 42,
      no: 'text, watermark',
    })
  })

  it('图像权重是小数 —— 网关按 --iw 1.5 读,不能被当成整数拒掉', () => {
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { iw: 0.5 }).errors).toEqual([])
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { iw: 3 }).errors).toEqual([])
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { iw: 3.1 }).errors).toHaveLength(1)
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { iw: -0.1 }).errors).toHaveLength(1)
  })

  it('越界值被拒绝而不是截断(按次计费,不能悄悄出一张与设置不符的图)', () => {
    const cases: Array<[string, unknown]> = [
      ['chaos', 101],
      ['chaos', -1],
      ['chaos', 1.5],
      ['stylize', 1001],
      ['sw', 1001],
      ['seed', 4294967296],
      ['quality', '2'],
      ['sv', 5],
      ['raw', 'yes'],
      ['hd', 1],
    ]
    for (const [key, value] of cases) {
      const { values, errors } = resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { [key]: value })
      expect(errors, `${key}=${String(value)}`).toHaveLength(1)
      expect(errors[0]).toContain(specOf(key).label)
      // 出错的键不能带进外发值(hd 例外:它保留产品默认)
      if (key !== 'hd') expect(key in values).toBe(false)
    }
  })

  it('风格参考图:最多 20 个、只收 http(s)', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `https://e.com/${i}.png`)
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { sref: twenty }).errors).toEqual([])
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { sref: [...twenty, 'https://e.com/x.png'] }).errors[0]).toContain(
      '最多 20 个',
    )
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { sref: ['data:image/png;base64,AAAA'] }).errors[0]).toContain(
      'http/https',
    )
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { sref: ['C:/x/a.png'] }).errors).toHaveLength(1)
  })

  it('界面 textarea 给的「每行一个」文本也能解析成链接列表', () => {
    const { values, errors } = resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, {
      sref: 'https://e.com/a.png\r\n\r\nhttps://e.com/b.png\n',
    })
    expect(errors).toEqual([])
    expect(values.sref).toEqual(['https://e.com/a.png', 'https://e.com/b.png'])
  })

  it('排除内容里不能夹带 -- 参数(会被拼进 --no,能绕过版本 / 速度锁)', () => {
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { no: 'text --v 6' }).errors).toHaveLength(1)
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { no: 'x'.repeat(501) }).errors).toHaveLength(1)
    expect(resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { no: 'x'.repeat(500) }).errors).toEqual([])
  })

  it('参数表里没声明的键直接丢弃,不外发', () => {
    const { values, errors } = resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, {
      weird: 100,
      version: '7',
      turbo: true,
    })
    expect(errors).toEqual([])
    expect(values).toEqual({ hd: true })
  })

  it('没有参数表(别的渠道)= 什么都不外发', () => {
    expect(resolveModelParams(undefined, { chaos: 10 })).toEqual({ values: {}, errors: [] })
    expect(resolveModelParams([], { chaos: 10 })).toEqual({ values: {}, errors: [] })
  })

  it('多个字段同时出错时逐条报,不止第一条', () => {
    const { errors } = resolveModelParams(YOUCHUAN_V8_PARAM_SPECS, { chaos: 500, stylize: 5000 })
    expect(errors).toHaveLength(2)
  })
})

describe('isModelParamDefault', () => {
  it('没设置、或等于产品默认,都算默认态', () => {
    expect(isModelParamDefault(specOf('chaos'), undefined)).toBe(true)
    expect(isModelParamDefault(specOf('no'), '')).toBe(true)
    expect(isModelParamDefault(specOf('hd'), true)).toBe(true)
  })

  it('偏离默认才算已修改', () => {
    expect(isModelParamDefault(specOf('hd'), false)).toBe(false)
    expect(isModelParamDefault(specOf('chaos'), 0)).toBe(false)
    expect(isModelParamDefault(specOf('raw'), true)).toBe(false)
  })
})
