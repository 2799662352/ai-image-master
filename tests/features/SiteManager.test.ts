// tests/features/SiteManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SiteManager,
  createSiteManager,
  getSiteManager
} from '../../src/renderer/src/features/settings/SiteManager'

// Mock window.aiImageAPI
const mockApiImageAPI = {
  getAllSites: vi.fn(() => ({
    'apiyi': { name: 'API Yi', baseURL: 'https://api.apiyi.com', isCustom: false },
    'custom-1': { name: 'My Custom', baseURL: 'https://custom.example.com', isCustom: true }
  })),
  currentSite: 'apiyi',
  getCurrentSite: vi.fn(() => ({
    name: 'API Yi',
    baseURL: 'https://api.apiyi.com',
    defaultApiKey: 'test-key'
  })),
  saveSite: vi.fn(),
  getStoredApiKey: vi.fn(() => 'stored-key'),
  getStoredVisionApiKey: vi.fn(() => ''),
  saveApiKey: vi.fn(),
  saveVisionApiKey: vi.fn(),
  addCustomSite: vi.fn(() => true),
  updateCustomSite: vi.fn(() => true),
  removeCustomSite: vi.fn()
}

describe('SiteManager', () => {
  let manager: SiteManager

  beforeEach(() => {
    // Setup DOM
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
      <input id="apiKeyInput" type="password" />
      <input id="visionApiKeyInput" />
      <button id="addCustomSiteBtn"></button>
      <button id="closeSettingsX"></button>
      <button id="closeSettings"></button>
      <button id="saveApiConfig"></button>
      <button id="testConnection"></button>
      <button id="toggleApiKeyVisibility"><i class="fa-eye"></i></button>
      <button id="toggleHowToGet"></button>
      <div id="howToGetContent" class="hidden"></div>
      <i id="howToGetIcon"></i>
    `

    // Setup global mocks
    ;(window as any).aiImageAPI = mockApiImageAPI
    ;(window as any).i18n = {
      t: vi.fn((key: string) => key),
      updateDOM: vi.fn()
    }

    vi.clearAllMocks()
    
    // Mock window.alert for validation tests (after clearAllMocks)
    window.alert = vi.fn()

    manager = createSiteManager({
      showToast: vi.fn(),
      updateApiStatus: vi.fn()
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
})
