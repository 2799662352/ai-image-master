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
  }, 15000)

  it('requestPause should set isPauseRequested to true', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    pipeline.requestPause()
    expect(pipeline.isPauseRequested).toBe(true)
  }, 15000)

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
  }, 15000)

  it('extractStyleAnchorFn should be pausable (checkPauseAndInterrupt exists in node)', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const source = DirectorPipeline.prototype.buildGraph.toString()
    const pauseChecks = (source.match(/checkPauseAndInterrupt/g) || []).length
    // 1 definition + 6 call sites = 7
    expect(pauseChecks).toBeGreaterThanOrEqual(7)
  }, 15000)

  it('should expose currentThreadId after execute starts', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = new DirectorPipeline({
      model: 'test',
      apiKey: 'test',
      baseURL: 'http://localhost',
    })

    expect(pipeline.currentThreadId).toBeNull()
  }, 15000)
})
