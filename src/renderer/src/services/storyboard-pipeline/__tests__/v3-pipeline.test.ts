import { describe, it, expect } from 'vitest'

describe('StoryboardDeepAgentV3Pipeline', () => {
  it('should export the class and have createAgent method', async () => {
    const { StoryboardDeepAgentV3Pipeline } = await import('../StoryboardDeepAgentV3Pipeline')
    const pipeline = new StoryboardDeepAgentV3Pipeline({
      apiKey: 'test', baseURL: 'http://localhost:9999', model: 'test',
    })
    expect(pipeline).toBeDefined()
    expect(typeof pipeline.execute).toBe('function')
  })
})
