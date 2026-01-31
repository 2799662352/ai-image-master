/**
 * LanguageManager - 语言管理模块
 * 
 * 负责应用的多语言切换、SEO 标签更新、UI 国际化刷新。
 */

export interface I18nService {
  init(): Promise<string>
  t(key: string): string
  getCurrentLanguage(): string
  getLanguageName(lang: string, native?: boolean): string
  switchLanguage(lang: string): Promise<boolean>
  updateDOM(): void
}

export interface LanguageManagerConfig {
  /** 默认语言 */
  defaultLanguage?: string
  /** 支持的语言列表 */
  supportedLanguages?: string[]
  /** 语言下拉菜单 ID */
  dropdownId?: string
  /** 当前语言名称元素 ID */
  currentLangNameId?: string
  /** 桌面端语言列表容器 ID */
  desktopListId?: string
  /** 移动端语言列表容器 ID */
  mobileListId?: string
}

export interface LanguageChangeEvent {
  previousLanguage: string
  newLanguage: string
}

type LanguageChangeCallback = (event: LanguageChangeEvent) => void

const DEFAULT_CONFIG: Required<LanguageManagerConfig> = {
  defaultLanguage: 'zh-CN',
  supportedLanguages: ['zh-CN', 'en'],
  dropdownId: 'languageDropdown',
  currentLangNameId: 'currentLangName',
  desktopListId: 'languageList',
  mobileListId: 'languageListMobile'
}

/**
 * LanguageManager 类
 * 管理应用的多语言功能
 */
export class LanguageManager {
  private config: Required<LanguageManagerConfig>
  private i18n: I18nService | null = null
  private currentLanguage: string
  private changeCallbacks: LanguageChangeCallback[] = []
  private toastFn: ((message: string, type: string) => void) | null = null
  
  constructor(config: LanguageManagerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.currentLanguage = this.config.defaultLanguage
  }
  
  /**
   * 初始化语言管理器
   */
  async init(i18n: I18nService): Promise<string> {
    this.i18n = i18n
    
    try {
      console.log('[LanguageManager] 开始初始化...')
      
      // 设置超时保护
      const initPromise = i18n.init()
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('I18N init timeout')), 1000)
      )
      
      this.currentLanguage = await Promise.race([initPromise, timeoutPromise])
      console.log(`[LanguageManager] 语言初始化完成: ${this.currentLanguage}`)
      
      // 更新 SEO 标签
      this.updateSEOForLanguage(this.currentLanguage)
      
      return this.currentLanguage
      
    } catch (error) {
      console.warn('[LanguageManager] 初始化失败，使用默认语言:', error)
      this.currentLanguage = this.config.defaultLanguage
      return this.currentLanguage
    }
  }
  
  /**
   * 设置 toast 通知函数
   */
  setToastFunction(fn: (message: string, type: string) => void): void {
    this.toastFn = fn
  }
  
  /**
   * 注册语言变化回调
   */
  onLanguageChange(callback: LanguageChangeCallback): () => void {
    this.changeCallbacks.push(callback)
    return () => {
      const index = this.changeCallbacks.indexOf(callback)
      if (index > -1) {
        this.changeCallbacks.splice(index, 1)
      }
    }
  }
  
  /**
   * 获取当前语言
   */
  getCurrentLanguage(): string {
    return this.currentLanguage
  }
  
  /**
   * 获取 I18n 服务实例
   */
  getI18n(): I18nService | null {
    return this.i18n
  }
  
  /**
   * 切换语言
   */
  async switchLanguage(lang: string): Promise<boolean> {
    if (!this.i18n) {
      console.error('[LanguageManager] I18n 服务未初始化')
      return false
    }
    
    if (!this.config.supportedLanguages.includes(lang)) {
      console.warn(`[LanguageManager] 不支持的语言: ${lang}`)
      return false
    }
    
    try {
      // 关闭下拉菜单
      this.closeDropdown()
      
      const previousLanguage = this.currentLanguage
      
      // 切换语言
      const success = await this.i18n.switchLanguage(lang)
      
      if (success) {
        this.currentLanguage = lang
        
        // 更新 UI
        this.updateSwitcherDisplay(lang)
        this.updateSEOForLanguage(lang)
        
        // 触发回调
        const event: LanguageChangeEvent = { previousLanguage, newLanguage: lang }
        for (const callback of this.changeCallbacks) {
          try {
            callback(event)
          } catch (error) {
            console.warn('[LanguageManager] 语言变化回调执行失败:', error)
          }
        }
        
        // 显示成功提示
        if (this.toastFn) {
          const langName = this.i18n.getLanguageName(lang)
          this.toastFn(`语言已切换为 ${langName}`, 'success')
        }
        
        console.log(`[LanguageManager] 语言切换成功: ${previousLanguage} -> ${lang}`)
        return true
      }
      
      return false
      
    } catch (error) {
      console.error('[LanguageManager] 语言切换失败:', error)
      if (this.toastFn) {
        this.toastFn('语言切换失败', 'error')
      }
      return false
    }
  }
  
  /**
   * 更新 SEO 标签
   */
  updateSEOForLanguage(lang: string): void {
    if (!this.i18n) return
    
    const t = (key: string) => this.i18n!.t(key)
    
    // 更新页面标题
    document.title = t('seo.title')
    
    // 更新 meta description
    this.updateMetaTag('meta[name="description"]', 'content', t('seo.description'))
    
    // 更新 meta keywords
    this.updateMetaTag('meta[name="keywords"]', 'content', t('seo.keywords'))
    
    // 更新 Open Graph 标签
    this.updateMetaTag('meta[property="og:title"]', 'content', t('seo.title'))
    this.updateMetaTag('meta[property="og:description"]', 'content', t('seo.description'))
    
    // 更新 Twitter Card 标签
    this.updateMetaTag('meta[name="twitter:title"]', 'content', t('seo.title'))
    this.updateMetaTag('meta[name="twitter:description"]', 'content', t('seo.description'))
    
    // 更新 html lang 属性
    document.documentElement.lang = lang
    
    console.log(`[LanguageManager] SEO 标签已更新: ${lang}`)
  }
  
  /**
   * 更新 meta 标签
   */
  private updateMetaTag(selector: string, attribute: string, value: string): void {
    const element = document.querySelector(selector)
    if (element) {
      element.setAttribute(attribute, value)
    }
  }
  
  /**
   * 切换语言下拉菜单
   */
  toggleDropdown(): void {
    const dropdown = document.getElementById(this.config.dropdownId)
    if (!dropdown) return
    
    const isHidden = dropdown.classList.contains('hidden')
    
    if (isHidden) {
      this.openDropdown()
    } else {
      this.closeDropdown()
    }
  }
  
  /**
   * 打开语言下拉菜单
   */
  openDropdown(): void {
    const dropdown = document.getElementById(this.config.dropdownId)
    if (dropdown) {
      dropdown.classList.remove('hidden')
      
      // 更新当前语言的选中状态
      this.updateCheckMarks()
    }
  }
  
  /**
   * 关闭语言下拉菜单
   */
  closeDropdown(): void {
    const dropdown = document.getElementById(this.config.dropdownId)
    if (dropdown) {
      dropdown.classList.add('hidden')
    }
  }
  
  /**
   * 更新语言选择器显示
   */
  updateSwitcherDisplay(lang: string): void {
    if (!this.i18n) return
    
    // 更新当前语言名称
    const currentLangName = document.getElementById(this.config.currentLangNameId)
    if (currentLangName) {
      currentLangName.textContent = this.i18n.getLanguageName(lang, true)
    }
    
    // 更新勾选标记
    this.updateCheckMarks()
  }
  
  /**
   * 更新勾选标记
   */
  private updateCheckMarks(): void {
    const lang = this.currentLanguage
    
    // 桌面端语言选项
    document.querySelectorAll(`#${this.config.desktopListId} [data-check]`).forEach(icon => {
      const iconLang = (icon as HTMLElement).dataset.check
      if (iconLang === lang) {
        icon.classList.remove('hidden')
      } else {
        icon.classList.add('hidden')
      }
    })
    
    // 移动端语言选项
    document.querySelectorAll(`#${this.config.mobileListId} [data-check-mobile]`).forEach(icon => {
      const iconLang = (icon as HTMLElement).dataset.checkMobile
      if (iconLang === lang) {
        icon.classList.remove('hidden')
      } else {
        icon.classList.add('hidden')
      }
    })
  }
  
  /**
   * 翻译文本 (便捷方法)
   */
  t(key: string): string {
    if (!this.i18n) {
      console.warn('[LanguageManager] I18n 服务未初始化')
      return key
    }
    return this.i18n.t(key)
  }
  
  /**
   * 更新 DOM 中的所有翻译 (便捷方法)
   */
  updateDOM(): void {
    if (this.i18n) {
      this.i18n.updateDOM()
    }
  }
}

// 单例实例
let languageManagerInstance: LanguageManager | null = null

/**
 * 获取 LanguageManager 单例
 */
export function getLanguageManager(config?: LanguageManagerConfig): LanguageManager {
  if (!languageManagerInstance) {
    languageManagerInstance = new LanguageManager(config)
  }
  return languageManagerInstance
}

/**
 * 创建新的 LanguageManager 实例 (仅用于测试)
 */
export function createLanguageManager(config?: LanguageManagerConfig): LanguageManager {
  languageManagerInstance = new LanguageManager(config)
  return languageManagerInstance
}
