import { describe, expect, it } from 'vitest'
import { DirectorPipeline, getSemanticOrientationInstruction, shouldRetryAnalysis } from '../DirectorPipeline'
import type { PipelineConfig } from '../types'

describe('DirectorPipeline parallel generate helper', () => {
  it('runWithConcurrency 应按并发上限并行执行', async () => {
    const pipeline = new DirectorPipeline({
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost',
    } satisfies PipelineConfig)

    let active = 0
    let maxActive = 0

    const started = Date.now()
    const results = await (pipeline as any).runWithConcurrency(
      6,
      3,
      async (index: number) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 50))
        active -= 1
        return index
      },
    )
    const elapsed = Date.now() - started

    expect(maxActive).toBeLessThanOrEqual(3)
    expect(maxActive).toBe(3)
    expect(results).toEqual([0, 1, 2, 3, 4, 5])
    // 串行约 300ms，并发 3 理论约 100~170ms，给 CI 留一定抖动余量
    expect(elapsed).toBeLessThan(240)
  })

  it('runWithConcurrency 结果顺序应和输入索引一致', async () => {
    const pipeline = new DirectorPipeline({
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost',
    } satisfies PipelineConfig)

    const results = await (pipeline as any).runWithConcurrency(
      4,
      3,
      async (index: number) => {
        await new Promise((resolve) => setTimeout(resolve, 30 - index * 5))
        return `item-${index}`
      },
    )

    expect(results).toEqual(['item-0', 'item-1', 'item-2', 'item-3'])
  })

  it('semantic orientation instruction should match selected orientation', () => {
    expect(getSemanticOrientationInstruction('portrait')).toContain('portrait')
    expect(getSemanticOrientationInstruction('landscape')).toContain('landscape')
  })

  it('semantic orientation instruction falls back gracefully for undefined', () => {
    const result = getSemanticOrientationInstruction(undefined)
    expect(result).toContain('SEMANTIC ORIENTATION PRIORITY')
    expect(result).toContain('horizontal')
  })

  it('shouldRetryAnalysis returns retry when scene and characters are null', () => {
    expect(shouldRetryAnalysis({ scene: null, characters: null, analysisRetryCount: 0 })).toBe('retry')
  })

  it('shouldRetryAnalysis returns continue when scene has data', () => {
    expect(shouldRetryAnalysis({
      scene: { env: 'forest', subjects: [], style: '', story: '' },
      characters: { characters: [] },
      analysisRetryCount: 0,
    })).toBe('continue')
  })

  it('shouldRetryAnalysis returns abort when max retries exceeded', () => {
    expect(shouldRetryAnalysis({ scene: null, characters: null, analysisRetryCount: 2 })).toBe('abort')
  })

  it('shouldRetryAnalysis returns continue when only characters have data', () => {
    expect(shouldRetryAnalysis({
      scene: null,
      characters: { characters: [{ name: 'hero', anchor: 'red cape' }] },
      analysisRetryCount: 0,
    })).toBe('continue')
  })
})

