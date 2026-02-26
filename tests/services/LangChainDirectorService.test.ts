import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LangChainDirectorService,
  SceneResponseSchema,
  ShotSchema
} from '../../src/renderer/src/services/LangChainDirectorService'

const mockStructuredInvoke = vi.fn()
const mockInvoke = vi.fn()

vi.mock('@langchain/openai', () => {
  const MockChatOpenAI = function () {
    this.invoke = mockInvoke
    this.withStructuredOutput = vi.fn().mockReturnValue({ invoke: mockStructuredInvoke })
  }
  return { ChatOpenAI: MockChatOpenAI }
})

const NULL_FIELDS = {
  micro_expression: null,
  color_grade: null,
  atmosphere: null,
  body_physics: null,
  composition: null,
  emotion_target: null,
  seq: null,
  motion: null
} as const

const SCENE_FIELDS = {
  scene: {
    d: 'setup → build → payoff',
    cap: 'test-subject-action-env',
    env: 'interior, warm light',
    bgm: { base: 'ambient drone', env: 'rain', action: 'footsteps', melody: 'sparse piano' },
    tension: 'test dramatic tension',
    shot_flow: 'S1 establishing → S2 close-up'
  },
  objs: [{ n: 'test character', f: 'black hair, red dress, articulated biped', s: 'MG center', psych: null }],
  notes: null
} as const

const makeShot = (overrides = {}) => ({
  kf: 'KF1 - CU - 2s',
  lens: '85mm static',
  spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
  action: 'gazes down, slight lean forward',
  light: 'warm 4500K, upper-left window',
  label: '分镜1',
  ...NULL_FIELDS,
  ...overrides
})

const makeResponse = (overrides = {}) => ({
  ...SCENE_FIELDS,
  character_anchor: 'Young woman, black hair',
  shots: [makeShot()],
  ...overrides
})

beforeEach(() => {
  mockStructuredInvoke.mockReset()
  mockInvoke.mockReset()
})

describe('Zod Schema Validation', () => {
  it('should validate a well-formed shot', () => {
    const result = ShotSchema.safeParse(makeShot({
      micro_expression: 'composure -> breath -> smile',
      atmosphere: 'thin dust motes'
    }))
    expect(result.success).toBe(true)
  })

  it('should reject shot missing required field (spatial)', () => {
    const { spatial, ...noSpatial } = makeShot()
    const result = ShotSchema.safeParse(noSpatial)
    expect(result.success).toBe(false)
  })

  it('should reject shot with wrong spatial type', () => {
    const result = ShotSchema.safeParse(makeShot({ spatial: 'flat string' }))
    expect(result.success).toBe(false)
  })

  it('should validate a full SceneResponse', () => {
    const result = SceneResponseSchema.safeParse(makeResponse())
    expect(result.success).toBe(true)
  })

  it('should reject shot with undefined for nullable field', () => {
    const result = ShotSchema.safeParse(makeShot({ micro_expression: undefined }))
    expect(result.success).toBe(false)
  })
})

describe('LangChainDirectorService', () => {
  it('should produce readable natural language from shots', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const nl = service.shotsToNaturalLanguage([makeShot()])
    expect(nl).toContain('KF1 - CU - 2s')
    expect(nl).toContain('85mm static')
    expect(nl).toContain('gazes down')
    expect(nl).not.toContain('{')
  })

  it('should build compact JSON prompt from SceneResponse', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = service.buildFinalPrompt(makeResponse(), 'grid', 'style', 'story', 'constraints')
    const parsed = JSON.parse(result)
    expect(parsed.scene.d).toBe('setup → build → payoff')
    expect(parsed.scene.shot_flow).toContain('S1')
    expect(parsed.objs[0].n).toBe('test character')
    expect(parsed.s).toBe('Young woman, black hair')
    expect(parsed.p[0].l).toBe('85mm static')
    expect(parsed.p[0].sp.fg).toBe('glass')
  })

  it('should include negative field when provided', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = service.buildFinalPrompt(makeResponse(), 'g', 's', 'd', 'x', 'no blur')
    expect(JSON.parse(result).n).toBe('no blur')
  })

  it('should omit negative when not provided', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = service.buildFinalPrompt(makeResponse(), 'g', 's', 'd', 'x')
    expect(JSON.parse(result).n).toBeUndefined()
  })

  it('should call structuredLlm.invoke when generateShots is called', async () => {
    mockStructuredInvoke.mockResolvedValue(makeResponse())
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = await service.generateShots({
      imageAnalysis: 'test', sceneDescription: 'test', panelCount: 1,
      layoutRows: 1, layoutCols: 1, layoutRatio: '16:9',
      viewDistribution: 'test', styleInstructions: 'test', additionalRules: '',
      images: [{ base64: 'dGVzdA==', mimeType: 'image/jpeg' }],
      systemPrompt: 'test'
    })
    expect(mockStructuredInvoke).toHaveBeenCalledOnce()
    expect(result.character_anchor).toBe('Young woman, black hair')
    expect(result.shots).toHaveLength(1)
    expect(result.scene.d).toBe('setup → build → payoff')
  })

  it('should propagate error when generateShots fails', async () => {
    mockStructuredInvoke.mockRejectedValue(new Error('API quota exceeded'))
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    await expect(service.generateShots({
      imageAnalysis: 'a', sceneDescription: 'b', panelCount: 1,
      layoutRows: 1, layoutCols: 1, layoutRatio: '1:1',
      viewDistribution: '', styleInstructions: '', additionalRules: '',
      images: [], systemPrompt: 'sys'
    })).rejects.toThrow('API quota exceeded')
  })

  it('should return string from analyzeImage', async () => {
    mockInvoke.mockResolvedValue({ content: 'woman at table, rainy city' })
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = await service.analyzeImage([{ base64: 'dGVzdA==', mimeType: 'image/jpeg' }])
    expect(result).toBe('woman at table, rainy city')
  })

  it('should handle non-string content from analyzeImage', async () => {
    mockInvoke.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] })
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = await service.analyzeImage([{ base64: 'dGVzdA==', mimeType: 'image/jpeg' }])
    expect(result).toContain('hello')
  })
})

describe('Schema Edge Cases', () => {
  it('should accept SceneResponse with empty shots array', () => {
    const result = SceneResponseSchema.safeParse(makeResponse({ shots: [] }))
    expect(result.success).toBe(true)
  })

  it('should reject SceneResponse missing character_anchor', () => {
    const { character_anchor, ...noAnchor } = makeResponse()
    const result = SceneResponseSchema.safeParse(noAnchor)
    expect(result.success).toBe(false)
  })

  it('should reject shot with numeric kf', () => {
    const result = ShotSchema.safeParse(makeShot({ kf: 1 }))
    expect(result.success).toBe(false)
  })
})

describe('Optional fields', () => {
  it('should include filled nullable fields in compact output', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const resp = makeResponse({
      shots: [makeShot({ micro_expression: 'composure -> smile', atmosphere: 'dust motes' })]
    })
    const result = service.buildFinalPrompt(resp, 'g', 's', 'd', 'x')
    const parsed = JSON.parse(result)
    expect(parsed.p[0].me).toBe('composure -> smile')
    expect(parsed.p[0].atm).toBe('dust motes')
  })

  it('should omit null fields from compact output', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = service.buildFinalPrompt(makeResponse(), 'g', 's', 'd', 'x')
    const parsed = JSON.parse(result)
    expect(parsed.p[0].me).toBeUndefined()
    expect(parsed.p[0].atm).toBeUndefined()
  })

  it('should include nullable fields in natural language output', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const nl = service.shotsToNaturalLanguage([
      makeShot({ micro_expression: 'composure -> smile', atmosphere: 'morning haze' })
    ])
    expect(nl).toContain('composure -> smile')
    expect(nl).toContain('morning haze')
  })
})
