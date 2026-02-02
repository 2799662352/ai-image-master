/** @vitest-environment jsdom */
// tests/features/Settings.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Settings, createSettings, SettingsOptions } from '../../src/renderer/src/features/settings/Settings'

describe('Settings', () => {
  let settings: Settings
  let mockModal: HTMLElement
  let mockApiKeyInput: HTMLInputElement
  let mockVisionApiKeyInput: HTMLInputElement
  let mockSettingsBtn: HTMLElement
  let mockSettingsBtnMobile: HTMLElement
  let mockCloseBtn: HTMLElement
  let mockSaveBtn: HTMLElement
  let mockShowToast: ReturnType<typeof vi.fn>
  let mockOnApiKeyChange: ReturnType<typeof vi.fn>
  let mockGetI18nText: ReturnType<typeof vi.fn>
  let mockApiService: {
    saveApiKey: ReturnType<typeof vi.fn>
    saveVisionApiKey: ReturnType<typeof vi.fn>
    getStoredApiKey: ReturnType<typeof vi.fn>
    getCurrentSite: ReturnType<typeof vi.fn>
    currentSite: string
    apiKey: string | null
  }

  function setupDOM() {
    // 创建设置模态框
    mockModal = document.createElement('div')
    mockModal.id = 'settingsModal'
    mockModal.classList.add('hidden')
    document.body.appendChild(mockModal)

    // 创建 API Key 输入框
    mockApiKeyInput = document.createElement('input')
    mockApiKeyInput.id = 'apiKeyInput'
    mockApiKeyInput.type = 'text'
    document.body.appendChild(mockApiKeyInput)

    // 创建 Vision API Key 输入框
    mockVisionApiKeyInput = document.createElement('input')
    mockVisionApiKeyInput.id = 'visionApiKeyInput'
    mockVisionApiKeyInput.type = 'text'
    document.body.appendChild(mockVisionApiKeyInput)

    // 创建设置按钮（桌面端）
    mockSettingsBtn = document.createElement('button')
    mockSettingsBtn.id = 'settingsBtn'
    const icon = document.createElement('i')
    icon.className = 'fas fa-cog'
    mockSettingsBtn.appendChild(icon)
    const span = document.createElement('span')
    span.textContent = '设置'
    mockSettingsBtn.appendChild(span)
    document.body.appendChild(mockSettingsBtn)

    // 创建设置按钮（移动端）
    mockSettingsBtnMobile = document.createElement('button')
    mockSettingsBtnMobile.id = 'settingsBtnMobile'
    const iconMobile = document.createElement('i')
    iconMobile.className = 'fas fa-cog'
    mockSettingsBtnMobile.appendChild(iconMobile)
    const spanMobile = document.createElement('span')
    spanMobile.textContent = '设置'
    mockSettingsBtnMobile.appendChild(spanMobile)
    document.body.appendChild(mockSettingsBtnMobile)

    // 创建关闭按钮
    mockCloseBtn = document.createElement('button')
    mockCloseBtn.id = 'closeSettingsX'
    document.body.appendChild(mockCloseBtn)

    // 创建保存按钮
    mockSaveBtn = document.createElement('button')
    mockSaveBtn.id = 'saveApiConfig'
    document.body.appendChild(mockSaveBtn)
  }

  function setupMocks() {
    mockShowToast = vi.fn()
    mockOnApiKeyChange = vi.fn()
    mockGetI18nText = vi.fn((key: string) => {
      const translations: Record<string, string> = {
        'nav.settingsButton.configured': 'Configured',
        'nav.settingsButton.notConfigured': 'Not Configured'
      }
      return translations[key] || key
    })

    mockApiService = {
      saveApiKey: vi.fn().mockReturnValue(true),
      saveVisionApiKey: vi.fn().mockReturnValue(true),
      getStoredApiKey: vi.fn().mockReturnValue('stored-api-key'),
      getCurrentSite: vi.fn().mockReturnValue({ name: 'Test Site', defaultApiKey: 'default-key' }),
      currentSite: 'test-site',
      apiKey: null
    }
    ;(window as any).aiImageAPI = mockApiService
    ;(window as any).renderSiteCards = vi.fn()
    ;(window as any).i18n = { updateDOM: vi.fn() }
  }

  beforeEach(() => {
    setupDOM()
    setupMocks()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    delete (window as any).aiImageAPI
    delete (window as any).renderSiteCards
    delete (window as any).i18n
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create instance with default options', () => {
      settings = new Settings()
      expect(settings).toBeInstanceOf(Settings)
    })

    it('should create instance with custom options', () => {
      const options: SettingsOptions = {
        showToast: mockShowToast,
        onApiKeyChange: mockOnApiKeyChange,
        getI18nText: mockGetI18nText
      }
      settings = new Settings(options)
      expect(settings).toBeInstanceOf(Settings)
    })
  })

  describe('createSettings factory function', () => {
    it('should create Settings instance', () => {
      settings = createSettings()
      expect(settings).toBeInstanceOf(Settings)
    })

    it('should create Settings instance with options', () => {
      settings = createSettings({ showToast: mockShowToast })
      expect(settings).toBeInstanceOf(Settings)
    })
  })

  describe('open()', () => {
    beforeEach(() => {
      settings = new Settings()
    })

    it('should remove hidden class from modal', () => {
      expect(mockModal.classList.contains('hidden')).toBe(true)
      settings.open()
      expect(mockModal.classList.contains('hidden')).toBe(false)
    })

    it('should call renderSiteCards if available', () => {
      settings.open()
      expect((window as any).renderSiteCards).toHaveBeenCalled()
    })

    it('should call i18n.updateDOM if available', () => {
      settings.open()
      expect((window as any).i18n.updateDOM).toHaveBeenCalled()
    })

    it('should load stored API key', () => {
      settings.open()
      expect(mockApiKeyInput.value).toBe('stored-api-key')
    })

    it('should use default API key if no stored key', () => {
      mockApiService.getStoredApiKey.mockReturnValue('')
      settings.open()
      expect(mockApiKeyInput.value).toBe('default-key')
    })

    it('should handle missing modal gracefully', () => {
      mockModal.remove()
      expect(() => settings.open()).not.toThrow()
    })

    it('should handle missing renderSiteCards gracefully', () => {
      delete (window as any).renderSiteCards
      expect(() => settings.open()).not.toThrow()
    })

    it('should handle missing i18n gracefully', () => {
      delete (window as any).i18n
      expect(() => settings.open()).not.toThrow()
    })

    it('should handle missing API service gracefully', () => {
      delete (window as any).aiImageAPI
      expect(() => settings.open()).not.toThrow()
    })

    it('should handle missing apiKeyInput gracefully', () => {
      mockApiKeyInput.remove()
      expect(() => settings.open()).not.toThrow()
    })
  })

  describe('close()', () => {
    beforeEach(() => {
      settings = new Settings()
    })

    it('should add hidden class to modal', () => {
      settings.open()
      expect(mockModal.classList.contains('hidden')).toBe(false)
      settings.close()
      expect(mockModal.classList.contains('hidden')).toBe(true)
    })

    it('should handle missing modal gracefully', () => {
      mockModal.remove()
      expect(() => settings.close()).not.toThrow()
    })
  })

  describe('saveApiKey()', () => {
    beforeEach(() => {
      settings = new Settings({
        showToast: mockShowToast,
        onApiKeyChange: mockOnApiKeyChange
      })
    })

    it('should return false and show error when API key is empty', async () => {
      mockApiKeyInput.value = ''
      const result = await settings.saveApiKey()
      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith('请输入图片生成 API Key', 'error')
    })

    it('should return false when API key is only whitespace', async () => {
      mockApiKeyInput.value = '   '
      const result = await settings.saveApiKey()
      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith('请输入图片生成 API Key', 'error')
    })

    it('should save API key successfully', async () => {
      mockApiKeyInput.value = 'test-api-key'
      mockVisionApiKeyInput.value = 'test-vision-key'
      
      const result = await settings.saveApiKey()
      
      expect(result).toBe(true)
      expect(mockApiService.saveApiKey).toHaveBeenCalledWith('test-api-key')
      expect(mockApiService.saveVisionApiKey).toHaveBeenCalledWith('test-vision-key')
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('图片生成 API Key 保存成功'),
        'success'
      )
    })

    it('should call onApiKeyChange callback on success', async () => {
      mockApiKeyInput.value = 'test-api-key'
      await settings.saveApiKey()
      expect(mockOnApiKeyChange).toHaveBeenCalledWith('test-api-key')
    })

    it('should close modal on success', async () => {
      mockApiKeyInput.value = 'test-api-key'
      settings.open()
      await settings.saveApiKey()
      expect(mockModal.classList.contains('hidden')).toBe(true)
    })

    it('should handle empty vision API key (clear message)', async () => {
      mockApiKeyInput.value = 'test-api-key'
      mockVisionApiKeyInput.value = ''
      
      await settings.saveApiKey()
      
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('图像理解 API Key 已清除'),
        'success'
      )
    })

    it('should return false when saveApiKey fails', async () => {
      mockApiKeyInput.value = 'test-api-key'
      mockApiService.saveApiKey.mockReturnValue(false)
      
      const result = await settings.saveApiKey()
      
      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('图片生成 API Key 保存失败'),
        'error'
      )
    })

    it('should handle missing API service', async () => {
      mockApiKeyInput.value = 'test-api-key'
      delete (window as any).aiImageAPI
      
      const result = await settings.saveApiKey()
      
      expect(result).toBe(false)
    })

    it('should handle missing apiKeyInput', async () => {
      mockApiKeyInput.remove()
      
      const result = await settings.saveApiKey()
      
      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith('请输入图片生成 API Key', 'error')
    })

    it('should handle missing visionApiKeyInput', async () => {
      mockApiKeyInput.value = 'test-api-key'
      mockVisionApiKeyInput.remove()
      
      const result = await settings.saveApiKey()
      
      expect(result).toBe(true)
      expect(mockApiService.saveVisionApiKey).toHaveBeenCalledWith('')
    })

    it('should trim whitespace from API keys', async () => {
      mockApiKeyInput.value = '  test-api-key  '
      mockVisionApiKeyInput.value = '  test-vision-key  '
      
      await settings.saveApiKey()
      
      expect(mockApiService.saveApiKey).toHaveBeenCalledWith('test-api-key')
      expect(mockApiService.saveVisionApiKey).toHaveBeenCalledWith('test-vision-key')
    })

    it('should work without showToast callback', async () => {
      settings = new Settings()
      mockApiKeyInput.value = 'test-api-key'
      
      const result = await settings.saveApiKey()
      expect(result).toBe(true)
    })

    it('should work without onApiKeyChange callback', async () => {
      settings = new Settings({ showToast: mockShowToast })
      mockApiKeyInput.value = 'test-api-key'
      
      const result = await settings.saveApiKey()
      expect(result).toBe(true)
    })
  })

  describe('updateApiStatus()', () => {
    beforeEach(() => {
      settings = new Settings({ getI18nText: mockGetI18nText })
    })

    it('should update button to active state when connected', () => {
      settings.updateApiStatus(true)
      
      const icon = mockSettingsBtn.querySelector('i')
      const span = mockSettingsBtn.querySelector('span')
      const badge = mockSettingsBtn.querySelector('.status-badge')
      
      expect(icon?.className).toContain('text-green-300')
      expect(span?.textContent).toBe('Configured')
      expect(badge?.className).toContain('bg-green-500')
    })

    it('should update button to active state when hasApiKey', () => {
      mockApiService.apiKey = 'some-key'
      settings.updateApiStatus(false)
      
      const icon = mockSettingsBtn.querySelector('i')
      expect(icon?.className).toContain('text-green-300')
    })

    it('should update button to inactive state', () => {
      mockApiService.apiKey = null
      settings.updateApiStatus(false)
      
      const icon = mockSettingsBtn.querySelector('i')
      const span = mockSettingsBtn.querySelector('span')
      const badge = mockSettingsBtn.querySelector('.status-badge')
      
      expect(icon?.className).toContain('text-red-300')
      expect(span?.textContent).toBe('Not Configured')
      expect(badge?.className).toContain('bg-red-500')
      expect(badge?.className).toContain('animate-pulse')
    })

    it('should update mobile button as well', () => {
      settings.updateApiStatus(true)
      
      const icon = mockSettingsBtnMobile.querySelector('i')
      expect(icon?.className).toContain('text-green-300')
    })

    it('should create badge if not exists', () => {
      expect(mockSettingsBtn.querySelector('.status-badge')).toBeNull()
      settings.updateApiStatus(true)
      expect(mockSettingsBtn.querySelector('.status-badge')).not.toBeNull()
    })

    it('should update existing badge', () => {
      settings.updateApiStatus(true)
      const badge1 = mockSettingsBtn.querySelector('.status-badge')
      expect(badge1?.className).toContain('bg-green-500')
      
      mockApiService.apiKey = null
      settings.updateApiStatus(false)
      const badge2 = mockSettingsBtn.querySelector('.status-badge')
      expect(badge2?.className).toContain('bg-red-500')
    })

    it('should use default text when no i18n', () => {
      settings = new Settings()
      mockApiService.apiKey = 'some-key'
      settings.updateApiStatus(false)
      
      const span = mockSettingsBtn.querySelector('span')
      expect(span?.textContent).toBe('已设置')
    })

    it('should show not configured default text', () => {
      settings = new Settings()
      mockApiService.apiKey = null
      settings.updateApiStatus(false)
      
      const span = mockSettingsBtn.querySelector('span')
      expect(span?.textContent).toBe('未设置')
    })

    it('should handle missing settingsBtn', () => {
      mockSettingsBtn.remove()
      expect(() => settings.updateApiStatus(true)).not.toThrow()
    })

    it('should handle missing settingsBtnMobile', () => {
      mockSettingsBtnMobile.remove()
      expect(() => settings.updateApiStatus(true)).not.toThrow()
    })

    it('should handle missing API service', () => {
      delete (window as any).aiImageAPI
      expect(() => settings.updateApiStatus(false)).not.toThrow()
    })

    it('should handle button without icon', () => {
      mockSettingsBtn.innerHTML = ''
      expect(() => settings.updateApiStatus(true)).not.toThrow()
    })

    it('should handle button without span', () => {
      mockSettingsBtn.querySelector('span')?.remove()
      expect(() => settings.updateApiStatus(true)).not.toThrow()
    })
  })

  describe('bindEvents()', () => {
    beforeEach(() => {
      settings = new Settings({
        showToast: mockShowToast,
        onApiKeyChange: mockOnApiKeyChange
      })
    })

    it('should bind click event to settingsBtn', () => {
      settings.bindEvents()
      mockSettingsBtn.click()
      expect(mockModal.classList.contains('hidden')).toBe(false)
    })

    it('should bind click event to settingsBtnMobile', () => {
      settings.bindEvents()
      mockSettingsBtnMobile.click()
      expect(mockModal.classList.contains('hidden')).toBe(false)
    })

    it('should bind click event to closeBtn', () => {
      settings.bindEvents()
      settings.open()
      mockCloseBtn.click()
      expect(mockModal.classList.contains('hidden')).toBe(true)
    })

    it('should bind click event to saveBtn', async () => {
      settings.bindEvents()
      mockApiKeyInput.value = 'test-key'
      
      mockSaveBtn.click()
      
      // 等待异步操作
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(mockApiService.saveApiKey).toHaveBeenCalled()
    })

    it('should close modal when clicking backdrop', () => {
      settings.bindEvents()
      settings.open()
      
      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: mockModal })
      mockModal.dispatchEvent(clickEvent)
      
      expect(mockModal.classList.contains('hidden')).toBe(true)
    })

    it('should not close modal when clicking inside modal content', () => {
      const modalContent = document.createElement('div')
      mockModal.appendChild(modalContent)
      
      settings.bindEvents()
      settings.open()
      
      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: modalContent })
      mockModal.dispatchEvent(clickEvent)
      
      expect(mockModal.classList.contains('hidden')).toBe(false)
    })

    it('should handle missing settingsBtn', () => {
      mockSettingsBtn.remove()
      expect(() => settings.bindEvents()).not.toThrow()
    })

    it('should handle missing settingsBtnMobile', () => {
      mockSettingsBtnMobile.remove()
      expect(() => settings.bindEvents()).not.toThrow()
    })

    it('should handle missing closeBtn', () => {
      mockCloseBtn.remove()
      expect(() => settings.bindEvents()).not.toThrow()
    })

    it('should handle missing saveBtn', () => {
      mockSaveBtn.remove()
      expect(() => settings.bindEvents()).not.toThrow()
    })

    it('should handle missing modal', () => {
      mockModal.remove()
      expect(() => settings.bindEvents()).not.toThrow()
    })
  })

  describe('integration tests', () => {
    it('should complete full settings flow', async () => {
      settings = new Settings({
        showToast: mockShowToast,
        onApiKeyChange: mockOnApiKeyChange,
        getI18nText: mockGetI18nText
      })
      
      // 绑定事件
      settings.bindEvents()
      
      // 初始状态检查
      expect(mockModal.classList.contains('hidden')).toBe(true)
      
      // 打开设置
      mockSettingsBtn.click()
      expect(mockModal.classList.contains('hidden')).toBe(false)
      expect(mockApiKeyInput.value).toBe('stored-api-key')
      
      // 修改并保存 API Key
      mockApiKeyInput.value = 'new-api-key'
      mockVisionApiKeyInput.value = 'new-vision-key'
      
      mockSaveBtn.click()
      await new Promise(resolve => setTimeout(resolve, 0))
      
      expect(mockApiService.saveApiKey).toHaveBeenCalledWith('new-api-key')
      expect(mockApiService.saveVisionApiKey).toHaveBeenCalledWith('new-vision-key')
      expect(mockOnApiKeyChange).toHaveBeenCalledWith('new-api-key')
      expect(mockModal.classList.contains('hidden')).toBe(true)
      
      // 更新状态
      mockApiService.apiKey = 'new-api-key'
      settings.updateApiStatus()
      
      const icon = mockSettingsBtn.querySelector('i')
      expect(icon?.className).toContain('text-green-300')
    })

    it('should handle settings open/close cycle multiple times', () => {
      settings = new Settings()
      settings.bindEvents()
      
      for (let i = 0; i < 3; i++) {
        settings.open()
        expect(mockModal.classList.contains('hidden')).toBe(false)
        
        settings.close()
        expect(mockModal.classList.contains('hidden')).toBe(true)
      }
    })

    it('should handle save failure gracefully', async () => {
      settings = new Settings({
        showToast: mockShowToast
      })
      
      mockApiService.saveApiKey.mockReturnValue(false)
      mockApiService.saveVisionApiKey.mockReturnValue(false)
      mockApiKeyInput.value = 'test-key'
      
      settings.open()
      const result = await settings.saveApiKey()
      
      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('保存失败'),
        'error'
      )
      // Modal should remain open on failure
      expect(mockModal.classList.contains('hidden')).toBe(false)
    })
  })
})
