// tests/services/Api.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ApiService, createApiService } from '../../src/renderer/src/services/api'

describe('ApiService', () => {
  let apiService: ApiService

  beforeEach(() => {
    localStorage.clear()
    apiService = createApiService()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('应该使用默认站点', () => {
      const site = apiService.getCurrentSite()
      
      expect(site).toBeDefined()
      expect(site?.baseURL).toContain('apiyi.com')
    })
  })

  describe('setSite', () => {
    it('应该切换到有效站点', () => {
      const result = apiService.setSite('b-apiyi')
      
      expect(result).toBe(true)
    })

    it('应该拒绝无效站点', () => {
      const result = apiService.setSite('nonexistent')
      
      expect(result).toBe(false)
    })
  })

  describe('setModel', () => {
    it('应该切换到有效模型', () => {
      const result = apiService.setModel('gemini-3-pro-image-preview')
      
      expect(result).toBe(true)
    })

    it('应该拒绝无效模型', () => {
      const result = apiService.setModel('nonexistent')
      
      expect(result).toBe(false)
    })
  })

  describe('saveApiKey', () => {
    it('应该保存 API Key', () => {
      const result = apiService.saveApiKey('test-key-123')
      
      expect(result).toBe(true)
      expect(apiService.hasApiKey()).toBe(true)
    })
  })

  describe('hasApiKey', () => {
    it('应该返回 false 如果没有 API Key', () => {
      expect(apiService.hasApiKey()).toBe(false)
    })

    it('应该返回 true 如果有 API Key', () => {
      apiService.saveApiKey('test-key')
      
      expect(apiService.hasApiKey()).toBe(true)
    })
  })

  describe('getCurrentModel', () => {
    it('应该返回当前模型配置', () => {
      const model = apiService.getCurrentModel()
      
      expect(model).toBeDefined()
      expect(model?.name).toBeDefined()
    })
  })

  describe('getAllModels', () => {
    it('应该返回所有模型', () => {
      const models = apiService.getAllModels()
      
      expect(Object.keys(models).length).toBeGreaterThan(0)
    })
  })

  describe('getAllSites', () => {
    it('应该返回所有站点', () => {
      const sites = apiService.getAllSites()
      
      expect(Object.keys(sites).length).toBeGreaterThan(0)
      expect(sites['b-apiyi']).toBeDefined()
    })
  })

  describe('getModelCapabilities', () => {
    it('应该返回模型能力', () => {
      const capabilities = apiService.getModelCapabilities('gemini-3-pro-image-preview')
      
      expect(capabilities).toBeDefined()
      expect(typeof capabilities?.referenceImage).toBe('boolean')
    })
  })

  describe('generateImage', () => {
    it('应该返回错误如果没有 API Key', async () => {
      const result = await apiService.generateImage({
        prompt: 'test prompt'
      })
      
      expect(result.success).toBe(false)
      expect(result.error).toContain('API Key')
    })

    it('应该发起 API 请求', async () => {
      apiService.saveApiKey('test-key')
      
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  mimeType: 'image/png',
                  data: 'base64ImageData'
                }
              }]
            }
          }]
        })
      })
      
      const result = await apiService.generateImage({
        prompt: 'a beautiful cat'
      })
      
      expect(global.fetch).toHaveBeenCalled()
      expect(result.success).toBe(true)
      expect(result.images?.length).toBeGreaterThan(0)
    })

    it('应该处理 API 错误', async () => {
      apiService.saveApiKey('test-key')
      
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({
          error: { message: 'Unauthorized' }
        })
      })
      
      const result = await apiService.generateImage({
        prompt: 'test'
      })
      
      expect(result.success).toBe(false)
      expect(result.error).toContain('Unauthorized')
    })
  })
})
