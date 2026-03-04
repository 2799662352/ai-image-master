import { describe, it, expect } from 'vitest'

describe('DirectorPipeline resume', () => {
  it('should expose resume method', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(typeof pipeline.resume).toBe('function')
  }, 15000)

  it('should throw if no currentThreadId (never executed)', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    await expect(pipeline.resume()).rejects.toThrow('没有可恢复的暂停状态')
  }, 15000)
})
