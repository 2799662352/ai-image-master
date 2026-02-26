import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LangChainDirectorService,
  ShotsResponseSchema,
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

beforeEach(() => {
  mockStructuredInvoke.mockReset()
  mockInvoke.mockReset()
})

describe('Zod Schema Validation', () => {
  it('should validate a well-formed shot', () => {
    const validShot = {
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      spatial: { fg: 'rain-streaked glass', mg: 'woman at table', bg: 'blurred city' },
      action: 'gazes down, bites lower lip',
      light: 'upper-left window, soft, warm 4500K',
      label: '分镜1'
    }
    const result = ShotSchema.safeParse(validShot)
    expect(result.success).toBe(true)
  })

  it('should reject shot missing required field', () => {
    const badShot = {
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      label: '分镜1'
    }
    const result = ShotSchema.safeParse(badShot)
    expect(result.success).toBe(false)
  })

  it('should reject shot with wrong spatial type', () => {
    const badShot = {
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      spatial: 'flat string instead of object',
      action: 'walks forward',
      light: 'natural ambient',
      label: '分镜1'
    }
    const result = ShotSchema.safeParse(badShot)
    expect(result.success).toBe(false)
  })

  it('should validate a full ShotsResponse', () => {
    const response = {
      character_anchor: 'Young woman, black hair, blue eyes',
      shots: [
        {
          kf: 'KF1 - CU - 2s',
          lens: '85mm static',
          spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
          action: 'gazes down',
          light: 'soft warm 4500K',
          label: '分镜1'
        }
      ]
    }
    const result = ShotsResponseSchema.safeParse(response)
    expect(result.success).toBe(true)
  })
})

describe('LangChainDirectorService', () => {
  it('should produce readable natural language from shots', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shots = [
      {
        kf: 'KF1 - CU - 2s',
        lens: '85mm static',
        spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
        action: 'gazes down',
        light: 'warm 4500K',
        label: '分镜1'
      }
    ]
    const nl = service.shotsToNaturalLanguage(shots)
    expect(nl).toContain('KF1 - CU - 2s')
    expect(nl).toContain('85mm static')
    expect(nl).toContain('gazes down')
    expect(nl).not.toContain('{')
    expect(nl).not.toContain('}')
  })

  it('should build compact JSON prompt from ShotsResponse', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shotsResponse = {
      character_anchor: 'Young woman, black hair',
      shots: [
        {
          kf: 'KF1 - CU - 2s',
          lens: '85mm static',
          spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
          action: 'gazes down',
          light: 'warm 4500K',
          label: '分镜1'
        }
      ]
    }
    const result = service.buildFinalPrompt(
      shotsResponse,
      'comp',
      'style',
      'story',
      'constraints'
    )
    const parsed = JSON.parse(result)
    expect(parsed.s).toBe('Young woman, black hair')
    expect(parsed.p[0].l).toBe('85mm static')
    expect(parsed.p[0].sp.fg).toBe('glass')
  })

  it('should include negative field in compact prompt when provided', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shotsResponse = {
      character_anchor: 'Man with hat',
      shots: [{
        kf: 'KF1 - WS - 3s', lens: '24mm static',
        spatial: { fg: 'fence', mg: 'man', bg: 'mountains' },
        action: 'walks', light: 'daylight 5600K', label: '分镜1'
      }]
    }
    const result = service.buildFinalPrompt(shotsResponse, 'comp', 'style', 'story', 'constraints', 'no blur, no text')
    const parsed = JSON.parse(result)
    expect(parsed.n).toBe('no blur, no text')
  })

  it('should omit negative field when not provided', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shotsResponse = {
      character_anchor: 'Man',
      shots: [{
        kf: 'KF1', lens: '50mm', spatial: { fg: 'a', mg: 'b', bg: 'c' },
        action: 'stands', light: 'ambient', label: '分镜1'
      }]
    }
    const result = service.buildFinalPrompt(shotsResponse, 'c', 's', 'd', 'x')
    const parsed = JSON.parse(result)
    expect(parsed.n).toBeUndefined()
  })

  it('should call structuredLlm.invoke when generateShots is called', async () => {
    const mockResponse = {
      character_anchor: 'Test character',
      shots: [{
        kf: 'KF1 - CU - 2s', lens: '85mm static',
        spatial: { fg: 'fg', mg: 'mg', bg: 'bg' },
        action: 'walks', light: 'warm', label: '分镜1'
      }]
    }
    mockStructuredInvoke.mockResolvedValue(mockResponse)

    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const result = await service.generateShots({
      imageAnalysis: 'test analysis', sceneDescription: 'test scene',
      panelCount: 1, layoutRows: 1, layoutCols: 1, layoutRatio: '16:9',
      viewDistribution: 'test', styleInstructions: 'test', additionalRules: '',
      images: [{ base64: 'dGVzdA==', mimeType: 'image/jpeg' }],
      systemPrompt: 'test system prompt'
    })

    expect(mockStructuredInvoke).toHaveBeenCalledOnce()
    expect(result.character_anchor).toBe('Test character')
    expect(result.shots).toHaveLength(1)
  })

  it('should propagate error when generateShots fails', async () => {
    mockStructuredInvoke.mockRejectedValue(new Error('API quota exceeded'))

    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })

    await expect(service.generateShots({
      imageAnalysis: 'a', sceneDescription: 'b', panelCount: 1,
      layoutRows: 1, layoutCols: 1, layoutRatio: '1:1',
      viewDistribution: '', styleInstructions: '', additionalRules: '',
      images: [], systemPrompt: 'sys'
    })).rejects.toThrow('API quota exceeded')
  })

  it('should call llm.invoke and return string from analyzeImage', async () => {
    mockInvoke.mockResolvedValue({ content: 'Detected: woman at table, rainy city background' })

    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const result = await service.analyzeImage([{ base64: 'dGVzdA==', mimeType: 'image/jpeg' }])

    expect(mockInvoke).toHaveBeenCalledOnce()
    expect(result).toBe('Detected: woman at table, rainy city background')
  })

  it('should handle non-string content from analyzeImage', async () => {
    mockInvoke.mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] })

    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const result = await service.analyzeImage([{ base64: 'dGVzdA==', mimeType: 'image/jpeg' }])

    expect(result).toContain('hello')
  })
})

describe('Zod Schema Edge Cases', () => {
  it('should accept ShotsResponse with empty shots array', () => {
    const response = { character_anchor: 'Someone', shots: [] }
    const result = ShotsResponseSchema.safeParse(response)
    expect(result.success).toBe(true)
  })

  it('should reject ShotsResponse missing character_anchor', () => {
    const response = { shots: [{ kf: 'KF1', lens: '50mm', spatial: { fg: 'a', mg: 'b', bg: 'c' }, action: 'x', light: 'y', label: 'z' }] }
    const result = ShotsResponseSchema.safeParse(response)
    expect(result.success).toBe(false)
  })

  it('should reject shot with numeric kf instead of string', () => {
    const badShot = {
      kf: 1, lens: '85mm', spatial: { fg: 'a', mg: 'b', bg: 'c' },
      action: 'walks', light: 'ambient', label: '分镜1'
    }
    const result = ShotSchema.safeParse(badShot)
    expect(result.success).toBe(false)
  })

  it('should accept shot with all optional fields filled', () => {
    const fullShot = {
      kf: 'KF1 - CU - 2s', lens: '85mm static',
      spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
      action: 'gazes down', light: 'warm 4500K', label: '分镜1',
      micro_expression: 'composure -> deep breath -> faint smile',
      color_grade: { dominant: 'warm amber #CBBFA2', accent: 'cool teal #003333', texture: 'bleach bypass' },
      atmosphere: 'thin dust motes in backlight',
      body_physics: '15-degree lean against wind',
      composition: 'leading lines from railings',
      emotion_target: 'quiet relief'
    }
    const result = ShotSchema.safeParse(fullShot)
    expect(result.success).toBe(true)
  })
})

describe('Optional fields integration', () => {
  it('should include optional fields in buildFinalPrompt compact output', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shotsResponse = {
      character_anchor: 'Woman, black hair',
      shots: [{
        kf: 'KF1 - CU - 2s', lens: '85mm', spatial: { fg: 'a', mg: 'b', bg: 'c' },
        action: 'gazes', light: 'warm', label: '分镜1',
        micro_expression: 'composure -> breath -> smile',
        color_grade: { dominant: '#CBBFA2', accent: '#003333', texture: 'matte' },
        atmosphere: 'dust motes',
        body_physics: 'leaning forward',
        composition: 'rule of thirds',
        emotion_target: 'relief'
      }]
    }
    const result = service.buildFinalPrompt(shotsResponse, 'c', 's', 'd', 'x')
    const parsed = JSON.parse(result)
    expect(parsed.p[0].me).toBe('composure -> breath -> smile')
    expect(parsed.p[0].cg.dominant).toBe('#CBBFA2')
    expect(parsed.p[0].atm).toBe('dust motes')
    expect(parsed.p[0].bp).toBe('leaning forward')
    expect(parsed.p[0].comp).toBe('rule of thirds')
    expect(parsed.p[0].em).toBe('relief')
  })

  it('should omit optional fields from compact output when not present', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shotsResponse = {
      character_anchor: 'Man',
      shots: [{
        kf: 'KF1', lens: '50mm', spatial: { fg: 'a', mg: 'b', bg: 'c' },
        action: 'walks', light: 'ambient', label: '分镜1'
      }]
    }
    const result = service.buildFinalPrompt(shotsResponse, 'c', 's', 'd', 'x')
    const parsed = JSON.parse(result)
    expect(parsed.p[0].me).toBeUndefined()
    expect(parsed.p[0].cg).toBeUndefined()
    expect(parsed.p[0].atm).toBeUndefined()
  })

  it('should include optional fields in shotsToNaturalLanguage', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key', baseURL: 'https://api.test.com' })
    const shots = [{
      kf: 'KF1 - CU - 2s', lens: '85mm', spatial: { fg: 'a', mg: 'b', bg: 'c' },
      action: 'gazes', light: 'warm', label: '分镜1',
      micro_expression: 'composure -> smile',
      atmosphere: 'morning haze',
      body_physics: 'leaning into wind'
    }]
    const nl = service.shotsToNaturalLanguage(shots)
    expect(nl).toContain('composure -> smile')
    expect(nl).toContain('morning haze')
    expect(nl).toContain('leaning into wind')
  })
})
