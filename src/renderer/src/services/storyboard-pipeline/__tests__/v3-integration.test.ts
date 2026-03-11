import { describe, it, expect, vi } from 'vitest'

vi.mock('deepagents', () => ({
  createDeepAgent: vi.fn().mockReturnValue({
    invoke: vi.fn().mockResolvedValue({
      messages: [{ role: 'assistant', content: 'Analysis complete.' }],
      todos: [
        { content: 'Analyze scene', status: 'completed' },
        { content: 'Extract characters', status: 'completed' },
      ],
      files: {
        '/shared/scene.json': { content: '{"d":"A→B→C","cap":"test","env":"arena"}' },
        '/shared/merged-chars.json': { content: '{"objs":[{"n":"knight","f":"armor","t":"visor","s":"fg","p":"artic","a":"","m":"","act":"swing","fx":null,"motive":"honor","tc":""}]}' },
        '/shared/shots.json': { content: '{"seq":[{"id":"S1","desc":"Wide shot"}],"cont":"armor","notes":"ok"}' },
      },
    }),
    stream: vi.fn().mockReturnValue((async function* () {
      yield { type: 'updates', ns: [], data: { tools: { messages: [{ name: 'write_todos', content: '' }] } } }
    })()),
  }),
}))

describe('StoryboardDeepAgentV3Pipeline integration', () => {
  it('should assemble StoryboardResponse from agent state files (content property)', async () => {
    const { StoryboardDeepAgentV3Pipeline } = await import('../StoryboardDeepAgentV3Pipeline')
    const pipeline = new StoryboardDeepAgentV3Pipeline({
      apiKey: 'test', baseURL: 'http://localhost:9999', model: 'test',
    })

    const result = pipeline.assembleResult({
      files: {
        '/shared/scene.json': { content: '{"d":"A→B→C","cap":"test","env":"arena"}' },
        '/shared/merged-chars.json': { content: '{"objs":[{"n":"knight","f":"armor","t":"visor"}]}' },
        '/shared/shots.json': { content: '{"seq":[{"id":"S1","desc":"Wide shot"}],"cont":"armor","notes":"ok"}' },
      },
    })

    expect(result).toEqual(expect.objectContaining({
      scene: expect.objectContaining({ d: 'A→B→C' }),
      objs: expect.arrayContaining([expect.objectContaining({ n: 'knight' })]),
      seq: expect.arrayContaining([expect.objectContaining({ id: 'S1' })]),
    }))
  })

  it('should assemble StoryboardResponse from raw string files', async () => {
    const { StoryboardDeepAgentV3Pipeline } = await import('../StoryboardDeepAgentV3Pipeline')
    const pipeline = new StoryboardDeepAgentV3Pipeline({
      apiKey: 'test', baseURL: 'http://localhost:9999', model: 'test',
    })

    const result = pipeline.assembleResult({
      files: {
        '/shared/scene.json': '{"d":"A→B→C","cap":"test","env":"arena","bgm":"wind"}',
        '/shared/merged-chars.json': '{"objs":[{"n":"knight","f":"armor","t":"visor","s":"fg|center|Z1","p":"artic","a":"","m":"","act":"swing","fx":null,"motive":"honor","tc":"S1→S2: gaze"}]}',
        '/shared/shots.json': '{"seq":[{"id":"S1","desc":"Wide shot","act":"enters","motive":"resolve"}],"cont":"armor visor","notes":"pacing ok"}',
      },
    })

    expect(result.scene.d).toBe('A→B→C')
    expect(result.scene.bgm).toBe('wind')
    expect(result.objs).toHaveLength(1)
    expect(result.objs[0].n).toBe('knight')
    expect(result.objs[0].s).toBe('fg|center|Z1')
    expect(result.objs[0].act).toBe('swing')
    expect(result.objs[0].fx).toBeNull()
    expect(result.seq).toHaveLength(1)
    expect(result.seq[0].id).toBe('S1')
    expect(result.cont).toBe('armor visor')
    expect(result.notes).toBe('pacing ok')
  })

  it('should handle content as string[] (StateBackend format)', async () => {
    const { StoryboardDeepAgentV3Pipeline } = await import('../StoryboardDeepAgentV3Pipeline')
    const pipeline = new StoryboardDeepAgentV3Pipeline({
      apiKey: 'test', baseURL: 'http://localhost:9999', model: 'test',
    })

    const result = pipeline.assembleResult({
      files: {
        '/shared/scene.json': { content: ['{"d":"arc","cap":"c",', '"env":"e","bgm":"b"}'] },
        '/shared/merged-chars.json': { content: ['{"objs":[{"n":"hero","f":"f","t":"t"}]}'] },
        '/shared/shots.json': { content: ['{"seq":[{"id":"S1",', '"desc":"d"}],', '"cont":"c","notes":"n"}'] },
      },
    })

    expect(result.scene.d).toBe('arc')
    expect(result.objs[0].n).toBe('hero')
    expect(result.seq[0].id).toBe('S1')
  })

  it('should handle empty state gracefully', async () => {
    const { StoryboardDeepAgentV3Pipeline } = await import('../StoryboardDeepAgentV3Pipeline')
    const pipeline = new StoryboardDeepAgentV3Pipeline({
      apiKey: 'test', baseURL: 'http://localhost:9999', model: 'test',
    })

    const result = pipeline.assembleResult({})

    expect(result.scene.d).toBe('')
    expect(result.objs).toEqual([])
    expect(result.seq).toEqual([])
    expect(result.cont).toBe('')
    expect(result.notes).toBe('')
  })
})
