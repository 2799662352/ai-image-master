import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'director.score-threshold.v1'
const VISION_MODEL_KEY = 'director.vision-model.v1'
const RATIO_KEY = 'director.ratio.v1'

describe('useDirectorStore scoreThreshold persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('setScoreThreshold 会写入 localStorage 且自动夹紧到 0-10', async () => {
    const { useDirectorStore } = await import('../useDirectorStore')
    useDirectorStore.getState().setScoreThreshold(11)

    expect(useDirectorStore.getState().scoreThreshold).toBe(10)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('10')
  })

  it('初始化时会读取 localStorage 中的阈值', async () => {
    window.localStorage.setItem(STORAGE_KEY, '8')
    const { useDirectorStore } = await import('../useDirectorStore')

    expect(useDirectorStore.getState().scoreThreshold).toBe(8)
  })

  it('visionModel 会持久化并在初始化时恢复', async () => {
    const { useDirectorStore } = await import('../useDirectorStore')
    useDirectorStore.getState().setVisionModel('gemini-3-flash-preview')
    expect(window.localStorage.getItem(VISION_MODEL_KEY)).toBe('gemini-3-flash-preview')

    vi.resetModules()
    const { useDirectorStore: reloadedStore } = await import('../useDirectorStore')
    expect(reloadedStore.getState().visionModel).toBe('gemini-3-flash-preview')
  })

  it('currentRatio 默认 16:9 且会持久化', async () => {
    const { useDirectorStore } = await import('../useDirectorStore')
    expect(useDirectorStore.getState().currentRatio).toBe('16:9')

    useDirectorStore.getState().setRatio('21:9')
    expect(window.localStorage.getItem(RATIO_KEY)).toBe('21:9')

    vi.resetModules()
    const { useDirectorStore: reloadedStore } = await import('../useDirectorStore')
    expect(reloadedStore.getState().currentRatio).toBe('21:9')
  })
})
