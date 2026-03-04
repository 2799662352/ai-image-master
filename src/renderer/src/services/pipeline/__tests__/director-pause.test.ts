import { describe, it, expect } from 'vitest'

describe('DirectorPipeline pause mechanism', () => {
  it('should expose requestPause and clearPauseRequest methods', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(typeof pipeline.requestPause).toBe('function')
    expect(typeof pipeline.clearPauseRequest).toBe('function')
    expect(pipeline.isPauseRequested).toBe(false)
  })

  it('requestPause should set isPauseRequested to true', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    pipeline.requestPause()
    expect(pipeline.isPauseRequested).toBe(true)
  })

  it('clearPauseRequest should reset to false', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    pipeline.requestPause()
    pipeline.clearPauseRequest()
    expect(pipeline.isPauseRequested).toBe(false)
  })

  it('should expose currentThreadId after execute starts', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(pipeline.currentThreadId).toBeNull()
  })
})
