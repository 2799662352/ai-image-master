import { describe, expect, it } from 'vitest'
import {
  NOVELAI_MODEL_IDS,
  NOVELAI_RESOLUTION_MAP,
  NOVELAI_V45_PARAM_SPECS,
  NOVELAI_V5_PARAM_SPECS,
  isModelParamDefault,
  isNovelAiModel,
  novelAiFamilyOfModel,
  novelAiParamSpecsForModel,
  resolveModelParams,
  type ModelParamSpec,
} from '../imageModelParams'

/**
 * NovelAI(经 TTAPI)的参数表与 `characters` 列表参数。
 *
 * 网关会逐项校验并拒绝越界值(按张计费,带病外发 = 白扣钱),所以这里把「界面 / agent 能给出的
 * 值」与「网关认的字段」之间的每一道闸都钉死:键名、默认值、范围、角色数上限、位置范围、草稿行。
 */

const specOf = (key: string, table: readonly ModelParamSpec[] = NOVELAI_V5_PARAM_SPECS) =>
  table.find((s) => s.key === key)!

describe('NovelAI 模型识别', () => {
  it('四个模型 id 都被识别,别的不认', () => {
    expect([...NOVELAI_MODEL_IDS]).toEqual([
      'nai-diffusion-5-full',
      'nai-diffusion-5-curated',
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
    ])
    for (const id of NOVELAI_MODEL_IDS) expect(isNovelAiModel(id)).toBe(true)
    expect(isNovelAiModel('nai-diffusion-3')).toBe(false)
    expect(isNovelAiModel('youchuan-v8.2')).toBe(false)
    expect(isNovelAiModel(undefined)).toBe(false)
  })

  it('V5 / V4.5 家族由 id 推出', () => {
    expect(novelAiFamilyOfModel('nai-diffusion-5-full')).toBe('v5')
    expect(novelAiFamilyOfModel('nai-diffusion-5-curated')).toBe('v5')
    expect(novelAiFamilyOfModel('nai-diffusion-4-5-full')).toBe('v45')
    expect(novelAiFamilyOfModel('nai-diffusion-4-5-curated')).toBe('v45')
    expect(novelAiFamilyOfModel('gpt-image-2')).toBeNull()
  })

  it('参数表按家族取;别的渠道没有', () => {
    expect(novelAiParamSpecsForModel('nai-diffusion-5-full')).toBe(NOVELAI_V5_PARAM_SPECS)
    expect(novelAiParamSpecsForModel('nai-diffusion-4-5-curated')).toBe(NOVELAI_V45_PARAM_SPECS)
    expect(novelAiParamSpecsForModel('gpt-image-2')).toEqual([])
  })
})

describe('NovelAI 参数表', () => {
  it('键名唯一,且都是网关读的字段名(顺序即界面顺序)', () => {
    const keys = NOVELAI_V5_PARAM_SPECS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual([
      'dataset_mode',
      'negative_prompt',
      'characters',
      'steps',
      'scale',
      'sampler',
      'noise_schedule',
      'seed',
      'img2img_strength',
      'img2img_noise',
    ])
    expect(NOVELAI_V45_PARAM_SPECS.map((s) => s.key)).toEqual(keys)
  })

  it('V5 与 V4.5 只有角色数上限不同(22 vs 6)', () => {
    expect(specOf('characters', NOVELAI_V5_PARAM_SPECS).maxItems).toBe(22)
    expect(specOf('characters', NOVELAI_V45_PARAM_SPECS).maxItems).toBe(6)
    for (const key of ['steps', 'scale', 'sampler', 'noise_schedule', 'seed']) {
      expect(specOf(key, NOVELAI_V5_PARAM_SPECS)).toEqual(specOf(key, NOVELAI_V45_PARAM_SPECS))
    }
  })

  it('主区只有风格 / 负面 / 角色,其余折叠进高级参数', () => {
    expect(NOVELAI_V5_PARAM_SPECS.filter((s) => !s.advanced).map((s) => s.key)).toEqual([
      'dataset_mode',
      'negative_prompt',
      'characters',
    ])
  })

  it('产品默认:23 步 / CFG 5 / Euler Ancestral / karras / anime,种子与图生图两项没有默认', () => {
    expect(specOf('dataset_mode').defaultValue).toBe('anime')
    expect(specOf('steps').defaultValue).toBe(23)
    expect(specOf('scale').defaultValue).toBe(5)
    expect(specOf('sampler').defaultValue).toBe('Euler Ancestral')
    expect(specOf('noise_schedule').defaultValue).toBe('karras')
    expect(specOf('img2img_strength').defaultValue).toBe(0.7)
    expect(specOf('img2img_noise').defaultValue).toBe(0)
    expect(specOf('seed').defaultValue).toBeUndefined()
    expect(specOf('negative_prompt').defaultValue).toBeUndefined()
    expect(specOf('characters').defaultValue).toBeUndefined()
  })

  it('取值范围与网关一致:步数 1–50、CFG 0–10、种子 0–4294967295、强度 0.01–0.99', () => {
    expect(specOf('steps')).toMatchObject({ min: 1, max: 50, integer: true })
    expect(specOf('scale')).toMatchObject({ min: 0, max: 10 })
    expect(specOf('seed')).toMatchObject({ min: 0, max: 4294967295, integer: true })
    expect(specOf('img2img_strength')).toMatchObject({ min: 0.01, max: 0.99 })
    expect(specOf('img2img_noise')).toMatchObject({ min: 0, max: 0.99 })
  })

  it('采样器 / 噪声调度的选项就是网关白名单(noise_schedule 不含 native)', () => {
    expect(specOf('sampler').options?.map((o) => o.key)).toEqual([
      'Euler Ancestral',
      'Euler',
      'DPM++ 2S Ancestral',
      'DPM++ 2M SDE',
      'DPM++ 2M',
      'DPM++ SDE',
    ])
    expect(specOf('noise_schedule').options?.map((o) => o.key)).toEqual(['karras', 'exponential', 'polyexponential'])
  })

  it('比例 × 清晰度表:每边都是 64 的倍数、像素不超过网关上限 3,145,728', () => {
    for (const [ratio, row] of Object.entries(NOVELAI_RESOLUTION_MAP)) {
      expect(Object.keys(row), ratio).toEqual(['1K', '2K'])
      for (const size of Object.values(row)) {
        const [w, h] = size.split('x').map(Number)
        expect(w % 64, `${ratio} ${size}`).toBe(0)
        expect(h % 64, `${ratio} ${size}`).toBe(0)
        expect(w * h, `${ratio} ${size}`).toBeLessThanOrEqual(3_145_728)
      }
    }
    expect(Object.keys(NOVELAI_RESOLUTION_MAP)).toEqual(['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'])
  })
})

describe('resolveModelParams · NovelAI 标量参数', () => {
  it('什么都不给 = 只带产品默认', () => {
    expect(resolveModelParams(NOVELAI_V5_PARAM_SPECS, {})).toEqual({
      values: {
        dataset_mode: 'anime',
        steps: 23,
        scale: 5,
        sampler: 'Euler Ancestral',
        noise_schedule: 'karras',
        img2img_strength: 0.7,
        img2img_noise: 0,
      },
      errors: [],
    })
  })

  it('用户值赢过默认,字符串数字被规整成数字', () => {
    const { values, errors } = resolveModelParams(NOVELAI_V5_PARAM_SPECS, {
      steps: '30',
      scale: 6.5,
      sampler: 'Euler',
      dataset_mode: 'furry',
      seed: 42,
      negative_prompt: ' lowres, bad hands ',
    })
    expect(errors).toEqual([])
    expect(values).toMatchObject({
      steps: 30,
      scale: 6.5,
      sampler: 'Euler',
      dataset_mode: 'furry',
      seed: 42,
      negative_prompt: 'lowres, bad hands',
    })
  })

  it.each([
    ['步数 0', { steps: 0 }, /步数.*不能小于 1/],
    ['步数 51', { steps: 51 }, /步数/],
    ['步数 12.5', { steps: 12.5 }, /整数/],
    ['CFG -1', { scale: -1 }, /不能小于 0/],
    ['CFG 11', { scale: 11 }, /不能大于 10/],
    ['种子 -1', { seed: -1 }, /种子.*不能小于 0/],
    ['种子超过 4294967295', { seed: 4294967296 }, /种子.*不能大于 4294967295/],
    ['未知采样器', { sampler: 'DDIM' }, /采样器/],
    ['native 噪声调度', { noise_schedule: 'native' }, /噪声/],
    ['未知画风', { dataset_mode: 'cartoon' }, /anime \/ furry/],
    ['强度 0', { img2img_strength: 0 }, /强度.*不能小于 0.01/],
    ['强度 1', { img2img_strength: 1 }, /不能大于 0.99/],
  ])('%s:拒绝而不是纠正', (_label, input, message) => {
    const { errors } = resolveModelParams(NOVELAI_V5_PARAM_SPECS, input)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.join('；')).toMatch(message)
  })

  it('负面提示词超过 2000 字符被拒', () => {
    const { errors } = resolveModelParams(NOVELAI_V5_PARAM_SPECS, { negative_prompt: 'a'.repeat(2001) })
    expect(errors.join('；')).toMatch(/2000/)
    expect(resolveModelParams(NOVELAI_V5_PARAM_SPECS, { negative_prompt: 'a'.repeat(2000) }).errors).toEqual([])
  })

  it('没声明的键不外发(别的渠道的残留值 / agent 手滑)', () => {
    const { values } = resolveModelParams(NOVELAI_V5_PARAM_SPECS, { chaos: 50, hd: true, vibe_transfer: [] })
    for (const key of ['chaos', 'hd', 'vibe_transfer']) expect(key in values, key).toBe(false)
  })
})

describe('resolveModelParams · characters', () => {
  const run = (characters: unknown, table: readonly ModelParamSpec[] = NOVELAI_V5_PARAM_SPECS) =>
    resolveModelParams(table, { characters })

  it('没填 / 空数组 = 不设置,不报错也不外发', () => {
    expect(run(undefined)).toMatchObject({ errors: [] })
    expect('characters' in run(undefined).values).toBe(false)
    expect('characters' in run([]).values).toBe(false)
    expect(run([]).errors).toEqual([])
  })

  it('位置缺省居中,提示词与负面首尾空白被去掉,输出里没有 enabled', () => {
    const { values, errors } = run([{ prompt: '  1girl, red hair ', uc: ' hat ', enabled: true }, { prompt: '1boy', x: 0.2, y: 0.8 }])
    expect(errors).toEqual([])
    expect(values.characters).toEqual([
      { prompt: '1girl, red hair', uc: 'hat', x: 0.5, y: 0.5 },
      { prompt: '1boy', x: 0.2, y: 0.8 },
    ])
  })

  it('负面留空时不带 uc 键', () => {
    const { values } = run([{ prompt: '1girl', uc: '   ' }])
    expect(values.characters).toEqual([{ prompt: '1girl', x: 0.5, y: 0.5 }])
  })

  it('位置边界 0 与 1 合法', () => {
    expect(run([{ prompt: 'a', x: 0, y: 1 }]).errors).toEqual([])
  })

  it('关掉的角色与完全空白的草稿行被丢弃,不占名额', () => {
    const { values, errors } = run([
      { prompt: 'kept' },
      { prompt: 'off', enabled: false },
      { prompt: '', uc: '' },
      { prompt: '   ' },
    ])
    expect(errors).toEqual([])
    expect(values.characters).toEqual([{ prompt: 'kept', x: 0.5, y: 0.5 }])
  })

  it('只写了负面没写提示词:报错并指向原始序号(含被丢弃的行)', () => {
    const { errors } = run([{ prompt: 'a', enabled: false }, { prompt: '', uc: 'hat' }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('角色 2')
    expect(errors[0]).toContain('提示词不能为空')
  })

  it.each([
    ['x 超出', { prompt: 'a', x: 1.1 }, /位置 x/],
    ['y 为负', { prompt: 'a', y: -0.1 }, /位置 y/],
    ['x 是字符串', { prompt: 'a', x: '0.3' }, /位置 x/],
    ['y 是 NaN', { prompt: 'a', y: Number.NaN }, /位置 y/],
    ['提示词不是文本', { prompt: 5 }, /提示词必须是文本/],
    ['负面不是文本', { prompt: 'a', uc: 5 }, /负面提示词必须是文本/],
  ])('%s:拒绝', (_label, character, message) => {
    const { errors } = run([character])
    expect(errors.join('；')).toMatch(message)
  })

  it('提示词 2000 字符、负面 1000 字符是上限(按码点算,emoji 算一个)', () => {
    expect(run([{ prompt: 'a'.repeat(2000) }]).errors).toEqual([])
    expect(run([{ prompt: 'a'.repeat(2001) }]).errors.join('；')).toMatch(/最长 2000/)
    expect(run([{ prompt: 'a', uc: 'b'.repeat(1000) }]).errors).toEqual([])
    expect(run([{ prompt: 'a', uc: 'b'.repeat(1001) }]).errors.join('；')).toMatch(/最长 1000/)
    expect(run([{ prompt: '😀'.repeat(2000) }]).errors).toEqual([])
  })

  it('不是列表 / 元素不是对象:报格式错误', () => {
    expect(run('1girl').errors.join('；')).toMatch(/必须是列表/)
    expect(run(['1girl']).errors.join('；')).toMatch(/角色 1 格式不正确/)
    expect(run([null]).errors.join('；')).toMatch(/角色 1 格式不正确/)
    expect(run([[]]).errors.join('；')).toMatch(/角色 1 格式不正确/)
  })

  it('V5 最多 22 个、V4.5 最多 6 个;超出报错而不是截断', () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => ({ prompt: `c${i}` }))
    expect(run(make(22)).errors).toEqual([])
    expect(run(make(23)).errors.join('；')).toMatch(/最多 22 个，当前 23 个/)
    expect(run(make(6), NOVELAI_V45_PARAM_SPECS).errors).toEqual([])
    expect(run(make(7), NOVELAI_V45_PARAM_SPECS).errors.join('；')).toMatch(/最多 6 个，当前 7 个/)
  })

  it('上限按丢弃草稿之后的数量算', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => ({ prompt: `c${i}` })),
      { prompt: '' },
      { prompt: 'off', enabled: false },
    ]
    expect(run(rows, NOVELAI_V45_PARAM_SPECS).errors).toEqual([])
  })
})

describe('isModelParamDefault · NovelAI', () => {
  it('没设置、或等于产品默认,都算默认态', () => {
    expect(isModelParamDefault(specOf('steps'), undefined)).toBe(true)
    expect(isModelParamDefault(specOf('steps'), 23)).toBe(true)
    expect(isModelParamDefault(specOf('sampler'), 'Euler Ancestral')).toBe(true)
    expect(isModelParamDefault(specOf('characters'), [])).toBe(true)
    expect(isModelParamDefault(specOf('negative_prompt'), '')).toBe(true)
  })

  it('偏离默认才算已修改;有角色就是已修改', () => {
    expect(isModelParamDefault(specOf('steps'), 28)).toBe(false)
    expect(isModelParamDefault(specOf('dataset_mode'), 'furry')).toBe(false)
    expect(isModelParamDefault(specOf('characters'), [{ prompt: 'a', x: 0.5, y: 0.5 }])).toBe(false)
    expect(isModelParamDefault(specOf('seed'), 0)).toBe(false)
  })
})
