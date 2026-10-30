import { describe, expect, it, vi } from 'vitest'
import type { ZodTypeAny } from 'zod'
import { registerImageTools } from '../imageTools'
import { ALL_CHANNEL_PARAM_SPECS, NOVELAI_MODEL_PARAMS_INTRO } from '../modelParamsSchema'
import {
  NOVELAI_MODEL_IDS,
  NOVELAI_V5_PARAM_SPECS,
  YOUCHUAN_V8_PARAM_SPECS,
} from '../../../../shared/imageModelParams'

/**
 * MCP `generate_image` / `generate_images` 的 NovelAI 部分:
 *  - `modelParams` 现在同时服务悠船与 NovelAI(两张参数表的并集),重名键必须同义;
 *  - agent 一侧就把越界值、不认识的键、不合规的角色挡掉(按张计费,别让坏请求走到渲染层);
 *  - 工具说明里要写明 NovelAI 的渠道 id、计费口径与限制。
 */

type Captured = { name: string; config: { description: string; inputSchema: ZodTypeAny } }

function schemas() {
  const tools: Captured[] = []
  const server = {
    registerTool: (name: string, config: Captured['config']) => {
      tools.push({ name, config })
    },
  }
  registerImageTools(server as never, { call: vi.fn(async () => ({ ok: true })) } as never)
  const find = (name: string) => tools.find((t) => t.name === name)!
  return {
    single: find('generate_image').config.inputSchema,
    batch: find('generate_images').config.inputSchema,
    singleDescription: find('generate_image').config.description,
  }
}

const withParams = (modelParams: unknown, model = 'nai-diffusion-5-full') => ({ prompt: '1girl', model, modelParams })

describe('modelParams 合并后的参数表', () => {
  it('重名键只许是同义(悠船与 NovelAI 目前只有 seed 重名)', () => {
    const youchuan = new Map(YOUCHUAN_V8_PARAM_SPECS.map((s) => [s.key, s]))
    const dupes = NOVELAI_V5_PARAM_SPECS.filter((s) => youchuan.has(s.key))
    expect(dupes.map((s) => s.key)).toEqual(['seed'])
    for (const spec of dupes) {
      const other = youchuan.get(spec.key)!
      expect({ type: spec.type, min: spec.min, max: spec.max, integer: spec.integer }).toEqual({
        type: other.type,
        min: other.min,
        max: other.max,
        integer: other.integer,
      })
    }
  })

  it('并集里每个键只出现一次', () => {
    const keys = ALL_CHANNEL_PARAM_SPECS.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(
      expect.arrayContaining([...YOUCHUAN_V8_PARAM_SPECS, ...NOVELAI_V5_PARAM_SPECS].map((s) => s.key)),
    )
  })
})

describe('NovelAI modelParams schema', () => {
  it('model 枚举包含四个 NovelAI 渠道', () => {
    const { single } = schemas()
    for (const id of NOVELAI_MODEL_IDS) {
      expect(single.safeParse({ prompt: '1girl', model: id }).success, id).toBe(true)
    }
  })

  it('接受全部合法旋钮(含角色),单张与批量都有', () => {
    const { single, batch } = schemas()
    const full = {
      dataset_mode: 'furry',
      negative_prompt: 'lowres, bad hands',
      characters: [
        { prompt: '1girl, red hair', uc: 'hat', x: 0.2, y: 0.4 },
        { prompt: '1boy' },
      ],
      steps: 28,
      scale: 6.5,
      sampler: 'Euler',
      noise_schedule: 'exponential',
      seed: 42,
      img2img_strength: 0.5,
      img2img_noise: 0.1,
    }
    expect(single.safeParse(withParams(full)).success).toBe(true)
    expect(batch.safeParse({ prompts: ['a', 'b'], model: 'nai-diffusion-4-5-full', modelParams: full }).success).toBe(true)
  })

  it('不传 / 传空对象都合法 —— 默认一个都不用设', () => {
    const { single } = schemas()
    expect(single.safeParse({ prompt: '1girl', model: 'nai-diffusion-5-full' }).success).toBe(true)
    expect(single.safeParse(withParams({})).success).toBe(true)
  })

  it('count 1–4 合法(原生 n)', () => {
    const { single } = schemas()
    for (const count of [1, 2, 3, 4]) {
      expect(single.safeParse({ prompt: '1girl', model: 'nai-diffusion-5-full', count }).success, String(count)).toBe(true)
    }
  })

  it('越界 / 类型错 / 不合规的角色一律在 agent 一侧就拒掉', () => {
    const { single, batch } = schemas()
    const bad: unknown[] = [
      { steps: 0 },
      { steps: 51 },
      { steps: 12.5 },
      { scale: 11 },
      { scale: -1 },
      { sampler: 'DDIM' },
      { noise_schedule: 'native' },
      { dataset_mode: 'cartoon' },
      { img2img_strength: 0 },
      { img2img_strength: 1 },
      { img2img_noise: 1 },
      { negative_prompt: 'x'.repeat(2001) },
      { seed: -1 },
      { characters: 'a girl' },
      { characters: [{}] },
      { characters: [{ prompt: '' }] },
      { characters: [{ prompt: 'a', x: 1.5 }] },
      { characters: [{ prompt: 'a', y: -0.1 }] },
      { characters: [{ prompt: 'a', uc: 'x'.repeat(1001) }] },
      { characters: [{ prompt: 'x'.repeat(2001) }] },
      // strictObject:写错键名(center)直接报错,而不是静默丢掉位置
      { characters: [{ prompt: 'a', center: { x: 0.5, y: 0.5 } }] },
      { characters: Array.from({ length: 23 }, (_, i) => ({ prompt: `c${i}` })) },
      // 氛围迁移 / 角色精准参考上游不可用,不开口子
      { vibe_transfer: [] },
      { character_reference: [] },
      { stylise: 1 },
    ]
    for (const modelParams of bad) {
      expect(single.safeParse(withParams(modelParams)).success, JSON.stringify(modelParams)).toBe(false)
    }
    expect(batch.safeParse({ prompts: ['a'], model: 'nai-diffusion-5-full', modelParams: { steps: 99 } }).success).toBe(false)
  })

  it('V5 的 22 个角色在 schema 层合法(V4.5 的 6 个上限由渲染层按模型校验)', () => {
    const { single } = schemas()
    const rows = Array.from({ length: 22 }, (_, i) => ({ prompt: `c${i}` }))
    expect(single.safeParse(withParams({ characters: rows })).success).toBe(true)
  })
})

describe('NovelAI 工具说明', () => {
  it('说明文案写明渠道、按张计费、角色上限、图生图只收一张、越界拒绝', () => {
    expect(NOVELAI_MODEL_PARAMS_INTRO).toMatch(/nai-diffusion-5-full/)
    expect(NOVELAI_MODEL_PARAMS_INTRO).toMatch(/BILLED PER IMAGE|billed PER IMAGE/i)
    expect(NOVELAI_MODEL_PARAMS_INTRO).toMatch(/22 on V5, 6 on V4\.5/)
    expect(NOVELAI_MODEL_PARAMS_INTRO).toMatch(/exactly ONE/)
    expect(NOVELAI_MODEL_PARAMS_INTRO).toMatch(/REJECTED/)
  })

  it('modelParams 字段说明同时覆盖悠船与 NovelAI,并强调只传所用渠道的键', () => {
    const { single } = schemas()
    const desc = (single.shape.modelParams as { description?: string }).description ?? ''
    expect(desc).toMatch(/悠船/)
    expect(desc).toMatch(/NovelAI/)
    expect(desc).toMatch(/IGNORED by every other channel/)
  })

  it('generate_image 的说明里点名 NovelAI 渠道与 count 语义', () => {
    const { singleDescription, single } = schemas()
    expect(singleDescription).toMatch(/NovelAI/)
    const modelDesc = (single.shape.model as { description?: string }).description ?? ''
    for (const id of NOVELAI_MODEL_IDS) expect(modelDesc, id).toContain(id)
    const countDesc = (single.shape.count as { description?: string }).description ?? ''
    expect(countDesc).toMatch(/nai-diffusion-\*/)
    const transparentDesc = (single.shape.transparentBackground as { description?: string }).description ?? ''
    expect(transparentDesc).toMatch(/nai-diffusion-5-full/)
    expect(transparentDesc).toMatch(/V4\.5 channels REJECT/)
  })
})
