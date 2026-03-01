// src/renderer/src/services/i18n/I18nService.ts
/**
 * 国际化 (i18n) 核心模块
 * 支持多语言切换、动态加载、文本翻译
 */

export type Language = 'zh-CN' | 'en' | 'zh-TW' | 'ru' | string

export interface I18nConfig {
  defaultLanguage: Language
  fallbackLanguage: Language
  supportedLanguages: Language[]
  basePath: string
  cacheEnabled: boolean
  version: string
}

export interface TranslationData {
  [key: string]: string | TranslationData
}

export interface LanguageInfo {
  code: Language
  name: string
  nativeName: string
}

// 默认语言包（内联，作为后备）
const DEFAULT_TRANSLATIONS: TranslationData = {
  common: {
    appName: 'CATIMATION-Cyberpunk Master',
    appNameShort: 'CATIMATION',
    generate: '生成',
    batch: '批量',
    compare: '对比',
    history: '历史',
    settings: '设置',
    save: '保存',
    cancel: '取消',
    delete: '删除',
    download: '下载',
    upload: '上传',
    copy: '复制',
    close: '关闭',
    confirm: '确认',
    loading: '加载中...',
    processing: '处理中...',
    success: '成功',
    error: '错误',
    warning: '警告'
  },
  nav: {
    generateImage: '生成图片',
    batchGenerate: '批量生成',
    modelCompare: '模型对比',
    historyRecords: '历史记录',
    switchLanguage: '切换语言'
  },
  settings: {
    title: '设置',
    apiKey: 'API Key',
    saveSuccess: '设置保存成功'
  },
  generate: {
    title: '生成图片',
    prompt: '提示词',
    promptRequired: '请输入提示词',
    generating: '正在生成图片...',
    generateSuccess: '图片生成成功',
    generateFailed: '图片生成失败'
  }
}

// 支持的语言列表 - 必须与 public/i18n/ 目录下的翻译文件匹配
const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: 'zh-CN', name: 'Chinese (Simplified)', nativeName: '简体中文' },
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
  { code: 'ru', name: 'Russian', nativeName: 'Русский' }
]

export class I18nService {
  private currentLanguage: Language
  private translations: TranslationData
  private loadedLanguages: Map<Language, TranslationData>
  private config: I18nConfig
  private initialized: boolean
  private onLanguageChangeCallbacks: Set<(lang: Language) => void>

  constructor(config?: Partial<I18nConfig>) {
    this.config = {
      defaultLanguage: 'zh-CN',
      fallbackLanguage: 'zh-CN',
      supportedLanguages: ['zh-CN', 'en', 'zh-TW', 'ru'],
      basePath: './i18n/',
      cacheEnabled: true,
      version: '1.0.0',
      ...config
    }

    this.currentLanguage = this.getStoredLanguage() || this.config.defaultLanguage
    this.translations = { ...DEFAULT_TRANSLATIONS }
    this.loadedLanguages = new Map()
    // 不预缓存 zh-CN，让 loadLanguage 从文件加载完整翻译
    // this.loadedLanguages.set('zh-CN', DEFAULT_TRANSLATIONS)
    this.initialized = false
    this.onLanguageChangeCallbacks = new Set()
  }

  /**
   * 初始化 i18n 服务
   */
  async init(): Promise<void> {
    if (this.initialized) return

    try {
      await this.loadLanguage(this.currentLanguage)
      this.initialized = true
      console.log(`[i18n] Initialized with language: ${this.currentLanguage}`)
    } catch (error) {
      console.error('[i18n] Init failed:', error)
      // 使用后备翻译
      this.translations = { ...DEFAULT_TRANSLATIONS }
      this.initialized = true
    }
  }

  /**
   * 加载指定语言的翻译文件
   */
  async loadLanguage(lang: Language): Promise<TranslationData> {
    // 检查缓存
    if (this.loadedLanguages.has(lang)) {
      this.translations = this.loadedLanguages.get(lang)!
      return this.translations
    }

    try {
      const url = `${this.config.basePath}${lang}.json?v=${this.config.version}`
      const response = await fetch(url, { cache: 'no-cache' })
      
      if (!response.ok) {
        throw new Error(`Failed to load language file: ${response.status}`)
      }

      const data = await response.json()
      this.loadedLanguages.set(lang, data)
      this.translations = data

      // 缓存到 localStorage
      if (this.config.cacheEnabled) {
        try {
          localStorage.setItem(`i18n_cache_${lang}`, JSON.stringify({
            version: this.config.version,
            data
          }))
        } catch (e) {
          console.warn('[i18n] Cache save failed:', e)
        }
      }

      return data
    } catch (error) {
      console.error(`[i18n] Failed to load ${lang}:`, error)
      
      // 尝试从缓存加载
      const cached = this.loadFromCache(lang)
      if (cached) {
        this.translations = cached
        return cached
      }

      // 回退到默认翻译
      return DEFAULT_TRANSLATIONS
    }
  }

  /**
   * 从缓存加载翻译
   */
  private loadFromCache(lang: Language): TranslationData | null {
    try {
      const cached = localStorage.getItem(`i18n_cache_${lang}`)
      if (cached) {
        const { version, data } = JSON.parse(cached)
        if (version === this.config.version) {
          return data
        }
      }
    } catch (e) {
      console.warn('[i18n] Cache load failed:', e)
    }
    return null
  }

  /**
   * 获取翻译文本
   * @param key 翻译键，支持点号分隔的嵌套路径，如 'common.save'
   * @param params 插值参数
   */
  t(key: string, params?: Record<string, string | number>): string {
    const keys = key.split('.')
    let value: any = this.translations

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k]
      } else {
        // 尝试后备翻译
        value = this.getFallbackValue(keys)
        break
      }
    }

    if (typeof value !== 'string') {
      console.warn(`[i18n] Missing translation: ${key}`)
      return key
    }

    // 处理插值
    if (params) {
      return value.replace(/\{(\w+)\}/g, (_, name) => 
        String(params[name] ?? `{${name}}`)
      )
    }

    return value
  }

  /**
   * 获取翻译对象（非字符串值）
   * 用于需要获取嵌套对象（如模型数据 {displayName, description, features}）的场景
   * @param basePath 点号分隔的基础路径，如 'understand.visionModelData'
   * @param subKey 子键（不做点号分割），如 'gpt-5.2'
   */
  tObject(basePath: string, subKey?: string): any {
    const keys = basePath.split('.')
    let value: any = this.translations

    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k]
      } else {
        value = this.getFallbackValue(keys)
        break
      }
    }

    if (subKey && value && typeof value === 'object') {
      return value[subKey] ?? undefined
    }

    return value
  }

  /**
   * 获取后备翻译值
   */
  private getFallbackValue(keys: string[]): any {
    let value: any = DEFAULT_TRANSLATIONS
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k]
      } else {
        return undefined
      }
    }
    return value
  }

  /**
   * 切换语言
   */
  async setLanguage(lang: Language): Promise<boolean> {
    if (!this.config.supportedLanguages.includes(lang)) {
      console.warn(`[i18n] Unsupported language: ${lang}`)
      return false
    }

    try {
      await this.loadLanguage(lang)
      this.currentLanguage = lang
      this.saveStoredLanguage(lang)
      
      // 触发回调
      this.onLanguageChangeCallbacks.forEach(cb => cb(lang))
      
      // 更新 DOM 中的翻译
      this.updateDOM()
      
      console.log(`[i18n] Language changed to: ${lang}`)
      return true
    } catch (error) {
      console.error('[i18n] Set language failed:', error)
      return false
    }
  }

  /**
   * 获取当前语言
   */
  getCurrentLanguage(): Language {
    return this.currentLanguage
  }

  /**
   * 获取支持的语言列表
   */
  getSupportedLanguages(): LanguageInfo[] {
    return SUPPORTED_LANGUAGES.filter(l => 
      this.config.supportedLanguages.includes(l.code)
    )
  }

  /**
   * 获取语言显示名称
   */
  getLanguageName(lang: Language): string {
    const info = SUPPORTED_LANGUAGES.find(l => l.code === lang)
    return info?.nativeName || lang
  }

  /**
   * 监听语言变化
   */
  onLanguageChange(callback: (lang: Language) => void): () => void {
    this.onLanguageChangeCallbacks.add(callback)
    return () => this.onLanguageChangeCallbacks.delete(callback)
  }

  /**
   * 更新 DOM 中的翻译
   */
  updateDOM(): void {
    const elements = document.querySelectorAll('[data-i18n]')
    elements.forEach(el => {
      const key = el.getAttribute('data-i18n')
      if (key) {
        const translated = this.t(key)
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          ;(el as HTMLInputElement).placeholder = translated
        } else {
          el.textContent = translated
        }
      }
    })

    // 处理属性翻译
    const attrElements = document.querySelectorAll('[data-i18n-attr]')
    attrElements.forEach(el => {
      // 支持 ',' 或 ';' 作为属性分隔符
      const attrValue = el.getAttribute('data-i18n-attr') || ''
      const attrs = attrValue.split(/[,;]/)
      attrs.forEach(attr => {
        const [name, key] = attr.split(':')
        if (name && key) {
          const translated = this.t(key.trim())
          el.setAttribute(name.trim(), translated)
        }
      })
    })
  }

  /**
   * 从 localStorage 获取存储的语言
   */
  private getStoredLanguage(): Language | null {
    try {
      return localStorage.getItem('app_language') as Language | null
    } catch {
      return null
    }
  }

  /**
   * 保存语言选择到 localStorage
   */
  private saveStoredLanguage(lang: Language): void {
    try {
      localStorage.setItem('app_language', lang)
    } catch (e) {
      console.warn('[i18n] Save language failed:', e)
    }
  }
}

// 创建单例实例
let instance: I18nService | null = null

export function getI18nService(config?: Partial<I18nConfig>): I18nService {
  if (!instance) {
    instance = new I18nService(config)
  }
  return instance
}

export function createI18nService(config?: Partial<I18nConfig>): I18nService {
  return new I18nService(config)
}

/**
 * 重置单例（仅用于测试）
 */
export function resetI18nService(): void {
  instance = null
}

// ========================================
// V16.2 C1 - 过渡期 window 暴露
// V16.3 - 添加废弃警告
// ========================================

declare global {
  interface Window {
    i18n: I18nService
    i18nTS: I18nService
    I18nServiceTS: typeof I18nService
  }
}

let i18nDeprecationWarningShown = false

/**
 * 初始化并暴露到 window（过渡期）
 * V16.3: 添加废弃警告
 */
export function initI18nGlobal(config?: Partial<I18nConfig>): I18nService {
  const service = getI18nService(config)

  // 过渡期: 暴露到 window (带废弃警告)
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'i18n', {
      get() {
        if (!i18nDeprecationWarningShown && process.env.NODE_ENV !== 'production') {
          console.warn(
            '[DEPRECATED] window.i18n 已废弃。' +
            '请使用 Services.get("i18n") 或 import { getI18nService } from "@/services/i18n"'
          )
          i18nDeprecationWarningShown = true
        }
        return service
      },
      configurable: true
    })
    
    window.i18nTS = service
    window.I18nServiceTS = I18nService
  }

  console.log('[V16.3] I18nService TypeScript 版本已加载 (废弃警告已启用)')

  return service
}
