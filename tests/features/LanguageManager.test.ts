/**
 * LanguageManager 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LanguageManager,
  createLanguageManager,
  getLanguageManager,
  type I18nService
} from '../../src/renderer/src/features/language'

// Mock I18nService
function createMockI18n(): I18nService {
  return {
    init: vi.fn().mockResolvedValue('zh-CN'),
    t: vi.fn((key: string) => `translated:${key}`),
    getCurrentLanguage: vi.fn().mockReturnValue('zh-CN'),
    getLanguageName: vi.fn((lang: string, native?: boolean) => 
      native ? (lang === 'zh-CN' ? '简体中文' : 'English') : (lang === 'zh-CN' ? 'Chinese' : 'English')
    ),
    switchLanguage: vi.fn().mockResolvedValue(true),
    updateDOM: vi.fn()
  }
}

describe('LanguageManager', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="languageDropdown" class="hidden"></div>
      <span id="currentLangName"></span>
      <div id="languageList">
        <span data-check="zh-CN" class="hidden"></span>
        <span data-check="en" class="hidden"></span>
      </div>
      <div id="languageListMobile">
        <span data-check-mobile="zh-CN" class="hidden"></span>
        <span data-check-mobile="en" class="hidden"></span>
      </div>
      <title>Test</title>
      <meta name="description" content="">
      <meta name="keywords" content="">
      <meta property="og:title" content="">
      <meta property="og:description" content="">
      <meta name="twitter:title" content="">
      <meta name="twitter:description" content="">
    `
  })
  
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })
  
  describe('初始化', () => {
    it('使用默认配置创建实例', () => {
      const manager = createLanguageManager()
      expect(manager.getCurrentLanguage()).toBe('zh-CN')
    })
    
    it('使用自定义配置创建实例', () => {
      const manager = createLanguageManager({
        defaultLanguage: 'en',
        supportedLanguages: ['en', 'zh-CN', 'ja']
      })
      expect(manager.getCurrentLanguage()).toBe('en')
    })
    
    it('init 初始化 I18n 服务', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      
      const result = await manager.init(mockI18n)
      
      expect(mockI18n.init).toHaveBeenCalledTimes(1)
      expect(result).toBe('zh-CN')
      expect(manager.getCurrentLanguage()).toBe('zh-CN')
    })
    
    it('init 超时时使用默认语言', async () => {
      const manager = createLanguageManager({ defaultLanguage: 'en' })
      const mockI18n: I18nService = {
        ...createMockI18n(),
        init: vi.fn().mockImplementation(() => new Promise((_, reject) => 
          setTimeout(() => reject(new Error('timeout')), 2000)
        ))
      }
      
      // 使用更短的超时测试
      const result = await manager.init(mockI18n)
      
      // 由于超时，应该返回默认语言
      expect(result).toBe('en')
    })
  })
  
  describe('语言切换', () => {
    it('切换到支持的语言成功', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const result = await manager.switchLanguage('en')
      
      expect(result).toBe(true)
      expect(mockI18n.switchLanguage).toHaveBeenCalledWith('en')
      expect(manager.getCurrentLanguage()).toBe('en')
    })
    
    it('切换到不支持的语言失败', async () => {
      const manager = createLanguageManager({
        supportedLanguages: ['zh-CN', 'en']
      })
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const result = await manager.switchLanguage('ja')
      
      expect(result).toBe(false)
      expect(mockI18n.switchLanguage).not.toHaveBeenCalled()
    })
    
    it('I18n 未初始化时切换失败', async () => {
      const manager = createLanguageManager()
      
      const result = await manager.switchLanguage('en')
      
      expect(result).toBe(false)
    })
    
    it('触发语言变化回调', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const callback = vi.fn()
      manager.onLanguageChange(callback)
      
      await manager.switchLanguage('en')
      
      expect(callback).toHaveBeenCalledWith({
        previousLanguage: 'zh-CN',
        newLanguage: 'en'
      })
    })
    
    it('取消注册回调', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const callback = vi.fn()
      const unsubscribe = manager.onLanguageChange(callback)
      
      unsubscribe()
      
      await manager.switchLanguage('en')
      
      expect(callback).not.toHaveBeenCalled()
    })
  })
  
  describe('SEO 更新', () => {
    it('更新页面标题', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      manager.updateSEOForLanguage('zh-CN')
      
      expect(document.title).toBe('translated:seo.title')
    })
    
    it('更新 meta description', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      manager.updateSEOForLanguage('zh-CN')
      
      const meta = document.querySelector('meta[name="description"]')
      expect(meta?.getAttribute('content')).toBe('translated:seo.description')
    })
    
    it('更新 html lang 属性', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      manager.updateSEOForLanguage('en')
      
      expect(document.documentElement.lang).toBe('en')
    })
  })
  
  describe('下拉菜单', () => {
    it('toggleDropdown 切换显示状态', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const dropdown = document.getElementById('languageDropdown')!
      
      expect(dropdown.classList.contains('hidden')).toBe(true)
      
      manager.toggleDropdown()
      expect(dropdown.classList.contains('hidden')).toBe(false)
      
      manager.toggleDropdown()
      expect(dropdown.classList.contains('hidden')).toBe(true)
    })
    
    it('openDropdown 打开下拉菜单', () => {
      const manager = createLanguageManager()
      const dropdown = document.getElementById('languageDropdown')!
      
      manager.openDropdown()
      
      expect(dropdown.classList.contains('hidden')).toBe(false)
    })
    
    it('closeDropdown 关闭下拉菜单', () => {
      const manager = createLanguageManager()
      const dropdown = document.getElementById('languageDropdown')!
      dropdown.classList.remove('hidden')
      
      manager.closeDropdown()
      
      expect(dropdown.classList.contains('hidden')).toBe(true)
    })
  })
  
  describe('显示更新', () => {
    it('updateSwitcherDisplay 更新当前语言名称', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      manager.updateSwitcherDisplay('zh-CN')
      
      const nameEl = document.getElementById('currentLangName')
      expect(nameEl?.textContent).toBe('简体中文')
    })
    
    it('更新勾选标记', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      // 先切换到 en 才会更新内部状态
      await manager.switchLanguage('en')
      
      const zhCheck = document.querySelector('[data-check="zh-CN"]')
      const enCheck = document.querySelector('[data-check="en"]')
      
      expect(zhCheck?.classList.contains('hidden')).toBe(true)
      expect(enCheck?.classList.contains('hidden')).toBe(false)
    })
  })
  
  describe('便捷方法', () => {
    it('t() 翻译文本', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const result = manager.t('test.key')
      
      expect(result).toBe('translated:test.key')
    })
    
    it('t() 未初始化时返回 key', () => {
      const manager = createLanguageManager()
      
      const result = manager.t('test.key')
      
      expect(result).toBe('test.key')
    })
    
    it('getI18n() 返回 I18n 实例', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      expect(manager.getI18n()).toBe(mockI18n)
    })
    
    it('updateDOM() 调用 I18n updateDOM', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      manager.updateDOM()
      
      expect(mockI18n.updateDOM).toHaveBeenCalledTimes(1)
    })
  })
  
  describe('Toast 通知', () => {
    it('setToastFunction 设置 toast 函数', async () => {
      const manager = createLanguageManager()
      const mockI18n = createMockI18n()
      await manager.init(mockI18n)
      
      const toastFn = vi.fn()
      manager.setToastFunction(toastFn)
      
      await manager.switchLanguage('en')
      
      expect(toastFn).toHaveBeenCalledWith(
        expect.stringContaining('English'),
        'success'
      )
    })
  })
  
  describe('单例模式', () => {
    it('getLanguageManager 返回相同实例', () => {
      const instance1 = getLanguageManager()
      const instance2 = getLanguageManager()
      expect(instance1).toBe(instance2)
    })
  })
})
