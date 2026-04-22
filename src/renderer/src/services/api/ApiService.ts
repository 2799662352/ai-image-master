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

export interface ResolutionOption {
  key: string
  label: string
  description?: string
}

export interface ModelConfig {
  name: string
  displayName: string
  time?: string
  isNew?: boolean
  baseURL?: string
  apiType?: 'gemini-native' | 'openai' | 'flux-kontext' | 'image-generation'
  internalPrompt?: string
  ratios?: RatioOption[]
  capabilities?: ModelCapabilities
  editURL?: string
  sizeStrategy?: string
  defaultParams?: Record<string, unknown>
  responseFormats?: string[]
  resolutions?: ResolutionOption[]
  defaultResolution?: string
  resolutionMap?: Record<string, Record<string, string>>
  /**
   * 单张出图实际价格(USD)。优先级高于从 displayName 文本里抠取的旧值。
   * 不填时收据组件会回退到 displayName 中 `$X.XX/张` 的兜底解析。
   */
  price?: number
}

export interface RatioOption {
  key: string
  label: string
  description?: string
}

export interface ModelCapabilities {
  multipleImages: boolean
  customSize: boolean
  aspectRatioControl?: boolean
  referenceImage?: boolean
  imageEdit?: boolean
  intelligentResize?: boolean
  resolutionControl?: boolean
  maxOutputs?: number
  useExtraBody?: boolean
}

export interface GenerateImageParams {
  prompt: string
  model?: string
  ratio?: string
  resolution?: string
  referenceImages?: string[]
  imageBase64?: string  // 编辑模式的图片
  negativePrompt?: string
  count?: number
  signal?: AbortSignal
}

export interface GenerateResult {
  success: boolean
  images?: string[]
  urls?: string[]  // 兼容旧 API 格式
  error?: string
  rawResponse?: any
  isFluxTemporary?: boolean  // Flux 图片 10 分钟后失效
}

export interface VisionParams {
  images: string[]  // 图片 URL 或 base64
  prompt?: string
  role?: string
  model?: string
}

export interface VisionResult {
  success: boolean
  content?: string
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
    description: 'API易 B站端点，推荐使用',
    authType: 'bearer',
    isBuiltIn: true
  },
  'yunwu': {
    name: '云雾 API',
    baseURL: 'https://yunwu.ai',
    description: '云雾 AI 服务',
    authType: 'bearer',
    isBuiltIn: true
  },
  'bolatu': {
    name: '柏拉图 API',
    baseURL: 'https://api.bltcy.ai',
    description: '柏拉图 AI 中转站',
    authType: 'bearer',
    isBuiltIn: true
  },
  'antigravity': {
    name: 'Miau API',
    baseURL: 'http://175.178.198.17:3000',
    description: 'Miau API 服务',
    authType: 'bearer',
    isBuiltIn: true
  },
  'local': {
    name: '本地服务',
    baseURL: 'http://localhost:8080',
    description: '本地部署的 API 服务',
    authType: 'bearer',
    isBuiltIn: true
  }
}

// 默认模型配置
const DEFAULT_MODELS: Record<string, ModelConfig> = {
  'gemini-3.1-flash-image-preview': {
    name: '🍌 Nano Banana 2',
    displayName: '15s，gemini-3.1-flash-image-preview 谷歌原生端点请求，支持超多尺寸4K，$0.03/张🚀 官网低于2折',
    price: 0.06,
    time: '15s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent',
    apiType: 'gemini-native',
    internalPrompt: '生成图片：',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' },
      { key: '4:1', label: '超横版 4:1', description: '横幅' },
      { key: '1:4', label: '超竖版 1:4', description: '长图' },
      { key: '8:1', label: '极横版 8:1', description: '横幅' },
      { key: '1:8', label: '极竖版 1:8', description: '信息图' }
    ],
    resolutions: [
      { key: '0.5K', label: '0.5K 低清', description: '缩略图/预览' },
      { key: '1K', label: '1K 标准', description: '高效' },
      { key: '2K', label: '2K 高清', description: '稍慢速度' },
      { key: '4K', label: '4K 超清', description: '印刷所需' }
    ],
    defaultResolution: '1K',
    resolutionMap: {
      '1:1':  { '0.5K': '512×512',   '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' },
      '2:3':  { '0.5K': '424×632',   '1K': '848×1264',  '2K': '1696×2528', '4K': '3392×5056' },
      '3:2':  { '0.5K': '632×424',   '1K': '1264×848',  '2K': '2528×1696', '4K': '5056×3392' },
      '3:4':  { '0.5K': '448×600',   '1K': '896×1200',  '2K': '1792×2400', '4K': '3584×4800' },
      '4:3':  { '0.5K': '600×448',   '1K': '1200×896',  '2K': '2400×1792', '4K': '4800×3584' },
      '4:5':  { '0.5K': '464×576',   '1K': '928×1152',  '2K': '1856×2304', '4K': '3712×4608' },
      '5:4':  { '0.5K': '576×464',   '1K': '1152×928',  '2K': '2304×1856', '4K': '4608×3712' },
      '9:16': { '0.5K': '384×688',   '1K': '768×1376',  '2K': '1536×2752', '4K': '3072×5504' },
      '16:9': { '0.5K': '688×384',   '1K': '1376×768',  '2K': '2752×1536', '4K': '5504×3072' },
      '21:9': { '0.5K': '792×336',   '1K': '1584×672',  '2K': '3168×1344', '4K': '6336×2688' },
      '4:1':  { '0.5K': '1024×256',  '1K': '2048×512',  '2K': '4096×1024', '4K': '8192×2048' },
      '1:4':  { '0.5K': '256×1024',  '1K': '512×2048',  '2K': '1024×4096', '4K': '2048×8192' },
      '8:1':  { '0.5K': '1448×182',  '1K': '2896×362',  '2K': '5792×724',  '4K': '11584×1448' },
      '1:8':  { '0.5K': '182×1448',  '1K': '362×2896',  '2K': '724×5792',  '4K': '1448×11584' },
      'auto': { '0.5K': '自适应', '1K': '自适应', '2K': '自适应', '4K': '自适应' }
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true
    }
  },
  'gemini-3-pro-image-preview': {
    name: '🍌 Nano Banana Pro',
    displayName: '60s，gemini-3-pro-image-preview 谷歌原生端点请求，支持多尺寸4K，$0.05/张🔥 官网1/5价格',
    price: 0.09,
    time: '60s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1beta/models/gemini-3-pro-image-preview:generateContent',
    apiType: 'gemini-native',
    internalPrompt: '生成图片：',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    resolutions: [
      { key: '1K', label: '1K 标准', description: '高效' },
      { key: '2K', label: '2K 高清', description: '稍慢速度' },
      { key: '4K', label: '4K 超清', description: '印刷所需' }
    ],
    defaultResolution: '1K',
    resolutionMap: {
      '1:1': { '1K': '1024×1024', '2K': '2048×2048', '4K': '4096×4096' },
      '2:3': { '1K': '848×1264', '2K': '1696×2528', '4K': '3392×5056' },
      '3:2': { '1K': '1264×848', '2K': '2528×1696', '4K': '5056×3392' },
      '3:4': { '1K': '896×1200', '2K': '1792×2400', '4K': '3584×4800' },
      '4:3': { '1K': '1200×896', '2K': '2400×1792', '4K': '4800×3584' },
      '4:5': { '1K': '928×1152', '2K': '1856×2304', '4K': '3712×4608' },
      '5:4': { '1K': '1152×928', '2K': '2304×1856', '4K': '4608×3712' },
      '9:16': { '1K': '768×1376', '2K': '1536×2752', '4K': '3072×5504' },
      '16:9': { '1K': '1376×768', '2K': '2752×1536', '4K': '5504×3072' },
      '21:9': { '1K': '1584×672', '2K': '3168×1344', '4K': '6336×2688' },
      'auto': { '1K': '自适应', '2K': '自适应', '4K': '自适应' }
    },
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      resolutionControl: true
    }
  },
  'gemini-2.5-flash-image': {
    name: '🍌 Nano Banana',
    displayName: '15s，gemini-2.5-flash-image 谷歌原生端点请求，支持多宽高比，固定1K分辨率，$0.025/张',
    time: '15s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    apiType: 'gemini-native',
    internalPrompt: '生成图片：',
    ratios: [
      { key: 'auto', label: '自适应', description: '智能' },
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' },
      { key: '5:4', label: '横版 5:4', description: '传统' },
      { key: '4:5', label: '竖版 4:5', description: '社媒' }
    ],
    capabilities: {
      multipleImages: false,
      customSize: true,
      aspectRatioControl: true,
      referenceImage: true,
      imageEdit: true
    }
  },
  'seedream-4-5-251128': {
    name: 'SeeDream 4.5',
    displayName: '15s出图，即梦海外版seedream-4-5-251128，超清生图编辑，支持2K/4K分辨率，支持URL与Base64输出, $0.045/张',
    time: '15s',
    isNew: true,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    apiType: 'image-generation',
    sizeStrategy: 'seedream',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '常用' },
      { key: '4:3', label: '横版 4:3', description: '标准' },
      { key: '3:4', label: '竖版 3:4', description: '标准' },
      { key: '16:9', label: '横版 16:9', description: '宽屏' },
      { key: '9:16', label: '竖版 9:16', description: '竖屏' },
      { key: '3:2', label: '横版 3:2', description: '经典' },
      { key: '2:3', label: '竖版 2:3', description: '经典' },
      { key: '21:9', label: '影院 21:9', description: '超宽屏' }
    ],
    resolutions: [
      { key: '2K', label: '2K 高清', description: '标准分辨率' },
      { key: '4K', label: '4K 超清', description: '超高分辨率' }
    ],
    defaultResolution: '2K',
    resolutionMap: {
      '1:1': { '2K': '2048×2048', '4K': '4096×4096' },
      '4:3': { '2K': '2304×1728', '4K': '4608×3456' },
      '3:4': { '2K': '1728×2304', '4K': '3456×4608' },
      '16:9': { '2K': '2560×1440', '4K': '5120×2880' },
      '9:16': { '2K': '1440×2560', '4K': '2880×5120' },
      '3:2': { '2K': '2496×1664', '4K': '4992×3328' },
      '2:3': { '2K': '1664×2496', '4K': '3328×4992' },
      '21:9': { '2K': '3024×1296', '4K': '6048×2592' }
    },
    defaultParams: {
      sequential_image_generation: 'disabled',
      response_format: 'url',
      size: '2K',
      stream: false,
      watermark: false
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: true,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 2,
      resolutionControl: true
    }
  },
  'sora_image': {
    name: 'Sora Image',
    displayName: '90s出图，Sora网页版出图，同名 gpt-4o-image，价格最便宜~！$0.01/张【荐】',
    time: '90s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1/chat/completions',
    apiType: 'openai',
    capabilities: {
      multipleImages: true,
      customSize: true
    }
  },
  'flux-kontext-pro': {
    name: 'Flux Kontext Pro',
    displayName: '15s出图，flux-kontext-pro，只支持英文提示词，高质量图片生成，$0.035/张',
    time: '15s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'flux-kontext',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '1024×1024' },
      { key: '2:3', label: '竖版 2:3', description: '832×1248' },
      { key: '3:2', label: '横版 3:2', description: '1248×832' },
      { key: '16:9', label: '宽屏 16:9', description: '1408×792' },
      { key: '9:16', label: '竖屏 9:16', description: '792×1408' },
      { key: '3:7', label: '超窄竖版 3:7', description: '662×1544' },
      { key: '7:3', label: '超宽横版 7:3', description: '1544×662' }
    ],
    defaultParams: {
      response_format: 'url',
      safety_tolerance: 6
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: false,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      useExtraBody: true
    }
  },
  'flux-kontext-max': {
    name: 'Flux Kontext Max',
    displayName: '15s出图，flux-kontext-max，提示词支持中文，超高质量图片编辑。$0.07/张',
    time: '15s',
    isNew: false,
    baseURL: 'https://b.apiyi.com/v1/images/generations',
    editURL: 'https://b.apiyi.com/v1/images/edits',
    apiType: 'flux-kontext',
    ratios: [
      { key: '1:1', label: '方形 1:1', description: '1024×1024' },
      { key: '2:3', label: '竖版 2:3', description: '832×1248' },
      { key: '3:2', label: '横版 3:2', description: '1248×832' },
      { key: '16:9', label: '宽屏 16:9', description: '1408×792' },
      { key: '9:16', label: '竖屏 9:16', description: '792×1408' },
      { key: '3:7', label: '超窄竖版 3:7', description: '662×1544' },
      { key: '7:3', label: '超宽横版 7:3', description: '1544×662' }
    ],
    defaultParams: {
      response_format: 'url',
      safety_tolerance: 6
    },
    responseFormats: ['url', 'b64_json'],
    capabilities: {
      multipleImages: false,
      customSize: true,
      referenceImage: true,
      imageEdit: true,
      maxOutputs: 1,
      useExtraBody: true
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
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, count = 1, signal } = params

    if (!this.apiKey) {
      return { success: false, error: '请先设置 API Key' }
    }

    const modelKey = model || this.currentModel
    const modelConfig = this.models[modelKey]
    const site = this.apiSites[this.currentSite]

    if (!modelConfig) {
      return { success: false, error: `未知模型: ${modelKey}` }
    }

    try {
      const response = await this.withRetry(
        () => this.makeApiRequest({
          prompt,
          model: modelKey,
          ratio,
          resolution,
          referenceImages,
          imageBase64,
          count,
          modelConfig,
          site,
          signal,
        }),
        { maxRetries: 1, retryDelay: 2000 }
      )

      const result = await this.parseResponse(response, modelConfig)
      
      // 标记 Flux 图片为临时的
      if (modelConfig.apiType === 'flux-kontext' && result.success) {
        result.isFluxTemporary = true
      }

      return result
    } catch (error) {
      if (signal?.aborted) {
        return { success: false, error: '操作已取消' }
      }
      console.error('生成图片失败:', error)
      return {
        success: false,
        error: this.formatErrorMessage(error as Error)
      }
    }
  }

  /**
   * 基于参考图生成图片 (垫图功能) - 兼容旧 API 签名
   * @param prompt 提示词
   * @param referenceImages 参考图片数组
   * @param ratio 比例
   * @param count 生成数量
   * @param resolution 分辨率
   */
  async generateImageWithReference(
    prompt: string,
    referenceImages: Array<string | { data: string; mimeType?: string }>,
    ratio: string = '1:1',
    count: number = 1,
    resolution?: string
  ): Promise<GenerateResult> {
    return this.generateImage({
      prompt,
      referenceImages,
      ratio,
      count,
      resolution
    })
  }

  /**
   * 带重试的请求包装
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    options: { maxRetries?: number; retryDelay?: number } = {}
  ): Promise<T> {
    const { maxRetries = 1, retryDelay = 2000 } = options
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error as Error
        
        // 判断是否可重试
        if (!this.isRetryableError(error) || attempt >= maxRetries) {
          throw error
        }

        console.warn(`请求失败，${retryDelay}ms 后重试 (${attempt + 1}/${maxRetries})`)
        await this.delay(retryDelay * (attempt + 1))  // 指数退避
      }
    }

    throw lastError
  }

  /**
   * 判断错误是否可重试
   */
  private isRetryableError(error: any): boolean {
    if (error.name === 'AbortError') {
      return false
    }

    // 网络错误可重试
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      return true
    }

    // 5xx 错误可重试
    if (error.status && error.status >= 500) {
      return true
    }

    // 429 Too Many Requests 可重试
    if (error.status === 429) {
      return true
    }

    return false
  }

  /**
   * 格式化错误消息
   */
  private formatErrorMessage(error: Error): string {
    const message = error.message || '未知错误'

    // 网络错误
    if (message.includes('fetch') || message.includes('network')) {
      return '网络连接失败，请检查网络设置'
    }

    // 超时
    if (message.includes('timeout') || error.name === 'AbortError') {
      return '请求超时，请稍后重试'
    }

    // API Key 错误
    if (message.includes('401') || message.includes('Unauthorized')) {
      return 'API Key 无效或已过期'
    }

    // 余额不足
    if (message.includes('402') || message.includes('insufficient')) {
      return '账户余额不足'
    }

    // 频率限制
    if (message.includes('429') || message.includes('rate limit')) {
      return '请求过于频繁，请稍后重试'
    }

    return message
  }

  /**
   * 延迟函数
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * 图像理解 (Vision API)
   */
  async understandImage(params: VisionParams): Promise<VisionResult> {
    const { images, prompt = '请描述这张图片', role, model = 'gemini-1.5-flash' } = params

    const apiKey = this.visionApiKey || this.apiKey
    if (!apiKey) {
      return { success: false, error: '请先设置 API Key' }
    }

    if (!images || images.length === 0) {
      return { success: false, error: '请提供至少一张图片' }
    }

    try {
      const site = this.apiSites[this.currentSite]
      const url = `${site.baseURL}/v1/chat/completions`

      const content: any[] = []
      
      // 添加提示词
      const systemPrompt = role ? `你是${role}。` : ''
      content.push({ type: 'text', text: systemPrompt + prompt })

      // 添加图片
      for (const img of images) {
        const normalized = this.normalizeImageSource(img)
        if (normalized) {
          content.push({
            type: 'image_url',
            image_url: { url: normalized }
          })
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content }],
          max_tokens: 4096
        })
      })

      const data = await response.json()

      if (!response.ok) {
        return {
          success: false,
          error: data.error?.message || `API 错误: ${response.status}`,
          rawResponse: data
        }
      }

      const textContent = data.choices?.[0]?.message?.content || ''
      
      return {
        success: true,
        content: textContent,
        rawResponse: data
      }
    } catch (error) {
      console.error('图像理解失败:', error)
      return {
        success: false,
        error: (error as Error).message || '图像理解失败'
      }
    }
  }

  /**
   * 分析图片（流式输出版本）
   * @param images - 图片数组，每个包含 {base64, mimeType}
   * @param prompt - 用户提示词
   * @param model - 模型名称
   * @param maxTokens - 最大输出 tokens 数量（可选）
   * @param onChunk - 流式回调函数，接收每个文本片段
   * @param onComplete - 完成回调
   * @param onError - 错误回调
   */
  async analyzeImagesStream(
    images: Array<{ base64: string; mimeType?: string }>,
    prompt: string,
    model: string,
    maxTokens: number | null,
    onChunk: (chunk: string) => void,
    onComplete: () => void,
    onError: (error: Error) => void
  ): Promise<void> {
    if (!this.visionApiKey) {
      const error = new Error('请先设置图像理解 API Key')
      onError?.(error)
      throw error
    }

    if (!images || images.length === 0) {
      const error = new Error('请至少上传一张图片')
      onError?.(error)
      throw error
    }

    const useMaxTokens = typeof maxTokens === 'number' && maxTokens > 0
    const site = this.apiSites[this.currentSite]

    console.log('🔍 开始图像理解分析 (流式输出):', {
      model,
      imageCount: images.length,
      promptLength: prompt.length,
      maxTokens: useMaxTokens ? maxTokens : '使用模型默认',
      currentSite: this.currentSite,
      visionApiKeySet: !!this.visionApiKey
    })

    // 构造 OpenAI 兼容格式的请求
    const content: Array<{ type: string; text?: string; image_url?: { url: string } }> = [
      { type: 'text', text: prompt }
    ]

    // 添加所有图片
    for (const image of images) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${image.mimeType || 'image/jpeg'};base64,${image.base64}`
        }
      })
    }

    const requestBody: Record<string, any> = {
      model: model,
      messages: [
        {
          role: 'user',
          content: content
        }
      ],
      temperature: 0.7,
      stream: true
    }

    if (useMaxTokens) {
      requestBody.max_tokens = maxTokens
    }

    try {
      const apiUrl = `${site.baseURL}/v1/chat/completions`
      console.log('🔗 图像理解流式 API 请求 URL:', apiUrl)

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.visionApiKey}`
        },
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}))
        const error = new Error(
          (errorData as any).error?.message ||
          `API 请求失败: ${response.status} ${response.statusText}`
        )
        onError?.(error)
        throw error
      }

      // 使用 ReadableStream 读取流式数据
      const reader = response.body?.getReader()
      if (!reader) {
        const error = new Error('无法读取响应流')
        onError?.(error)
        throw error
      }

      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          console.log('✅ 流式输出完成')
          onComplete?.()
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmedLine = line.trim()

          if (trimmedLine.startsWith('data: ')) {
            const data = trimmedLine.slice(6)

            if (data === '[DONE]') {
              console.log('📌 收到结束标记 [DONE]')
              continue
            }

            try {
              const json = JSON.parse(data)

              // 提取内容片段 - 尝试多种可能的字段路径
              let textContent = json.choices?.[0]?.delta?.content  // OpenAI 标准格式
              if (!textContent) textContent = json.choices?.[0]?.message?.content  // 非流式格式
              if (!textContent) textContent = json.delta?.content  // 简化格式
              if (!textContent) textContent = json.content  // 最简格式

              if (textContent && onChunk) {
                onChunk(textContent)
              }
            } catch (parseError) {
              // 忽略解析错误
            }
          }
        }
      }
    } catch (error) {
      console.error('❌ 图像理解分析失败 (流式):', error)
      onError?.(error as Error)
      throw error
    }
  }

  /**
   * 构建请求 URL：用站点的域名替换模型 URL 中的域名
   */
  private buildRequestUrl(modelConfig: ModelConfig, site: ApiSite): string {
    // 如果模型没有指定 baseURL，使用站点默认路径
    if (!modelConfig.baseURL) {
      return `${site.baseURL}/v1/chat/completions`
    }

    // 解析模型的 baseURL，提取路径部分
    try {
      const modelUrl = new URL(modelConfig.baseURL)
      const siteUrl = new URL(site.baseURL)
      
      // 用站点的域名替换模型 URL 的域名
      modelUrl.protocol = siteUrl.protocol
      modelUrl.host = siteUrl.host
      
      return modelUrl.toString()
    } catch {
      // URL 解析失败，直接返回模型的 baseURL
      return modelConfig.baseURL
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
    imageBase64?: string
    count: number
    modelConfig: ModelConfig
    site: ApiSite
    signal?: AbortSignal
  }): Promise<Response> {
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, modelConfig, site, signal } = options

    // 构建请求 URL：用站点的域名替换模型 URL 中的域名
    const url = this.buildRequestUrl(modelConfig, site)
    
    const body = this.buildRequestBody({
      prompt,
      model,
      ratio,
      resolution,
      referenceImages,
      imageBase64,
      modelConfig
    })

    // 检查是否需要 FormData (Flux with images)
    if (body.__isFluxKontextWithImage) {
      return this.makeFluxFormDataRequest(url, body, site, signal)
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }

    if (site.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else {
      headers['x-api-key'] = this.apiKey!
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    })
  }

  /**
   * Flux Kontext FormData 请求
   */
  private async makeFluxFormDataRequest(
    url: string,
    payload: any,
    site: ApiSite,
    signal?: AbortSignal,
  ): Promise<Response> {
    const formData = new FormData()

    formData.append('model', payload.model)
    formData.append('prompt', payload.prompt)
    
    if (payload.ratio) {
      formData.append('aspect_ratio', payload.ratio)
    }
    
    formData.append('safety_tolerance', '6')
    formData.append('n', '1')

    // 处理图片
    const imageSources = payload.imageBase64 
      ? [payload.imageBase64] 
      : (payload.referenceImages || [])

    if (imageSources.length > 0) {
      const imageSource = imageSources[0]  // Flux 只支持单张图片
      const blob = await this.convertToBlob(imageSource)
      if (blob) {
        formData.append('image', blob, 'image.jpg')
      }
    }

    const headers: Record<string, string> = {}
    if (site.authType === 'bearer') {
      headers['Authorization'] = `Bearer ${this.apiKey}`
    } else {
      headers['x-api-key'] = this.apiKey!
    }

    return fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      signal,
    })
  }

  /**
   * 将图片源转换为 Blob
   */
  private async convertToBlob(source: string | any): Promise<Blob | null> {
    try {
      const normalized = this.normalizeImageSource(source)
      if (!normalized) return null

      if (normalized.startsWith('data:image/')) {
        const response = await fetch(normalized)
        return response.blob()
      }
      
      if (normalized.startsWith('http')) {
        const response = await fetch(normalized, { mode: 'cors' })
        return response.blob()
      }

      return null
    } catch (error) {
      console.error('转换图片为 Blob 失败:', error)
      return null
    }
  }

  /**
   * 构建请求体
   */
  private buildRequestBody(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, modelConfig } = options

    // Gemini Native 格式
    if (modelConfig.apiType === 'gemini-native') {
      return this.buildGeminiNativePayload({
        prompt,
        ratio,
        resolution,
        referenceImages,
        imageBase64,
        modelConfig
      })
    }

    // Flux Kontext 格式
    if (modelConfig.apiType === 'flux-kontext') {
      return this.buildFluxPayload({
        prompt,
        model,
        ratio,
        referenceImages,
        imageBase64,
        modelConfig
      })
    }

    // OpenAI 兼容格式 (包括 seedream, sora_image)
    return this.buildOpenAIPayload({
      prompt,
      model,
      ratio,
      resolution,
      referenceImages,
      imageBase64,
      modelConfig
    })
  }

  /**
   * 构建 Gemini Native 请求体
   */
  private buildGeminiNativePayload(options: {
    prompt: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, ratio, resolution, referenceImages, imageBase64, modelConfig } = options

    const parts: any[] = [{ text: `${modelConfig.internalPrompt || ''}${prompt}` }]

    // 添加编辑图片或参考图
    const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
    for (const img of imageSources) {
      const normalized = this.normalizeImageSource(img)
      if (normalized?.startsWith('data:image/')) {
        const match = normalized.match(/^data:(image\/[^;]+);base64,(.+)$/)
        if (match) {
          parts.push({
            inline_data: {
              mime_type: match[1],
              data: match[2]
            }
          })
        }
      }
    }

    const imageConfig: any = {}
    
    // 只有非自适应模式才传递 aspectRatio
    if (ratio && ratio !== 'auto') {
      imageConfig.aspectRatio = ratio
    }

    // 只有支持分辨率控制的模型才传递 imageSize
    if (modelConfig.capabilities?.aspectRatioControl && resolution) {
      imageConfig.imageSize = resolution
    }

    return {
      contents: [{
        role: 'user',
        parts
      }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig
      }
    }
  }

  /**
   * 构建 Flux Kontext 请求体
   */
  private buildFluxPayload(options: {
    prompt: string
    model: string
    ratio?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, model, ratio, referenceImages, imageBase64 } = options
    const hasImages = (referenceImages && referenceImages.length > 0) || imageBase64

    // 标记需要 FormData 处理
    if (hasImages) {
      return {
        __isFluxKontextWithImage: true,
        model,
        prompt,
        ratio,
        referenceImages,
        imageBase64
      }
    }

    // 纯文本生成使用 JSON 格式
    return {
      model,
      prompt,
      n: 1,
      aspect_ratio: ratio,
      safety_tolerance: 6,  // 最宽松的内容审核级别
      response_format: 'url'
    }
  }

  /**
   * 构建 OpenAI 兼容请求体
   */
  private buildOpenAIPayload(options: {
    prompt: string
    model: string
    ratio?: string
    resolution?: string
    referenceImages?: string[]
    imageBase64?: string
    modelConfig: ModelConfig
  }): any {
    const { prompt, model, ratio, resolution, referenceImages, imageBase64, modelConfig } = options

    // 检查是否是图片生成 API 格式
    if (modelConfig.baseURL?.includes('/images/generations')) {
      const payload: any = {
        model,
        prompt,
        n: 1
      }

      // 计算尺寸
      const size = this.getImageSize(modelConfig, ratio, resolution)
      if (size) {
        payload.size = size
      }

      // 添加图片
      const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
      if (imageSources.length > 0) {
        payload.image = imageSources[0]
        if (imageSources.length > 1) {
          payload.images = imageSources
        }
      }

      return payload
    }

    // Chat Completions 格式 (sora_image)
    const content: any[] = [{ type: 'text', text: prompt }]
    
    const imageSources = imageBase64 ? [imageBase64] : (referenceImages || [])
    for (const img of imageSources) {
      content.push({
        type: 'image_url',
        image_url: { url: img }
      })
    }

    return {
      model,
      messages: [{
        role: 'user',
        content: imageSources.length > 0 ? content : prompt
      }]
    }
  }

  /**
   * 获取图片尺寸
   */
  private getImageSize(modelConfig: ModelConfig, ratio?: string, resolution?: string): string | null {
    // 预定义尺寸映射
    const sizeMap: Record<string, Record<string, string>> = {
      '1:1': { '2K': '2048x2048', '4K': '4096x4096', '1K': '1024x1024' },
      '4:3': { '2K': '2304x1728', '4K': '4608x3456', '1K': '1200x896' },
      '3:4': { '2K': '1728x2304', '4K': '3456x4608', '1K': '896x1200' },
      '16:9': { '2K': '2560x1440', '4K': '5120x2880', '1K': '1376x768' },
      '9:16': { '2K': '1440x2560', '4K': '2880x5120', '1K': '768x1376' },
      '3:2': { '2K': '2496x1664', '4K': '4992x3328', '1K': '1264x848' },
      '2:3': { '2K': '1664x2496', '4K': '3328x4992', '1K': '848x1264' },
      '21:9': { '2K': '3024x1296', '4K': '6048x2592', '1K': '1584x672' }
    }

    const normalizedRatio = ratio || '1:1'
    const useResolution = resolution || '2K'

    return sizeMap[normalizedRatio]?.[useResolution] || sizeMap['1:1']?.[useResolution] || null
  }

  /**
   * 标准化图片源
   */
  private normalizeImageSource(source: string | any, fallbackMime = 'image/jpeg'): string | null {
    if (!source) return null

    if (typeof source === 'string') {
      const trimmed = source.trim()
      if (!trimmed) return null
      
      // URL
      if (/^https?:\/\//i.test(trimmed)) return trimmed
      
      // 已经是 data URL
      if (trimmed.toLowerCase().startsWith('data:image/')) return trimmed
      
      // 纯 base64
      return `data:${fallbackMime};base64,${trimmed}`
    }

    // 对象格式
    if (typeof source === 'object') {
      if (source.dataUrl) return this.normalizeImageSource(source.dataUrl, source.mimeType || fallbackMime)
      if (source.url) return this.normalizeImageSource(source.url, source.mimeType || fallbackMime)
      if (source.base64) {
        const base64 = source.base64.trim()
        if (base64.toLowerCase().startsWith('data:image/')) return base64
        return `data:${source.mimeType || fallbackMime};base64,${base64}`
      }
    }

    return null
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
        urls: images,  // 兼容旧 API 格式
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
   * 测试 API 连接
   * @param apiKey - 要测试的 API Key
   * @returns true if the API responds successfully
   */
  async testConnection(apiKey: string): Promise<boolean> {
    const site = this.apiSites[this.currentSite]
    if (!site) return false

    try {
      const response = await fetch(`${site.baseURL}/v1/models`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      })
      return response.ok
    } catch {
      return false
    }
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
    window.dispatchEvent(new CustomEvent('model-changed', { detail: { modelKey } }))
    return true
  }

  /**
   * 获取当前模型 key
   */
  getModelKey(): string {
    return this.currentModel
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

  /**
   * 获取存储的 API Key（公开方法）
   */
  getStoredApiKey(site?: string): string | null {
    return localStorage.getItem(`api_key_${site || this.currentSite}`)
  }

  /**
   * 获取存储的 Vision API Key（公开方法）
   */
  getStoredVisionApiKey(site?: string): string | null {
    return localStorage.getItem(`vision_api_key_${site || this.currentSite}`)
  }

  /**
   * 保存 Vision API Key
   */
  saveVisionApiKey(key: string): boolean {
    try {
      localStorage.setItem(`vision_api_key_${this.currentSite}`, key)
      this.visionApiKey = key
      return true
    } catch {
      return false
    }
  }

  /**
   * 保存站点选择（setSite 的别名，兼容 SiteManager）
   */
  saveSite(siteKey: string): boolean {
    return this.setSite(siteKey)
  }

  /**
   * 获取当前站点 key
   */
  get currentSiteKey(): string {
    return this.currentSite
  }

  /**
   * 添加自定义站点
   */
  addCustomSite(key: string, config: Partial<ApiSite>): boolean {
    if (!key || !config.name || !config.baseURL) return false
    if (BUILT_IN_SITES[key]) return false

    const newSite: ApiSite = {
      name: config.name,
      baseURL: config.baseURL,
      description: config.description || '用户自定义站点',
      authType: config.authType || 'bearer',
      pathPrefix: config.pathPrefix,
      defaultApiKey: config.defaultApiKey,
      isBuiltIn: false
    }

    this.customSites[key] = newSite
    this.saveCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }
    return true
  }

  /**
   * 更新自定义站点
   */
  updateCustomSite(key: string, config: Partial<ApiSite>): boolean {
    if (!this.customSites[key]) return false

    this.customSites[key] = { ...this.customSites[key], ...config }
    this.saveCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }
    return true
  }

  /**
   * 删除自定义站点
   */
  removeCustomSite(key: string): boolean {
    if (!this.customSites[key]) return false

    delete this.customSites[key]
    this.saveCustomSites()
    this.apiSites = { ...BUILT_IN_SITES, ...this.customSites }

    // 如果删除的是当前站点，切换到默认
    if (this.currentSite === key) {
      this.setSite('b-apiyi')
    }
    return true
  }

  /**
   * 保存自定义站点到 localStorage
   */
  private saveCustomSites(): void {
    localStorage.setItem('custom_sites', JSON.stringify(this.customSites))
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

  /**
   * 辅助方法：将数组分块
   */
  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }

  /**
   * 批量生成图片
   */
  async batchGenerate(
    prompts: string[],
    ratio = '1:1',
    concurrency = 2,
    n = 1,
    resolution: string | null = null
  ): Promise<any[]> {
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error('提示词列表不能为空')
    }

    const results: any[] = []
    const batches = this.chunk(prompts, concurrency)

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const batchPromises = batch.map(async (prompt, index) => {
        const promptIndex = i * concurrency + index
        try {
          const result = await this.generateImage({
            prompt,
            ratio,
            resolution: resolution || undefined,
            count: n
          })
          const resultData = {
            index: promptIndex,
            prompt,
            success: result.success,
            ...result
          }

          // 立即触发单个结果显示事件
          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: resultData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return resultData
        } catch (error) {
          const errorData = {
            index: promptIndex,
            prompt,
            success: false,
            error: error,
            errorMessage: (error as Error).message
          }

          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: errorData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return errorData
        }
      })

      const batchResults = await Promise.allSettled(batchPromises)
      results.push(...batchResults.map(result =>
        result.status === 'fulfilled' ? result.value : {
          success: false,
          error: result.reason,
          errorMessage: result.reason?.message || '请求失败'
        }
      ))

      // 触发进度更新事件
      window.dispatchEvent(new CustomEvent('batchProgress', {
        detail: {
          completed: results.length,
          total: prompts.length,
          currentBatch: i + 1,
          totalBatches: batches.length
        }
      }))

      // 批次间延迟
      if (i < batches.length - 1) {
        await this.delay(1000)
      }
    }

    return results
  }

  /**
   * 批量生成图片（带参考图）
   */
  async batchGenerateWithReference(
    prompts: string[],
    referenceImages: string[],
    ratio = '1:1',
    concurrency = 2,
    n = 1,
    resolution: string | null = null
  ): Promise<any[]> {
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error('提示词列表不能为空')
    }

    if (!referenceImages || referenceImages.length === 0) {
      throw new Error('参考图片不能为空')
    }

    const results: any[] = []
    const batches = this.chunk(prompts, concurrency)

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i]
      const batchPromises = batch.map(async (prompt, index) => {
        const promptIndex = i * concurrency + index
        try {
          const result = await this.generateImage({
            prompt,
            ratio,
            resolution: resolution || undefined,
            referenceImages,
            count: n
          })
          const resultData = {
            index: promptIndex,
            prompt,
            success: result.success,
            ...result
          }

          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: resultData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return resultData
        } catch (error) {
          const errorData = {
            index: promptIndex,
            prompt,
            success: false,
            error: error,
            errorMessage: (error as Error).message
          }

          window.dispatchEvent(new CustomEvent('batchItemComplete', {
            detail: {
              result: errorData,
              completed: promptIndex + 1,
              total: prompts.length
            }
          }))

          return errorData
        }
      })

      const batchResults = await Promise.allSettled(batchPromises)
      results.push(...batchResults.map(result =>
        result.status === 'fulfilled' ? result.value : {
          success: false,
          error: result.reason,
          errorMessage: result.reason?.message || '请求失败'
        }
      ))

      window.dispatchEvent(new CustomEvent('batchProgress', {
        detail: {
          completed: results.length,
          total: prompts.length,
          currentBatch: i + 1,
          totalBatches: batches.length
        }
      }))

      if (i < batches.length - 1) {
        await this.delay(1000)
      }
    }

    return results
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
