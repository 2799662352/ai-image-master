// 生成模式 / seed / 联网字段的 store 流转与提交拆分单测。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildCard,
  buildModeMedia,
  canStart,
  resetWorkbenchStoreForTest,
  taskModeForCard,
  useVideoWorkbenchStore,
} from '../store'
import { getWorkbenchDb, resetWorkbenchDbForTest } from '../WorkbenchDb'

function mockSubmit() {
  const submit = vi.fn(async () => ({ success: true, taskId: 'task-1' }))
  ;(window as any).electronAPI = { videoWorkbench: { submit } }
  return submit
}

beforeEach(() => {
  resetWorkbenchStoreForTest()
  resetWorkbenchDbForTest()
  delete (window as any).electronAPI
})

/**
 * 「编辑视频 / 延长视频」这两个模式工作台早就有,但在 2.5 之前它们从不往上游发
 * taskMode —— 选了「编辑视频」发出去的其实是一次普通生成。所以这里钉的是
 * 「只有 2.5 才派生」,以及 2.0 家族行为**保持不变**。
 */
describe('taskModeForCard（卡片模式 → 上游 taskMode）', () => {
  it('2.5 的编辑/延长模式派生出 edit/extend', () => {
    expect(taskModeForCard(buildCard({ model: '2.5', mode: 'edit_video' }, 0))).toBe('edit')
    expect(taskModeForCard(buildCard({ model: '2.5', mode: 'extend_video' }, 0))).toBe('extend')
  })

  it('2.5 的其它模式不派生', () => {
    for (const mode of ['text2video', 'first_frame', 'reference_images', 'multimodal_ref'] as const) {
      expect(taskModeForCard(buildCard({ model: '2.5', mode }, 0))).toBeUndefined()
    }
  })

  it('2.0 家族即使选了编辑/延长也不派生（行为不变）', () => {
    for (const model of ['2.0', '2.0-fast', '2.0-mini'] as const) {
      expect(taskModeForCard(buildCard({ model, mode: 'edit_video' }, 0))).toBeUndefined()
      expect(taskModeForCard(buildCard({ model, mode: 'extend_video' }, 0))).toBeUndefined()
    }
  })
})

describe('canStart 按模型能力判定', () => {
  const withVideo = (over: Record<string, unknown>) =>
    buildCard({ prompt: '一只猫', referenceVideos: [{ src: 'https://x/v.mp4', kind: 'video' }], ...over } as never, 0)

  it('2.5 建卡时不再被夹到 15 秒', () => {
    expect(buildCard({ prompt: 'x', model: '2.5', duration: 30 }, 0).duration).toBe(30)
    // 2.0 仍然夹在 15 —— 建卡这一道就挡住了，canStart 见到的已是合法值。
    expect(buildCard({ prompt: 'x', model: '2.0', duration: 30 }, 0).duration).toBe(15)
  })

  it('canStart 兜住绕过 buildCard 的越界卡（旧版本落库的草稿）', () => {
    const stale = { ...buildCard({ prompt: 'x', model: '2.0' }, 0), duration: 30 }
    const tooLong = canStart(stale)
    expect(tooLong.ok).toBe(false)
    expect(tooLong.reason).toMatch(/4-15/)
  })

  it('1080p 仍然只有 2.0,2.5 也不行', () => {
    expect(canStart(buildCard({ prompt: 'x', model: '2.0', resolution: '1080p' }, 0)).ok).toBe(true)
    expect(canStart(buildCard({ prompt: 'x', model: '2.5', resolution: '1080p' }, 0)).ok).toBe(false)
  })

  it('2.5 的编辑/延长必须带参考视频', () => {
    const missing = canStart(buildCard({ prompt: 'x', model: '2.5', mode: 'edit_video' }, 0))
    expect(missing.ok).toBe(false)
    expect(missing.reason).toMatch(/参考视频/)
    expect(canStart(withVideo({ model: '2.5', mode: 'edit_video' })).ok).toBe(true)
  })
})

describe('buildCard 新字段默认值', () => {
  it('缺省 mode=multimodal_ref、webSearch=true、配音开、seed 不出现', () => {
    const card = buildCard({}, 0)
    expect(card.mode).toBe('multimodal_ref')
    expect(card.webSearch).toBe(true)
    expect(card.generateAudio).toBe(true)
    expect(card.seed).toBeUndefined()
  })

  it('显式关闭仍然生效:联网与配音都能被显式关掉', () => {
    expect(buildCard({ webSearch: false }, 0).webSearch).toBe(false)
    expect(buildCard({ generateAudio: false }, 0).generateAudio).toBe(false)
  })

  it('非法 mode 回退全能参考;seed 越界收敛', () => {
    expect(buildCard({ mode: 'bogus' as any }, 0).mode).toBe('multimodal_ref')
    expect(buildCard({ seed: 99999999999 }, 0).seed).toBe(4294967295)
    expect(buildCard({ seed: -3 }, 0).seed).toBeUndefined()
  })

  it('duration=-1 智能时长原样保留;其余仍收敛 4–15', () => {
    expect(buildCard({ duration: -1 }, 0).duration).toBe(-1)
    expect(buildCard({ duration: 99 }, 0).duration).toBe(15)
    expect(buildCard({ duration: -5 }, 0).duration).toBe(4)
  })

  it('2.0-mini 别名可存入卡片', () => {
    expect(buildCard({ model: '2.0-mini' }, 0).model).toBe('2.0-mini')
  })
})

describe('canStart 上游硬约束', () => {
  it('音频不能单独作参考(文档 2.2):仅音频 → 拒绝;加图后放行', () => {
    const audioOnly = buildCard(
      { prompt: 'p', mode: 'multimodal_ref', referenceAudios: ['voice.mp3'] },
      0,
    )
    const gate = canStart(audioOnly)
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('音频不能单独作参考')

    const withImage = buildCard(
      { prompt: 'p', mode: 'multimodal_ref', referenceAudios: ['voice.mp3'], referenceImages: ['a.png'] },
      0,
    )
    expect(canStart(withImage).ok).toBe(true)
  })

  it('1080p 仅 2.0 满血(文档 9.2):fast/mini 配 1080p 拒绝', () => {
    const bad = buildCard({ prompt: 'p', model: '2.0-mini', resolution: '1080p' }, 0)
    expect(canStart(bad).ok).toBe(false)
    expect(canStart(bad).reason).toContain('1080p')
    const good = buildCard({ prompt: 'p', model: '2.0', resolution: '1080p' }, 0)
    expect(canStart(good).ok).toBe(true)
  })
})

describe('updateCard mode/seed/webSearch', () => {
  it('seed: 数值设置,null 清除(恢复随机)', () => {
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([{ prompt: 'p' }])
    store.updateCard(id, { seed: 42 })
    expect(useVideoWorkbenchStore.getState().cards[0].seed).toBe(42)
    store.updateCard(id, { seed: null })
    expect(useVideoWorkbenchStore.getState().cards[0].seed).toBeUndefined()
  })

  it('切换模式截断超限素材(全能参考9图 → 首帧模式只留1图)', () => {
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([
      { prompt: 'p', referenceImages: ['a.png', 'b.png', 'c.png'], referenceVideos: ['v.mp4'] },
    ])
    store.updateCard(id, { mode: 'first_frame' })
    const card = useVideoWorkbenchStore.getState().cards[0]
    expect(card.referenceImages).toHaveLength(1)
    expect(card.referenceVideos).toHaveLength(0)
  })
})

describe('buildModeMedia 提交拆分', () => {
  const base = {
    referenceImages: ['a.png', 'b.png', 'c.png'],
    referenceVideos: ['v.mp4'],
    referenceAudios: ['s.mp3'],
  }

  it('text2video 不携带任何素材', () => {
    const card = buildCard({ ...base, mode: 'text2video' }, 0)
    // buildCard 已按模式?不——buildCard 不截断,由 buildModeMedia 拆分时忽略
    expect(buildModeMedia(card)).toEqual({ referenceImages: [], referenceVideos: [], referenceAudios: [] })
  })

  it('first_frame 拆出 firstFrame,不带参考素材', () => {
    const card = buildCard({ ...base, mode: 'first_frame' }, 0)
    const media = buildModeMedia(card)
    expect(media.firstFrame).toBe('a.png')
    expect(media.lastFrame).toBeUndefined()
    expect(media.referenceImages).toEqual([])
  })

  it('first_last_frame 拆出首尾帧', () => {
    const card = buildCard({ ...base, mode: 'first_last_frame' }, 0)
    const media = buildModeMedia(card)
    expect(media.firstFrame).toBe('a.png')
    expect(media.lastFrame).toBe('b.png')
  })

  it('extend_video 只带视频;reference_images 只带图', () => {
    const extend = buildModeMedia(buildCard({ ...base, mode: 'extend_video' }, 0))
    expect(extend).toEqual({ referenceImages: [], referenceVideos: ['v.mp4'], referenceAudios: [] })
    const refImg = buildModeMedia(buildCard({ ...base, mode: 'reference_images' }, 0))
    expect(refImg.referenceImages).toEqual(['a.png', 'b.png', 'c.png'])
    expect(refImg.referenceVideos).toEqual([])
  })

  it('multimodal_ref 全量携带', () => {
    const media = buildModeMedia(buildCard({ ...base, mode: 'multimodal_ref' }, 0))
    expect(media.referenceImages).toHaveLength(3)
    expect(media.referenceVideos).toEqual(['v.mp4'])
    expect(media.referenceAudios).toEqual(['s.mp3'])
  })
})

describe('startCards 载荷携带 seed/webSearch/firstFrame', () => {
  it('首帧模式 + seed + 联网 → payload 对应字段', async () => {
    const submit = mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([
      { prompt: '一只猫', mode: 'first_frame', referenceImages: ['cat.png'], seed: 7, webSearch: true },
    ])
    await store.startCards([id])
    expect(submit).toHaveBeenCalledTimes(1)
    const payload = submit.mock.calls[0][0] as Record<string, unknown>
    expect(payload).toMatchObject({
      firstFrame: 'cat.png',
      seed: 7,
      webSearch: true,
      referenceImages: [],
    })
  })

  it('默认卡携带 webSearch:true,但不携带 seed/firstFrame', async () => {
    const submit = mockSubmit()
    const store = useVideoWorkbenchStore.getState()
    const [id] = store.addCards([{ prompt: '一只狗', referenceImages: ['dog.png'] }])
    await store.startCards([id])
    const payload = submit.mock.calls[0][0] as Record<string, unknown>
    expect(payload.webSearch).toBe(true)
    expect('seed' in payload).toBe(false)
    expect('firstFrame' in payload).toBe(false)
    expect(payload.referenceImages).toEqual(['dog.png'])
  })
})

describe('联网默认值不追溯老卡', () => {
  it('库里没有 webSearch 字段的老卡,水合后仍是关闭', async () => {
    const raw: Record<string, unknown> = { ...buildCard({ prompt: '老卡' }, 0), id: 'c-old' }
    delete raw.webSearch
    await getWorkbenchDb().put(raw as never)

    await useVideoWorkbenchStore.getState().ensureHydrated()
    const card = useVideoWorkbenchStore.getState().cards.find((c) => c.id === 'c-old')!
    expect(card.webSearch).toBe(false)
  })
})
