// src/renderer/src/services/api/ApiService.ts
/**
 * API 调用模块
 * 处理与 AI 图片生成 API 的所有通信
 */

export interface ApiSite {
  name: string
  baseURL: string
  description: string
  authType: 'bearer' | 'x-api-key'
  pathPrefix?: string
  defaultApiKey?: string
  isBuiltIn?: boolean
}

export interface ModelConfig {
  name: string
  displayName: string
  time?: string
  isNew?: boolean
  baseURL?: string
  apiType?: 'gemini-native' | 'openai' | 'flux'
  internalPrompt?: string
  ratios?: RatioOption[]
  capabilities?: ModelCapabilities
}

export interface RatioOption {
  key: string
  label: string
  description?: string
}

export interface ModelCapabilities {
  multipleImages: boolean
  customSize: boolean
  aspectRatioControl: boolean
  referenceImage: boolean
  imageEdit: boolean
  intelligentResize?: boolean
}

export interface GenerateImageParams {
  prompt: string
  model?: string
  ratio?: string
  resolution?: string
  referenceImages?: string[]
  negativePrompt?: string
  count?: number
}

export interface GenerateResult {
  success: boolean
  images?: string[]
  error?: string
  rawResponse?: any
}

// 内置站点配置
const BUILT_IN_SITES: Record<string, ApiSite> = {
  'apiyi': {
    name: 'API易官方',
    baseURL: 'https://api.apiyi.com',
    description: '官方站点，稳定可靠',
    authType: 'bearer',
    isBuiltIn: true
  },
  'b-apiyi': {
    name: 'API易 B站',
    baseURL: 'https://b.apiyi.com',
    description: 'API易 B站端点',
    authType: 'bearer',
    isBuiltIn: true
  }
}

// 默认模型配置
const DEFAULT_MODELS: Record<string, ModelConfig> = {
  'gemini-3-pro-image-preview': {
    name: '🍌 Nano Banana Pro',
    displayName: 'Gemini 3 Pro Image Preview',
    time: '60s',
    isNew: true,
    apiType: 'gemini-native',
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true
    }
  }
}

export class ApiService {
  private apiSites: Record<string, ApiSite>
  private customSites: Record<string, ApiSite>
  private models: Record<string, ModelConfig>
  private currentSite: string
  private currentModel: string
  private apiKey: string | null
  private visionApiKey: string | null

  constructor() {
    this.customSites = this.loadCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }
    this.models = { ...DEFAULT_MODELS }
    this.currentSite = this.getStoredSite() || 'b-apiyi'
    this.currentModel = this.getStoredModel() || 'gemini-3-pro-image-preview'
    this.apiKey = this.getStoredApiKey(this.currentSite)
    this.visionApiKey = this.getStoredVisionApiKey(this.currentSite)
  }

  /**
   * 生成图片
   */
  async generateImage(params: GenerateImageParams): Promise<GenerateResult> {
    const { prompt, model, ratio, resolution, referenceImages, count = 1 } = params

    if (!this.apiKey) {
      return { success: false, error: '请先设置 API Key' }
    }

    const modelConfig = this.models[model || this.currentModel]
    const site = this.apiSites[this.currentSite]

    try {
      const response = await this.makeApiRequest({
        prompt,
        model: model || this.currentModel,
        ratio,
        resolution,
        referenceImages,
        count,
        modelConfig,
        site
      })

      return this.parseResponse(response, modelConfig)
    } catch (error) {
      console.error('生成图片失败:', error)
      return {
        success: false,
        error: (error as Error).message || '生成图片失败'
      }
    }
  }

  /**
   * 发起 API 请求
   */
  private async makeApiRequest(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    count: number
    modelConfig: ModelConfig
    site: ApiSite
  }): Promise<Response> {
    const { prompt, model, ratio, referenceImages, modelConfig, site } = options

    const url = modelConfig.baseURL || `${site.baseURL}/v1/chat/completions`
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (site.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else {
      headers['x-api-key'] = this.apiKey!
    }

    const body = this.buildRequestBody({
      prompt,
      model,
      ratio,
      referenceImages,
      modelConfig
    })

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    })
  }

  /**
   * 构建请求体
   */
  private buildRequestBody(options: {
    prompt: string
    model: string
    ratio?: string
    referenceImages?: string[]
    modelConfig: ModelConfig
  }): any {
    const { prompt, model, ratio, referenceImages, modelConfig } = options

    // 根据 API 类型构建不同的请求体
    if (modelConfig.apiType === 'gemini-native') {
      return {
        contents: [{
          parts: [
            { text: `${modelConfig.internalPrompt || ''}${prompt}` },
            ...(referenceImages || []).map(img => ({
              inline_data: {
                mime_type: 'image/png',
                data: img.replace(/^data:image\/\w+;base64,/, '')
              }
            }))
          ]
        }],
        generationConfig: {
          responseModalities: ['image', 'text'],
          ...(ratio && ratio !== 'auto' ? { aspectRatio: ratio } : {})
        }
      }
    }

    // OpenAI 兼容格式
    return {
      model,
      messages: [
        {
          role: 'user',
          content: referenceImages?.length
            ? [
                { type: 'text', text: prompt },
                ...referenceImages.map(img => ({
                  type: 'image_url',
                  image_url: { url: img }
                }))
              ]
            : prompt
        }
      ]
    }
  }

  /**
   * 解析响应
   */
  private parseResponse(response: Response, _modelConfig: ModelConfig): Promise<GenerateResult> {
    return response.json().then(data => {
      if (!response.ok) {
        return {
          success: false,
          error: data.error?.message || `API 错误: ${response.status}`,
          rawResponse: data
        }
      }

      // 解析图片 URL
      const images = this.extractImages(data)
      
      if (images.length === 0) {
        return {
          success: false,
          error: '未能从响应中提取图片',
          rawResponse: data
        }
      }

      return {
        success: true,
        images,
        rawResponse: data
      }
    })
  }

  /**
   * 从响应中提取图片
   */
  private extractImages(data: any): string[] {
    const images: string[] = []

    // Gemini 格式
    if (data.candidates) {
      for (const candidate of data.candidates) {
        if (candidate.content?.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData?.data) {
              images.push(`data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`)
            }
          }
        }
      }
    }

    // OpenAI 格式
    if (data.data) {
      for (const item of data.data) {
        if (item.url) images.push(item.url)
        if (item.b64_json) images.push(`data:image/png;base64,${item.b64_json}`)
      }
    }

    return images
  }

  /**
   * 切换站点
   */
  setSite(siteKey: string): boolean {
    if (!this.apiSites[siteKey]) {
      return false
    }
    this.currentSite = siteKey
    this.saveStoredSite(siteKey)
    this.apiKey = this.getStoredApiKey(siteKey)
    return true
  }

  /**
   * 切换模型
   */
  setModel(modelKey: string): boolean {
    if (!this.models[modelKey]) {
      return false
    }
    this.currentModel = modelKey
    this.saveStoredModel(modelKey)
    return true
  }

  /**
   * 保存 API Key
   */
  saveApiKey(key: string): boolean {
    try {
      this.apiKey = key
      localStorage.setItem(`api_key_${this.currentSite}`, key)
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取当前模型
   */
  getCurrentModel(): ModelConfig | undefined {
    return this.models[this.currentModel]
  }

  /**
   * 获取所有模型
   */
  getAllModels(): Record<string, ModelConfig> {
    return { ...this.models }
  }

  /**
   * 获取当前站点
   */
  getCurrentSite(): ApiSite | undefined {
    return this.apiSites[this.currentSite]
  }

  /**
   * 获取所有站点
   */
  getAllSites(): Record<string, ApiSite> {
    return { ...this.apiSites }
  }

  // 存储相关方法
  private getStoredSite(): string | null {
    return localStorage.getItem('current_site')
  }

  private saveStoredSite(site: string): void {
    localStorage.setItem('current_site', site)
  }

  private getStoredModel(): string | null {
    return localStorage.getItem('current_model')
  }

  private saveStoredModel(model: string): void {
    localStorage.setItem('current_model', model)
  }

  private getStoredApiKey(site: string): string | null {
    return localStorage.getItem(`api_key_${site}`)
  }

  private getStoredVisionApiKey(site: string): string | null {
    return localStorage.getItem(`vision_api_key_${site}`)
  }

  private loadCustomSites(): Record<string, ApiSite> {
    try {
      const stored = localStorage.getItem('custom_sites')
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  }

  /**
   * 检查是否已配置 API Key
   */
  hasApiKey(): boolean {
    return !!this.apiKey
  }

  /**
   * 获取模型能力
   */
  getModelCapabilities(modelKey?: string): ModelCapabilities | undefined {
    const model = this.models[modelKey || this.currentModel]
    return model?.capabilities
  }
}

// 创建单例
let instance: ApiService | null = null

export function getApiService(): ApiService {
  if (!instance) {
    instance = new ApiService()
  }
  return instance
}

export function createApiService(): ApiService {
  return new ApiService()
}

/**
 * 重置单例（仅用于测试）
 */
export function resetApiService(): void {
  instance = null
}

// ========================================
// V16.2 C2 - 过渡期 window 暴露
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    api: ApiService
    apiTS: ApiService
    ApiServiceTS: typeof ApiService
  }
}

let apiDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initApiServiceGlobal(): ApiService {
  const service = getApiService()

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'api', {
      get() {
        if (!apiDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.api 已废弃。' +
            '请使用 Services.get("api") 或 import { getApiService } from "@/services/api"'
          )
          apiDeprecationWarningShown = true
        }
        return service
      },
      configurable: true
    })
    
    window.apiTS = service
    window.ApiServiceTS = ApiService
  }

  console.log('[V16.3] ApiService TypeScript 版本已加载 (废弃警告已启用)')

  return service
}
