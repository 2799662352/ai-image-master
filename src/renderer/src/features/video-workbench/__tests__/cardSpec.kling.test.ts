// 可灵 4.0 / 4.0 Omni 在工作台规格层的收敛规则。
//
// 可灵与 Seedance / 万相有三处不同,每一处都曾经靠「启发式」推断、推错了就是提交时才炸:
//   1. 默认画幅:可灵也有 adaptive,但文生视频没有素材可跟随 → 默认 16:9,不是 adaptive;
//   2. 没有智能时长:`duration: -1` 网关当「时长非法」拒;
//   3. 4.0 没有「全能参考」:带参考图 / 参考视频的角色会被网关回「需要 Omni」。

import { beforeEach, describe, expect, it } from 'vitest'
import { conformToModel, defaultModeFor, normalizeSpec } from '../cardSpec'
import { buildCard, canStart, resetWorkbenchStoreForTest, useVideoWorkbenchStore } from '../store'
import { resetWorkbenchDbForTest } from '../WorkbenchDb'

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
})

describe('normalizeSpec · 可灵默认值', () => {
  it('默认画幅 16:9(不是 adaptive),时长 5,分辨率 720p', () => {
    const spec = normalizeSpec({ model: 'kling4', prompt: 'x' })
    expect(spec.ratio).toBe('16:9')
    expect(spec.duration).toBe(5)
    expect(spec.resolution).toBe('720p')
  })

  it('万相 / Seedance 的默认画幅不受影响', () => {
    expect(normalizeSpec({ model: 'wan3', prompt: 'x' }).ratio).toBe('adaptive')
    expect(normalizeSpec({ model: '2.0', prompt: 'x' }).ratio).toBe('16:9')
  })

  it('用户明确选了 adaptive 就保留(可灵也支持)', () => {
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', ratio: 'adaptive' }).ratio).toBe('adaptive')
  })

  it('不支持的画幅被收敛到默认(可灵没有 4:3)', () => {
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', ratio: '4:3' as never }).ratio).toBe('16:9')
  })

  it('时长按 3–30 收敛', () => {
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', duration: 1 }).duration).toBe(3)
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', duration: 99 }).duration).toBe(30)
  })
})

describe('defaultModeFor · 没指定模式时按模型能力选', () => {
  it('Seedance / 万相 / Omni:全能参考(行为不变)', () => {
    expect(defaultModeFor('2.0', 0)).toBe('multimodal_ref')
    expect(defaultModeFor('2.5', 3)).toBe('multimodal_ref')
    expect(defaultModeFor('wan3', 0)).toBe('multimodal_ref')
    expect(defaultModeFor('kling4-omni', 0)).toBe('multimodal_ref')
  })

  it('可灵 4.0 没有全能参考:按已有参考图张数选 文生 / 首帧 / 首尾帧', () => {
    expect(defaultModeFor('kling4', 0)).toBe('text2video')
    expect(defaultModeFor('kling4', 1)).toBe('first_frame')
    expect(defaultModeFor('kling4', 2)).toBe('first_last_frame')
    expect(defaultModeFor('kling4', 5)).toBe('first_last_frame')
  })

  it('normalizeSpec 没给 mode 时用它;给了就原样保留(不对的由 canStart 说明原因)', () => {
    expect(normalizeSpec({ model: 'kling4', prompt: 'x' }).mode).toBe('text2video')
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', referenceImages: ['https://x/a.png'] }).mode).toBe('first_frame')
    expect(normalizeSpec({ model: 'kling4', prompt: 'x', mode: 'multimodal_ref' }).mode).toBe('multimodal_ref')
    expect(normalizeSpec({ model: '2.0', prompt: 'x' }).mode).toBe('multimodal_ref')
  })
})

describe('conformToModel · 换模型时把越界的模式 / 时长就地收敛', () => {
  const base = { mode: 'multimodal_ref' as const, duration: 5, referenceImages: [] as unknown[] }

  it('智能时长切到可灵:换成 5 秒(可灵没有智能时长)', () => {
    expect(conformToModel({ ...base, model: 'kling4', duration: -1 }).duration).toBe(5)
    expect(conformToModel({ ...base, model: 'kling4-omni', duration: -1 }).duration).toBe(5)
  })

  it('支持智能时长的模型不动它', () => {
    expect(conformToModel({ ...base, model: '2.0', duration: -1 }).duration).toBe(-1)
    expect(conformToModel({ ...base, model: 'wan3', duration: -1 }).duration).toBe(-1)
  })

  it('正常秒数不动(越界交给 canStart 报,不在这里悄悄改)', () => {
    expect(conformToModel({ ...base, model: 'kling4', duration: 12 }).duration).toBe(12)
    expect(conformToModel({ ...base, model: 'kling4', duration: 99 }).duration).toBe(99)
  })

  it('全能参考切到 4.0:退到首帧 / 首尾帧(按参考图张数),素材随后由 store 按模式上限截断', () => {
    expect(conformToModel({ ...base, model: 'kling4' }).mode).toBe('text2video')
    expect(conformToModel({ ...base, model: 'kling4', referenceImages: ['a'] }).mode).toBe('first_frame')
    expect(conformToModel({ ...base, model: 'kling4', referenceImages: ['a', 'b', 'c'] }).mode).toBe('first_last_frame')
  })

  it('Omni 保留全能参考;4.0 本来就有的模式不动', () => {
    expect(conformToModel({ ...base, model: 'kling4-omni' }).mode).toBe('multimodal_ref')
    expect(conformToModel({ ...base, model: 'kling4', mode: 'first_frame' }).mode).toBe('first_frame')
  })

  it('Seedance 全家模式是全集:恒等', () => {
    for (const mode of ['text2video', 'first_frame', 'first_last_frame', 'reference_images', 'multimodal_ref', 'edit_video', 'extend_video'] as const) {
      expect(conformToModel({ ...base, model: '2.0', mode, duration: mode === 'edit_video' ? -1 : 5 }).mode).toBe(mode)
    }
  })

  it('编辑视频的锁定智能时长不被当成非法值改掉', () => {
    expect(conformToModel({ ...base, model: '2.5', mode: 'edit_video', duration: -1 }).duration).toBe(-1)
  })
})

describe('canStart · 可灵', () => {
  const kling = (over: Record<string, unknown> = {}) =>
    buildCard({ prompt: '一只猫', model: 'kling4', ...over } as never, 0)

  it('文生视频 + 1080p + 10 秒:可提交', () => {
    expect(canStart(kling({ resolution: '1080p', duration: 10 })).ok).toBe(true)
  })

  it('2k / 4k 可提交;480p 不行(可灵没有这档)', () => {
    expect(canStart(kling({ resolution: '2k' })).ok).toBe(true)
    expect(canStart(kling({ resolution: '4k' })).ok).toBe(true)
    const gate = canStart(kling({ resolution: '480p' }))
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('480p')
  })

  it('智能时长(-1)被拦并说清原因 —— 绕过 buildCard 的旧卡也一样', () => {
    const gate = canStart({ ...kling(), duration: -1 })
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/智能时长/)
    expect(gate.reason).toMatch(/3-30/)
  })

  it('4.0 选「全能参考」被拦,提示用 Omni', () => {
    const gate = canStart(kling({ mode: 'multimodal_ref' }))
    expect(gate.ok).toBe(false)
    expect(gate.reason).toMatch(/不支持/)
  })

  it('Omni 全能参考 + 参考视频:可提交', () => {
    const card = buildCard(
      {
        prompt: '延续这段',
        model: 'kling4-omni',
        referenceVideos: [{ src: 'https://x/v.mp4', kind: 'video' }],
      } as never,
      0,
    )
    expect(card.mode).toBe('multimodal_ref')
    expect(canStart(card).ok).toBe(true)
  })

  it('Seedance / 万相的既有校验不受影响:2.0 的智能时长照旧能提交', () => {
    expect(canStart(buildCard({ prompt: 'x', model: '2.0', duration: -1 }, 0)).ok).toBe(true)
    expect(canStart(buildCard({ prompt: 'x', model: 'wan3', duration: -1 }, 0)).ok).toBe(true)
  })
})

describe('updateCard · 换模型', () => {
  it('2.0 的智能时长 + 全能参考卡切到可灵 4.0:时长变 5、模式退到首帧,多余素材被截断', () => {
    const store = useVideoWorkbenchStore
    const [id] = store.getState().addCards([
      {
        prompt: 'x',
        model: '2.0',
        duration: -1,
        referenceImages: ['https://x/a.png', 'https://x/b.png', 'https://x/c.png'],
      },
    ])
    store.getState().updateCard(id, { model: 'kling4' })
    const card = store.getState().cards.find((c) => c.id === id)!
    expect(card.model).toBe('kling4')
    expect(card.duration).toBe(5)
    expect(card.mode).toBe('first_last_frame')
    expect(card.referenceImages).toHaveLength(2)
    expect(canStart(card).ok).toBe(true)
  })

  it('同一个 patch 里既换模型又显式选模式:尊重显式值', () => {
    const store = useVideoWorkbenchStore
    const [id] = store.getState().addCards([{ prompt: 'x', model: '2.0' }])
    store.getState().updateCard(id, { model: 'kling4', mode: 'first_frame' })
    expect(store.getState().cards.find((c) => c.id === id)!.mode).toBe('first_frame')
  })

  it('切到 Omni 保留全能参考', () => {
    const store = useVideoWorkbenchStore
    const [id] = store.getState().addCards([{ prompt: 'x', model: '2.0', duration: -1 }])
    store.getState().updateCard(id, { model: 'kling4-omni' })
    const card = store.getState().cards.find((c) => c.id === id)!
    expect(card.mode).toBe('multimodal_ref')
    expect(card.duration).toBe(5)
  })
})
