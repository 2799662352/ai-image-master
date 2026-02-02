// tests/features/SiteManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SiteManager,
  createSiteManager,
  getSiteManager,
  type SiteConfig
} from '../../src/renderer/src/features/settings/SiteManager'

// Mock window.aiImageAPI
const createMockApi = () => ({
  getAllSites: vi.fn(() => ({
    'apiyi': { name: 'API Yi', baseURL: 'https://api.apiyi.com', isCustom: false },
    'custom-1': { name: 'My Custom', baseURL: 'https://custom.example.com', isCustom: true }
  })),
  currentSite: 'apiyi',
  apiKey: 'test-api-key',
  getCurrentSite: vi.fn(() => ({
    name: 'API Yi',
    baseURL: 'https://api.apiyi.com',
    defaultApiKey: 'test-key'
  })),
  saveSite: vi.fn(),
  getStoredApiKey: vi.fn(() => 'stored-key'),
  getStoredVisionApiKey: vi.fn(() => ''),
  saveApiKey: vi.fn(() => true),
  saveVisionApiKey: vi.fn(() => true),
  addCustomSite: vi.fn(() => true),
  updateCustomSite: vi.fn(() => true),
  removeCustomSite: vi.fn()
})

let mockApiImageAPI = createMockApi()

describe('SiteManager', () => {
  let manager: SiteManager
  let mockShowToast: ReturnType<typeof vi.fn>
  let mockUpdateApiStatus: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // Reset mock API for each test
    mockApiImageAPI = createMockApi()

    // Setup DOM with comprehensive elements
    document.body.innerHTML = `
      <div id="siteCardsContainer"></div>
      <div id="currentSiteHint"><span></span></div>
      <div id="settingsModal" class="hidden"></div>
      <div id="customSiteModal" class="hidden">
        <div id="customSiteModalTitle"></div>
        <input id="editingSiteKey" type="hidden" />
        <input id="customSiteName" />
        <input id="customSiteBaseURL" />
        <input id="customSitePathPrefix" />
        <input id="customSiteApiKey" />
        <textarea id="customSiteDescription"></textarea>
        <button id="cancelCustomSite"></button>
        <button id="saveCustomSite"></button>
      </div>
      <input id="apiKeyInput" type="password" value="" />
      <input id="visionApiKeyInput" value="" />
      <button id="addCustomSiteBtn"></button>
      <button id="closeSettingsX"></button>
      <button id="closeSettings"></button>
      <button id="saveApiConfig"></button>
      <button id="testConnection"><i class="fas fa-plug mr-2"></i>测试连接</button>
      <button id="toggleApiKeyVisibility"><i class="fa-eye"></i></button>
      <button id="toggleHowToGet"></button>
      <div id="howToGetContent" class="hidden"></div>
      <i id="howToGetIcon"></i>
      <button id="settingsBtn" class="border-gray-200 text-gray-600"><i></i><span></span></button>
      <button id="settingsBtnMobile" class="border-gray-200 text-gray-600"><i></i><span></span></button>
    `

    // Setup global mocks
    ;(window as any).aiImageAPI = mockApiImageAPI
    ;(window as any).i18n = {
      t: vi.fn((key: string) => key),
      updateDOM: vi.fn()
    }

    vi.clearAllMocks()
    
    // Mock window.alert and confirm for validation tests
    window.alert = vi.fn()
    window.confirm = vi.fn(() => true)

    mockShowToast = vi.fn()
    mockUpdateApiStatus = vi.fn()

    manager = createSiteManager({
      showToast: mockShowToast,
      updateApiStatus: mockUpdateApiStatus
    })
  })

  afterEach(() => {
    manager.destroy()
    document.body.innerHTML = ''
    delete (window as any).aiImageAPI
    delete (window as any).i18n
  })

  describe('renderSiteCards', () => {
    it('should render site cards into container', () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      expect(container?.children.length).toBe(2)
    })

    it('should mark current site as selected', () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const selectedCard = container?.querySelector('[data-site-key="apiyi"]')
      expect(selectedCard?.classList.contains('border-blue-500')).toBe(true)
    })

    it('should add custom badge to custom sites', () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]')
      expect(customCard?.innerHTML).toContain('fa-user')
    })
  })

  describe('selectSite', () => {
    it('should call saveSite on API', () => {
      manager.selectSite('custom-1')

      expect(mockApiImageAPI.saveSite).toHaveBeenCalledWith('custom-1')
    })

    it('should update API key input', () => {
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement

      manager.selectSite('apiyi')

      expect(apiKeyInput.value).toBe('stored-key')
    })
  })

  describe('updateCurrentSiteHint', () => {
    it('should show hint with default key message', () => {
      manager.updateCurrentSiteHint()

      const hint = document.getElementById('currentSiteHint')
      const span = hint?.querySelector('span')
      expect(span?.textContent).toContain('已配置默认 Key')
    })
  })

  describe('openAddModal', () => {
    it('should show modal and clear form', () => {
      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      nameInput.value = 'Previous Value'

      manager.openAddModal()

      const modal = document.getElementById('customSiteModal')
      expect(modal?.classList.contains('hidden')).toBe(false)
      expect(nameInput.value).toBe('')
    })
  })

  describe('openEditModal', () => {
    it('should fill form with site data', () => {
      const site = {
        name: 'Test Site',
        baseURL: 'https://test.com',
        pathPrefix: '/v1',
        defaultApiKey: 'key-123'
      }

      manager.openEditModal('test-site', site)

      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement

      expect(nameInput.value).toBe('Test Site')
      expect(urlInput.value).toBe('https://test.com')
    })
  })

  describe('closeModal', () => {
    it('should hide the modal', () => {
      const modal = document.getElementById('customSiteModal')
      modal?.classList.remove('hidden')

      manager.closeModal()

      expect(modal?.classList.contains('hidden')).toBe(true)
    })
  })

  describe('saveFromModal', () => {
    it('should validate required fields', () => {
      const alertMock = vi.fn()
      vi.stubGlobal('alert', alertMock)

      const result = manager.saveFromModal()

      expect(result).toBe(false)
      expect(alertMock).toHaveBeenCalledWith('请输入站点名称')

      vi.unstubAllGlobals()
    })

    it('should validate URL format', () => {
      const alertMock = vi.fn()
      vi.stubGlobal('alert', alertMock)

      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement
      nameInput.value = 'Test'
      urlInput.value = 'not-a-valid-url'

      const result = manager.saveFromModal()

      expect(result).toBe(false)
      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('URL 格式不正确'))

      vi.unstubAllGlobals()
    })

    it('should add new custom site', () => {
      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement
      nameInput.value = 'New Site'
      urlInput.value = 'https://new-site.com'

      const result = manager.saveFromModal()

      expect(result).toBe(true)
      expect(mockApiImageAPI.addCustomSite).toHaveBeenCalled()
    })

    it('should update existing custom site', () => {
      const editingKey = document.getElementById('editingSiteKey') as HTMLInputElement
      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement

      editingKey.value = 'existing-site'
      nameInput.value = 'Updated Site'
      urlInput.value = 'https://updated.com'

      const result = manager.saveFromModal()

      expect(result).toBe(true)
      expect(mockApiImageAPI.updateCustomSite).toHaveBeenCalledWith(
        'existing-site',
        expect.objectContaining({ name: 'Updated Site' })
      )
    })
  })

  describe('initSettingsModalEvents', () => {
    it('should bind add button click', () => {
      manager.initSettingsModalEvents()

      const addBtn = document.getElementById('addCustomSiteBtn')
      addBtn?.click()

      const modal = document.getElementById('customSiteModal')
      expect(modal?.classList.contains('hidden')).toBe(false)
    })

    it('should bind close buttons', () => {
      manager.initSettingsModalEvents()

      const settingsModal = document.getElementById('settingsModal')
      settingsModal?.classList.remove('hidden')

      const closeBtn = document.getElementById('closeSettingsX')
      closeBtn?.click()

      expect(settingsModal?.classList.contains('hidden')).toBe(true)
    })

    it('should toggle API key visibility', () => {
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      const toggleBtn = document.getElementById('toggleApiKeyVisibility')

      expect(apiKeyInput.type).toBe('password')

      toggleBtn?.click()

      expect(apiKeyInput.type).toBe('text')
    })
  })

  describe('getSiteManager singleton', () => {
    it('should return the same instance', () => {
      const manager1 = getSiteManager()
      const manager2 = getSiteManager()

      expect(manager1).toBe(manager2)
    })
  })

  describe('renderSiteCards edge cases', () => {
    it('should handle missing container gracefully', () => {
      document.getElementById('siteCardsContainer')?.remove()
      
      // Should not throw
      expect(() => manager.renderSiteCards()).not.toThrow()
    })

    it('should handle missing API gracefully', () => {
      delete (window as any).aiImageAPI
      
      // Should not throw
      expect(() => manager.renderSiteCards()).not.toThrow()
    })

    it('should attach click handler that selects site', () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement
      
      customCard?.click()

      expect(mockApiImageAPI.saveSite).toHaveBeenCalledWith('custom-1')
    })

    it('should use default icon for unknown sites', () => {
      mockApiImageAPI.getAllSites.mockReturnValue({
        'unknown-site': { name: 'Unknown', baseURL: 'https://unknown.com', isCustom: false }
      })

      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      expect(container?.innerHTML).toContain('fa-globe')
    })
  })

  describe('context menu for custom sites', () => {
    it('should show context menu on right-click of custom site', () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement

      const contextMenuEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200
      })
      customCard?.dispatchEvent(contextMenuEvent)

      const menu = document.getElementById('siteContextMenu')
      expect(menu).toBeTruthy()
      expect(menu?.innerHTML).toContain('编辑')
      expect(menu?.innerHTML).toContain('删除')
    })

    it('should close context menu on outside click', async () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement

      const contextMenuEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200
      })
      customCard?.dispatchEvent(contextMenuEvent)

      // Wait for the setTimeout in showContextMenu
      await new Promise(resolve => setTimeout(resolve, 10))

      // Click outside
      document.body.click()

      const menu = document.getElementById('siteContextMenu')
      expect(menu).toBeNull()
    })

    it('should open edit modal when edit is clicked', async () => {
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement

      const contextMenuEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200
      })
      customCard?.dispatchEvent(contextMenuEvent)

      const menu = document.getElementById('siteContextMenu')
      const editBtn = menu?.querySelector('[data-action="edit"]') as HTMLElement
      editBtn?.click()

      const modal = document.getElementById('customSiteModal')
      expect(modal?.classList.contains('hidden')).toBe(false)
    })

    it('should delete site when delete is confirmed', async () => {
      // Use stubGlobal for proper confirm mock
      const confirmMock = vi.fn(() => true)
      vi.stubGlobal('confirm', confirmMock)

      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement

      const contextMenuEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200
      })
      customCard?.dispatchEvent(contextMenuEvent)

      const menu = document.getElementById('siteContextMenu')
      const deleteBtn = menu?.querySelector('[data-action="delete"]') as HTMLElement
      deleteBtn?.click()

      expect(confirmMock).toHaveBeenCalled()
      expect(mockApiImageAPI.removeCustomSite).toHaveBeenCalledWith('custom-1')

      vi.unstubAllGlobals()
    })

    it('should not delete site when delete is cancelled', async () => {
      vi.stubGlobal('confirm', vi.fn(() => false))
      
      manager.renderSiteCards()

      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement

      const contextMenuEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200
      })
      customCard?.dispatchEvent(contextMenuEvent)

      const menu = document.getElementById('siteContextMenu')
      const deleteBtn = menu?.querySelector('[data-action="delete"]') as HTMLElement
      deleteBtn?.click()

      expect(mockApiImageAPI.removeCustomSite).not.toHaveBeenCalled()

      vi.unstubAllGlobals()
    })
  })

  describe('selectSite edge cases', () => {
    it('should handle missing API gracefully', () => {
      delete (window as any).aiImageAPI
      
      expect(() => manager.selectSite('apiyi')).not.toThrow()
    })

    it('should update vision API key input', () => {
      mockApiImageAPI.getStoredVisionApiKey.mockReturnValue('vision-key-123')
      const visionInput = document.getElementById('visionApiKeyInput') as HTMLInputElement

      manager.selectSite('apiyi')

      expect(visionInput.value).toBe('vision-key-123')
    })

    it('should use default API key when no stored key', () => {
      mockApiImageAPI.getStoredApiKey.mockReturnValue('')
      // Update getAllSites to include defaultApiKey
      mockApiImageAPI.getAllSites.mockReturnValue({
        'apiyi': { name: 'API Yi', baseURL: 'https://api.apiyi.com', isCustom: false, defaultApiKey: 'default-key' },
        'custom-1': { name: 'My Custom', baseURL: 'https://custom.example.com', isCustom: true }
      })
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement

      manager.selectSite('apiyi')

      expect(apiKeyInput.value).toBe('default-key')
    })
  })

  describe('updateCurrentSiteHint edge cases', () => {
    it('should handle missing API gracefully', () => {
      delete (window as any).aiImageAPI
      
      expect(() => manager.updateCurrentSiteHint()).not.toThrow()
    })

    it('should handle missing hint element gracefully', () => {
      document.getElementById('currentSiteHint')?.remove()
      
      expect(() => manager.updateCurrentSiteHint()).not.toThrow()
    })

    it('should handle missing span in hint element', () => {
      const hint = document.getElementById('currentSiteHint')
      if (hint) hint.innerHTML = ''
      
      expect(() => manager.updateCurrentSiteHint()).not.toThrow()
    })

    it('should show different message when no default key', () => {
      mockApiImageAPI.getCurrentSite.mockReturnValue({
        name: 'No Key Site',
        baseURL: 'https://nokey.com',
        defaultApiKey: ''
      })

      manager.updateCurrentSiteHint()

      const span = document.querySelector('#currentSiteHint span')
      expect(span?.textContent).toContain('请输入')
    })
  })

  describe('openSettingsModal', () => {
    it('should show modal and render site cards', () => {
      manager.openSettingsModal()

      const modal = document.getElementById('settingsModal')
      expect(modal?.classList.contains('hidden')).toBe(false)
    })

    it('should load stored API key', () => {
      mockApiImageAPI.getStoredApiKey.mockReturnValue('my-stored-key')

      manager.openSettingsModal()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      expect(apiKeyInput.value).toBe('my-stored-key')
    })

    it('should load stored vision API key', () => {
      mockApiImageAPI.getStoredVisionApiKey.mockReturnValue('vision-key')

      manager.openSettingsModal()

      const visionInput = document.getElementById('visionApiKeyInput') as HTMLInputElement
      expect(visionInput.value).toBe('vision-key')
    })

    it('should handle missing modal gracefully', () => {
      document.getElementById('settingsModal')?.remove()
      
      expect(() => manager.openSettingsModal()).not.toThrow()
    })
  })

  describe('closeSettingsModal', () => {
    it('should hide the settings modal', () => {
      const modal = document.getElementById('settingsModal')
      modal?.classList.remove('hidden')

      manager.closeSettingsModal()

      expect(modal?.classList.contains('hidden')).toBe(true)
    })

    it('should handle missing modal gracefully', () => {
      document.getElementById('settingsModal')?.remove()
      
      expect(() => manager.closeSettingsModal()).not.toThrow()
    })
  })

  describe('saveApiKeyPublic', () => {
    it('should return false when API key is empty', async () => {
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = ''

      const result = await manager.saveApiKeyPublic()

      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith('请输入图片生成 API Key', 'error')
    })

    it('should save API key successfully', async () => {
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'test-api-key'

      const result = await manager.saveApiKeyPublic()

      expect(result).toBe(true)
      expect(mockApiImageAPI.saveApiKey).toHaveBeenCalledWith('test-api-key')
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('保存成功'), 'success')
    })

    it('should save vision API key when provided', async () => {
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      const visionInput = document.getElementById('visionApiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'test-api-key'
      visionInput.value = 'vision-api-key'

      await manager.saveApiKeyPublic()

      expect(mockApiImageAPI.saveVisionApiKey).toHaveBeenCalledWith('vision-api-key')
    })

    it('should handle save failure', async () => {
      mockApiImageAPI.saveApiKey.mockReturnValue(false)
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'test-api-key'

      const result = await manager.saveApiKeyPublic()

      expect(result).toBe(false)
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringContaining('保存失败'), 'error')
    })

    it('should close modal on success and update API status', async () => {
      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'test-api-key'
      const modal = document.getElementById('settingsModal')
      modal?.classList.remove('hidden')

      await manager.saveApiKeyPublic()

      expect(modal?.classList.contains('hidden')).toBe(true)
      expect(mockUpdateApiStatus).toHaveBeenCalledWith(true)
    })
  })

  describe('updateApiStatusDisplay', () => {
    it('should show active status when connected', () => {
      manager.updateApiStatusDisplay(true)

      const btn = document.getElementById('settingsBtn')
      expect(btn?.classList.contains('border-green-400')).toBe(true)
      expect(btn?.querySelector('.status-badge')).toBeTruthy()
    })

    it('should show active status when API key exists', () => {
      mockApiImageAPI.apiKey = 'some-key'

      manager.updateApiStatusDisplay(false)

      const btn = document.getElementById('settingsBtn')
      expect(btn?.classList.contains('border-green-400')).toBe(true)
    })

    it('should show inactive status when not connected and no key', () => {
      mockApiImageAPI.apiKey = ''

      manager.updateApiStatusDisplay(false)

      const btn = document.getElementById('settingsBtn')
      expect(btn?.classList.contains('border-gray-200')).toBe(true)
    })

    it('should update mobile button as well', () => {
      manager.updateApiStatusDisplay(true)

      const mobileBtn = document.getElementById('settingsBtnMobile')
      expect(mobileBtn?.classList.contains('border-green-400')).toBe(true)
    })

    it('should remove status badge when inactive', () => {
      // First make it active
      manager.updateApiStatusDisplay(true)
      
      // Then make it inactive
      mockApiImageAPI.apiKey = ''
      manager.updateApiStatusDisplay(false)

      const btn = document.getElementById('settingsBtn')
      expect(btn?.querySelector('.status-badge')).toBeNull()
    })

    it('should use fallback text when i18n is unavailable', () => {
      delete (window as any).i18n

      manager.updateApiStatusDisplay(true)

      const span = document.querySelector('#settingsBtn span')
      expect(span?.textContent).toBe('已设置')
    })
  })

  describe('initSettingsModalEvents - extended', () => {
    it('should close modal on outside click', () => {
      manager.initSettingsModalEvents()

      const modal = document.getElementById('settingsModal')
      modal?.classList.remove('hidden')

      // Simulate click on modal background
      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: modal })
      modal?.dispatchEvent(clickEvent)

      expect(modal?.classList.contains('hidden')).toBe(true)
    })

    it('should close custom site modal on outside click', () => {
      manager.initSettingsModalEvents()

      const modal = document.getElementById('customSiteModal')
      modal?.classList.remove('hidden')

      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: modal })
      modal?.dispatchEvent(clickEvent)

      expect(modal?.classList.contains('hidden')).toBe(true)
    })

    it('should save and close when save button is clicked', () => {
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'my-key'

      const saveBtn = document.getElementById('saveApiConfig')
      saveBtn?.click()

      expect(mockApiImageAPI.saveApiKey).toHaveBeenCalledWith('my-key')
    })

    it('should toggle API key visibility back to password', () => {
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      const toggleBtn = document.getElementById('toggleApiKeyVisibility')

      // Toggle to text
      toggleBtn?.click()
      expect(apiKeyInput.type).toBe('text')

      // Toggle back to password
      toggleBtn?.click()
      expect(apiKeyInput.type).toBe('password')
    })

    it('should toggle how to get content visibility', () => {
      manager.initSettingsModalEvents()

      const content = document.getElementById('howToGetContent')
      const toggleBtn = document.getElementById('toggleHowToGet')
      const icon = document.getElementById('howToGetIcon')

      toggleBtn?.click()

      expect(content?.classList.contains('hidden')).toBe(false)
      expect(icon?.classList.contains('rotate-180')).toBe(true)
    })

    it('should bind cancel button to close modal', () => {
      manager.initSettingsModalEvents()

      const modal = document.getElementById('customSiteModal')
      modal?.classList.remove('hidden')

      const cancelBtn = document.getElementById('cancelCustomSite')
      cancelBtn?.click()

      expect(modal?.classList.contains('hidden')).toBe(true)
    })

    it('should bind save custom site button', () => {
      manager.initSettingsModalEvents()

      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement
      nameInput.value = 'Test Site'
      urlInput.value = 'https://test.com'

      const saveBtn = document.getElementById('saveCustomSite')
      saveBtn?.click()

      expect(mockApiImageAPI.addCustomSite).toHaveBeenCalled()
    })
  })

  describe('testConnection via initSettingsModalEvents', () => {
    it('should test connection successfully', async () => {
      const alertMock = vi.fn()
      const fetchMock = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('alert', alertMock)
      vi.stubGlobal('fetch', fetchMock)
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'test-key'

      const testBtn = document.getElementById('testConnection') as HTMLButtonElement
      testBtn?.click()

      // Wait for async operations
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalled()
      })

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.apiyi.com/v1/models',
        expect.objectContaining({
          method: 'GET',
          headers: { 'Authorization': 'Bearer test-key' }
        })
      )

      vi.unstubAllGlobals()
    })

    it('should show alert when no API key for test', async () => {
      const alertMock = vi.fn()
      vi.stubGlobal('alert', alertMock)
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = ''

      const testBtn = document.getElementById('testConnection') as HTMLButtonElement
      testBtn?.click()

      expect(alertMock).toHaveBeenCalledWith('请先输入 API Key')

      vi.unstubAllGlobals()
    })

    it('should handle test connection failure', async () => {
      const alertMock = vi.fn()
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })
      vi.stubGlobal('alert', alertMock)
      vi.stubGlobal('fetch', fetchMock)
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'bad-key'

      const testBtn = document.getElementById('testConnection') as HTMLButtonElement
      testBtn?.click()

      // Wait for async operations
      await vi.waitFor(() => {
        expect(alertMock).toHaveBeenCalled()
      })

      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('连接失败'))

      vi.unstubAllGlobals()
    })

    it('should handle network error during test', async () => {
      const alertMock = vi.fn()
      const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'))
      vi.stubGlobal('alert', alertMock)
      vi.stubGlobal('fetch', fetchMock)
      manager.initSettingsModalEvents()

      const apiKeyInput = document.getElementById('apiKeyInput') as HTMLInputElement
      apiKeyInput.value = 'test-key'

      const testBtn = document.getElementById('testConnection') as HTMLButtonElement
      testBtn?.click()

      // Wait for async operations
      await vi.waitFor(() => {
        expect(alertMock).toHaveBeenCalled()
      })

      expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('Network error'))

      vi.unstubAllGlobals()
    })
  })

  describe('saveFromModal edge cases', () => {
    it('should validate base URL is required', () => {
      const alertMock = vi.fn()
      vi.stubGlobal('alert', alertMock)

      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      nameInput.value = 'Test Site'
      // baseURL is empty

      const result = manager.saveFromModal()

      expect(result).toBe(false)
      expect(alertMock).toHaveBeenCalledWith('请输入 Base URL')

      vi.unstubAllGlobals()
    })

    it('should handle save failure', () => {
      const alertMock = vi.fn()
      vi.stubGlobal('alert', alertMock)
      mockApiImageAPI.addCustomSite.mockReturnValue(false)

      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement
      nameInput.value = 'Test Site'
      urlInput.value = 'https://test.com'

      const result = manager.saveFromModal()

      expect(result).toBe(false)
      expect(alertMock).toHaveBeenCalledWith('保存失败，请重试')

      vi.unstubAllGlobals()
    })

    it('should set default description when empty', () => {
      const nameInput = document.getElementById('customSiteName') as HTMLInputElement
      const urlInput = document.getElementById('customSiteBaseURL') as HTMLInputElement
      nameInput.value = 'Test Site'
      urlInput.value = 'https://test.com'

      manager.saveFromModal()

      expect(mockApiImageAPI.addCustomSite).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ description: '用户自定义站点' })
      )
    })
  })

  describe('openEditModal', () => {
    it('should fill all form fields including description', () => {
      const site: SiteConfig = {
        name: 'Full Site',
        baseURL: 'https://full.com',
        pathPrefix: '/api/v1',
        defaultApiKey: 'full-key',
        description: 'A full description'
      }

      manager.openEditModal('full-site', site)

      const pathPrefix = document.getElementById('customSitePathPrefix') as HTMLInputElement
      const apiKey = document.getElementById('customSiteApiKey') as HTMLInputElement
      const description = document.getElementById('customSiteDescription') as HTMLTextAreaElement

      expect(pathPrefix.value).toBe('/api/v1')
      expect(apiKey.value).toBe('full-key')
      expect(description.value).toBe('A full description')
    })

    it('should handle missing optional fields', () => {
      const site: SiteConfig = {
        name: 'Minimal Site',
        baseURL: 'https://minimal.com'
      }

      manager.openEditModal('minimal-site', site)

      const pathPrefix = document.getElementById('customSitePathPrefix') as HTMLInputElement
      expect(pathPrefix.value).toBe('')
    })
  })

  describe('destroy', () => {
    it('should remove context menu on destroy', () => {
      // First create a context menu
      manager.renderSiteCards()
      const container = document.getElementById('siteCardsContainer')
      const customCard = container?.querySelector('[data-site-key="custom-1"]') as HTMLElement

      const contextMenuEvent = new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: 100,
        clientY: 200
      })
      customCard?.dispatchEvent(contextMenuEvent)

      // Verify menu exists
      expect(document.getElementById('siteContextMenu')).toBeTruthy()

      // Destroy
      manager.destroy()

      // Menu should be removed
      expect(document.getElementById('siteContextMenu')).toBeNull()
    })
  })

  describe('i18n integration', () => {
    it('should use i18n for status text when available', () => {
      // Set up i18n mock that returns translated values
      const i18nMock = {
        t: (key: string) => {
          if (key === 'nav.settingsButton.configured') return 'Configured'
          if (key === 'nav.settingsButton.notConfigured') return 'Not Configured'
          return key
        },
        updateDOM: vi.fn()
      }
      // Use Object.defineProperty to make it globally available
      Object.defineProperty(window, 'i18n', {
        value: i18nMock,
        writable: true,
        configurable: true
      })
      // Also set on global for the declare const i18n
      ;(globalThis as any).i18n = i18nMock

      manager.updateApiStatusDisplay(true)

      const span = document.querySelector('#settingsBtn span')
      expect(span?.textContent).toBe('Configured')

      // Clean up
      delete (globalThis as any).i18n
    })

    it('should handle i18n.t throwing error', () => {
      ;(window as any).i18n = {
        t: vi.fn(() => { throw new Error('i18n error') }),
        updateDOM: vi.fn()
      }

      // Should not throw
      expect(() => manager.updateApiStatusDisplay(true)).not.toThrow()

      const span = document.querySelector('#settingsBtn span')
      expect(span?.textContent).toBe('已设置')
    })
  })

  describe('createSiteManager', () => {
    it('should create manager without config', () => {
      const mgr = createSiteManager()
      expect(mgr).toBeInstanceOf(SiteManager)
    })

    it('should create manager with partial config', () => {
      const mgr = createSiteManager({ showToast: vi.fn() })
      expect(mgr).toBeInstanceOf(SiteManager)
    })
  })
})
