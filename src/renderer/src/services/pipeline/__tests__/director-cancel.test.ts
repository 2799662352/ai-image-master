import { describe, it, expect } from 'vitest'

describe('DirectorPipeline execute with signal and checkpointer', () => {
  it('should have _checkpointer and _currentThreadId fields after buildGraph', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    pipeline.buildGraph()

    expect((pipeline as any)._checkpointer).toBeDefined()
    expect((pipeline as any)._checkpointer).not.toBeNull()
    expect((pipeline as any)._currentThreadId).toBeNull()
  }, 15000)

  it('should have _pauseRequested field defaulting to false', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect((pipeline as any)._pauseRequested).toBe(false)
  }, 15000)
})

describe('PipelineExecuteOptions type', () => {
  it('should export PipelineExecuteOptions with signal field', async () => {
    const types = await import('../types')
    const options: import('../types').PipelineExecuteOptions = {
      signal: new AbortController().signal,
    }
    expect(options.signal).toBeDefined()
  }, 15000)
})
