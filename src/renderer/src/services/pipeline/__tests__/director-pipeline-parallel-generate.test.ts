import { describe, expect, it } from 'vitest'
import { DirectorPipeline } from '../DirectorPipeline'
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
})

