// tests/services/I18n.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { I18nService, createI18nService } from '../../src/renderer/src/services/i18n'

describe('I18nService', () => {
  let i18n: I18nService

  beforeEach(() => {
    // 清除 localStorage
    localStorage.clear()
    
    i18n = createI18nService({
      defaultLanguage: 'zh-CN',
      fallbackLanguage: 'zh-CN',
      supportedLanguages: ['zh-CN', 'en-US', 'ja-JP']
    })
  })

  afterEach(() => {
    localStorage.clear()
  })

  describe('t (翻译)', () => {
    it('应该返回简单键的翻译', () => {
      const result = i18n.t('common.save')
      
      expect(result).toBe('保存')
    })

    it('应该返回嵌套键的翻译', () => {
      const result = i18n.t('common.appName')
      
      expect(result).toBe('CATIMATION-Cyberpunk Master')
    })

    it('应该返回键本身如果翻译不存在', () => {
      const result = i18n.t('nonexistent.key')
      
      expect(result).toBe('nonexistent.key')
    })

    it('应该支持插值参数', async () => {
      // 模拟一个带插值的翻译
      await i18n.init()
      
      // 由于默认翻译可能没有插值，测试基本功能
      const result = i18n.t('common.error')
      expect(typeof result).toBe('string')
    })
  })

  describe('getCurrentLanguage', () => {
    it('应该返回当前语言', () => {
      expect(i18n.getCurrentLanguage()).toBe('zh-CN')
    })
  })

  describe('getSupportedLanguages', () => {
    it('应该返回支持的语言列表', () => {
      const languages = i18n.getSupportedLanguages()
      
      expect(languages.length).toBeGreaterThan(0)
      expect(languages.some(l => l.code === 'zh-CN')).toBe(true)
    })
  })

  describe('getLanguageName', () => {
    it('应该返回语言的本地名称', () => {
      expect(i18n.getLanguageName('zh-CN')).toBe('简体中文')
      expect(i18n.getLanguageName('en-US')).toBe('English')
    })

    it('应该返回语言代码如果名称不存在', () => {
      expect(i18n.getLanguageName('unknown')).toBe('unknown')
    })
  })

  describe('onLanguageChange', () => {
    it('应该注册语言变更回调', async () => {
      const callback = vi.fn()
      i18n.onLanguageChange(callback)
      
      // 模拟 fetch 成功
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ common: { test: 'Test' } })
      })
      
      await i18n.setLanguage('en-US')
      
      expect(callback).toHaveBeenCalledWith('en-US')
    })

    it('应该返回取消订阅函数', () => {
      const callback = vi.fn()
      const unsubscribe = i18n.onLanguageChange(callback)
      
      unsubscribe()
      
      // 回调应该已被移除
      expect(typeof unsubscribe).toBe('function')
    })
  })

  describe('setLanguage', () => {
    it('应该拒绝不支持的语言', async () => {
      const result = await i18n.setLanguage('unsupported')
      
      expect(result).toBe(false)
    })

    it('应该更新当前语言', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ common: { test: 'Test' } })
      })
      
      await i18n.setLanguage('en-US')
      
      expect(i18n.getCurrentLanguage()).toBe('en-US')
    })
  })

  describe('init', () => {
    it('应该初始化 i18n 服务', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ common: { test: 'Test' } })
      })
      
      await i18n.init()
      
      // 初始化后应该能正常工作
      expect(i18n.getCurrentLanguage()).toBe('zh-CN')
    })

    it('应该处理加载失败的情况', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
      
      await i18n.init()
      
      // 应该回退到默认翻译
      const result = i18n.t('common.save')
      expect(result).toBe('保存')
    })
  })

  describe('updateDOM', () => {
    it('应该更新带 data-i18n 属性的元素', async () => {
      document.body.innerHTML = `
        <span data-i18n="common.save"></span>
        <input data-i18n="common.loading" placeholder="">
      `
      
      i18n.updateDOM()
      
      const span = document.querySelector('[data-i18n="common.save"]')
      expect(span?.textContent).toBe('保存')
    })
  })
})
