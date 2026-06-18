import { describe, it, expect } from 'vitest'
import {
  extractImagesFromApiResponse,
  getDashScopeErrorMessage,
} from '../ApiService'

describe('ApiService wan2.7 response parsing', () => {
  it('extracts single image from DashScope native output.choices', () => {
    const data = {
      output: {
        choices: [{
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: [{
              type: 'image',
              image: 'https://dashscope-result.example.com/a.png?Expires=1',
            }],
          },
        }],
      },
    }
    expect(extractImagesFromApiResponse(data)).toEqual([
      'https://dashscope-result.example.com/a.png?Expires=1',
    ])
  })

  it('extracts all group images from one choice content array (enable_sequential)', () => {
    const urls = [
      'https://dashscope-result.example.com/1.png',
      'https://dashscope-result.example.com/2.png',
      'https://dashscope-result.example.com/3.png',
    ]
    const data = {
      output: {
        choices: [{
          message: {
            content: urls.map((image) => ({ type: 'image', image })),
          },
        }],
      },
    }
    expect(extractImagesFromApiResponse(data)).toEqual(urls)
  })

  it('falls back to metadata when new-api data[] is empty', () => {
    const url = 'https://dashscope-result.example.com/meta.png'
    const data = {
      data: [],
      metadata: {
        output: {
          choices: [{
            message: {
              content: [{ type: 'image', image: url }],
            },
          }],
        },
      },
    }
    expect(extractImagesFromApiResponse(data)).toEqual([url])
  })

  it('parses metadata JSON string from new-api wrapper', () => {
    const url = 'https://dashscope-result.example.com/str.png'
    const metadata = JSON.stringify({
      output: {
        choices: [{
          message: { content: [{ image: url }] },
        }],
      },
    })
    expect(extractImagesFromApiResponse({ data: [], metadata })).toEqual([url])
  })

  it('merges OpenAI data[] with metadata for group images', () => {
    const last = 'https://dashscope-result.example.com/last.png'
    const all = [
      'https://dashscope-result.example.com/1.png',
      'https://dashscope-result.example.com/2.png',
      last,
    ]
    const data = {
      data: [{ url: last }],
      metadata: {
        output: {
          choices: [{
            message: {
              content: all.map((image) => ({ type: 'image', image })),
            },
          }],
        },
      },
    }
    expect(extractImagesFromApiResponse(data)).toEqual(all)
  })

  it('detects DashScope error body on HTTP 200', () => {
    expect(getDashScopeErrorMessage({
      code: 'InvalidParameter',
      message: 'When enable_sequential is False, n must be at most 4, got 10.',
    })).toBe('InvalidParameter: When enable_sequential is False, n must be at most 4, got 10.')
  })
})

describe('ApiService wan2.7 request payload', () => {
  it('builds input.messages + parameters.enable_sequential for group count', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('wan2.7-image-pro')!

    const payload = (service as any).buildOpenAIPayload({
      prompt: '测试组图',
      model: 'wan2.7-image-pro',
      ratio: '1:1',
      resolution: '2K',
      count: 3,
      modelConfig: cfg,
    })

    expect(payload.n).toBe(3)
    expect(payload.parameters).toMatchObject({
      n: 3,
      enable_sequential: true,
      size: '2K',
    })
    expect(payload.input).toEqual({
      messages: [{
        role: 'user',
        content: [{ text: '测试组图' }],
      }],
    })
    expect(payload.image).toBeUndefined()
  })

  it('maps wan2.7 5:4 / 4:5 ratio to pixel size (newly added mapping, * separator)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('wan2.7-image-pro')!

    const wide = (service as any).buildOpenAIPayload({
      prompt: '横版', model: 'wan2.7-image-pro', ratio: '5:4', resolution: '2K', count: 1, modelConfig: cfg,
    })
    expect(wide.size).toBe('2240x1792')
    expect(wide.parameters.size).toBe('2240*1792')

    const tall = (service as any).buildOpenAIPayload({
      prompt: '竖版', model: 'wan2.7-image-pro', ratio: '4:5', resolution: '2K', count: 1, modelConfig: cfg,
    })
    expect(tall.size).toBe('1792x2240')
    expect(tall.parameters.size).toBe('1792*2240')
  })

  it('clamps 4K → 2K for sequential group (doc: 组图 caps at 2K)', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('wan2.7-image-pro')!

    const payload = (service as any).buildOpenAIPayload({
      prompt: '四季组图', model: 'wan2.7-image-pro', ratio: '16:9', resolution: '4K', count: 4, modelConfig: cfg,
    })
    expect(payload.parameters.enable_sequential).toBe(true)
    // 16:9 at 2K (downgraded from 4K), not 4K pixels
    expect(payload.size).toBe('2560x1440')
    expect(payload.parameters.size).toBe('2560*1440')
  })

  it('builds input.messages with reference images for edit', async () => {
    const { ApiService } = await import('../ApiService')
    const service = new ApiService()
    const cfg = service.getModelConfig('wan2.7-image-pro')!

    const ref = 'data:image/png;base64,abc'
    const payload = (service as any).buildOpenAIPayload({
      prompt: '把背景改成夜景',
      model: 'wan2.7-image-pro',
      ratio: '1:1',
      resolution: '2K',
      referenceImages: [ref],
      count: 1,
      modelConfig: cfg,
    })

    expect(payload.input.messages[0].content).toEqual([
      { image: ref },
      { text: '把背景改成夜景' },
    ])
    expect(payload.parameters.thinking_mode).toBeUndefined()
    expect(payload.image).toBeUndefined()
  })
})
