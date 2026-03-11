import { describe, it, expect, vi } from 'vitest'
import {
  sceneAnalyzerSubAgent,
  charIdentitySubAgent,
  charSpatialSubAgent,
  charNarrativeSubAgent,
  charMergeSubAgent,
} from '../StoryboardDeepAgentPipeline'

function createMockLLM(parsedResponse: any) {
  const mockStructuredLLM = {
    invoke: vi.fn().mockResolvedValue(parsedResponse),
  }
  return {
    withStructuredOutput: vi.fn().mockReturnValue(mockStructuredLLM),
    _structuredLLM: mockStructuredLLM,
  }
}

describe('sceneAnalyzerSubAgent', () => {
  it('returns scene JSON and writes to sharedFiles', async () => {
    const mockLLM = createMockLLM({
      d: 'A→B→C arc',
      cap: 'Knight standing in cathedral',
      env: 'Gothic interior, candlelight',
      bgm: '',
      shotCount: 4,
    })

    const result = await sceneAnalyzerSubAgent({
      inputImages: [],
      userContext: 'test',
      taskPlan: 'test plan',
      llm: mockLLM as any,
      systemPrompt: 'You are a scene analyzer',
    })

    expect(result.scene).toBeDefined()
    expect(result.scene.d).toBe('A→B→C arc')
    expect(result.sharedFileContent).toContain('"d"')
  })
})

describe('charIdentitySubAgent', () => {
  it('extracts character anchors and writes to sharedFiles', async () => {
    const mockLLM = createMockLLM({
      objs: [{ n: 'the butler', f: 'grey suit, monocle', t: 'monocle on left eye' }],
    })

    const result = await charIdentitySubAgent({
      inputImages: [],
      taskPlan: '',
      llm: mockLLM as any,
      systemPrompt: 'You extract identities',
    })

    expect(result.anchors).toHaveLength(1)
    expect(result.anchors[0].n).toBe('the butler')
    expect(result.sharedFileContent).toContain('"the butler"')
  })
})

describe('charSpatialSubAgent', () => {
  it('uses exact anchor names in user message to prevent name drift', async () => {
    const invokedMessages: any[] = []
    const mockStructuredLLM = {
      invoke: vi.fn().mockImplementation((msgs: any) => {
        invokedMessages.push(msgs)
        return Promise.resolve({
          objs: [{ n: 'the butler', s: 'fg|center|Z1', p: 'artic', a: '', m: '' }],
        })
      }),
    }
    const mockLLM = {
      withStructuredOutput: vi.fn().mockReturnValue(mockStructuredLLM),
    }

    await charSpatialSubAgent({
      inputImages: [],
      anchors: [{ n: 'the butler', f: 'grey suit', t: 'monocle' }],
      llm: mockLLM as any,
      systemPrompt: 'You extract spatial data',
    })

    const userContent = invokedMessages[0][1].content
    const textPart = userContent.find((c: any) => c.type === 'text')
    expect(textPart.text).toContain('"the butler"')
  })
})

describe('charNarrativeSubAgent', () => {
  it('uses exact anchor names and extracts narrative data', async () => {
    const invokedMessages: any[] = []
    const mockStructuredLLM = {
      invoke: vi.fn().mockImplementation((msgs: any) => {
        invokedMessages.push(msgs)
        return Promise.resolve({
          objs: [{ n: 'the butler', act: 'adjusts monocle', fx: null, motive: 'nervous precision', tc: 'gaze left→right' }],
        })
      }),
    }
    const mockLLM = {
      withStructuredOutput: vi.fn().mockReturnValue(mockStructuredLLM),
    }

    const result = await charNarrativeSubAgent({
      inputImages: [],
      anchors: [{ n: 'the butler', f: 'grey suit', t: 'monocle' }],
      llm: mockLLM as any,
      systemPrompt: 'You extract narrative data',
    })

    expect(result.narrativeData).toHaveLength(1)
    expect(result.narrativeData[0].act).toBe('adjusts monocle')
    const userContent = invokedMessages[0][1].content
    const textPart = userContent.find((c: any) => c.type === 'text')
    expect(textPart.text).toContain('"the butler"')
  })
})

describe('charMergeSubAgent', () => {
  it('merges spatial + narrative data using fuzzy name matching', () => {
    const anchors = [{ n: 'knight', f: 'armored', t: 'silver helm' }]
    const spatial = [{ n: 'the knight', s: 'fg', p: 'artic', a: '', m: '' }]
    const narrative = [{ n: 'armored knight', act: 'raises sword', fx: null, motive: 'courage', tc: 'gaze left' }]

    const merged = charMergeSubAgent(anchors, spatial, narrative)

    expect(merged).toHaveLength(1)
    expect(merged[0].n).toBe('knight')
    expect(merged[0].s).toBe('fg')
    expect(merged[0].act).toBe('raises sword')
    expect(merged[0].motive).toBe('courage')
  })

  it('handles exact name match', () => {
    const anchors = [{ n: 'alice', f: 'blue dress', t: 'headband' }]
    const spatial = [{ n: 'alice', s: 'fg|L1/3|Z1', p: 'artic', a: 'standing', m: '' }]
    const narrative = [{ n: 'alice', act: 'looks up', fx: null, motive: 'wonder', tc: '' }]

    const merged = charMergeSubAgent(anchors, spatial, narrative)
    expect(merged).toHaveLength(1)
    expect(merged[0].s).toBe('fg|L1/3|Z1')
    expect(merged[0].act).toBe('looks up')
  })

  it('returns defaults when no spatial/narrative match is found', () => {
    const anchors = [{ n: 'mystery figure', f: 'cloaked', t: 'red gem' }]
    const spatial: any[] = []
    const narrative: any[] = []

    const merged = charMergeSubAgent(anchors, spatial, narrative)
    expect(merged).toHaveLength(1)
    expect(merged[0].s).toBe('fg|center|Z1')
    expect(merged[0].act).toBe('')
  })
})
