/** @vitest-environment jsdom */
// tests/features/ModalFactory.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  ModalFactory,
  ModalConfig,
  NetworkRestrictedConfig,
  getModalFactory,
  createModalFactory
} from '../../src/renderer/src/features/dialog/ModalFactory'

describe('ModalFactory', () => {
  let modalFactory: ModalFactory

  beforeEach(() => {
    modalFactory = createModalFactory()
  })

  afterEach(() => {
    modalFactory.destroy()
    document.body.innerHTML = ''
  })

  describe('create()', () => {
    it('should create a basic modal with correct structure', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Test Title'
      }

      const modal = modalFactory.create(config)

      expect(modal).toBeInstanceOf(HTMLElement)
      expect(modal.classList.contains('fixed')).toBe(true)
      expect(modal.classList.contains('inset-0')).toBe(true)
      expect(modal.getAttribute('role')).toBe('dialog')
      expect(modal.getAttribute('aria-modal')).toBe('true')
      expect(document.body.contains(modal)).toBe(true)
    })

    it('should display the title correctly', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'My Modal Title'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('My Modal Title')
    })

    it('should display subtitle when provided', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        subtitle: 'My Subtitle'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('My Subtitle')
    })

    it('should display content when provided', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        content: '<p>Custom content here</p>'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('Custom content here')
    })

    it('should apply correct styles for error type', () => {
      const config: ModalConfig = {
        type: 'error',
        title: 'Error Title'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('bg-red-50')
      expect(modal.innerHTML).toContain('fa-exclamation-triangle')
      expect(modal.innerHTML).toContain('text-red-600')
    })

    it('should apply correct styles for warning type', () => {
      const config: ModalConfig = {
        type: 'warning',
        title: 'Warning Title'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('bg-yellow-50')
      expect(modal.innerHTML).toContain('fa-exclamation-circle')
      expect(modal.innerHTML).toContain('text-yellow-600')
    })

    it('should apply correct styles for success type', () => {
      const config: ModalConfig = {
        type: 'success',
        title: 'Success Title'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('bg-green-50')
      expect(modal.innerHTML).toContain('fa-check-circle')
      expect(modal.innerHTML).toContain('text-green-600')
    })

    it('should apply correct styles for info type', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Info Title'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('bg-blue-50')
      expect(modal.innerHTML).toContain('fa-info-circle')
      expect(modal.innerHTML).toContain('text-blue-600')
    })

    it('should apply correct styles for network-restricted type', () => {
      const config: ModalConfig = {
        type: 'network-restricted',
        title: 'Network Restricted'
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('bg-orange-50')
      expect(modal.innerHTML).toContain('fa-exclamation-triangle')
      expect(modal.innerHTML).toContain('text-orange-600')
    })

    it('should render action buttons when provided', () => {
      const onClick = vi.fn()
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        actions: [
          { label: 'Confirm', onClick, className: 'bg-blue-500' },
          { label: 'Cancel', onClick }
        ]
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('Confirm')
      expect(modal.innerHTML).toContain('Cancel')
      expect(modal.querySelectorAll('.modal-action-btn').length).toBe(2)
    })

    it('should render action button with icon when provided', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        actions: [
          { label: 'Save', onClick: vi.fn(), icon: 'fa-save' }
        ]
      }

      const modal = modalFactory.create(config)

      expect(modal.innerHTML).toContain('fa-save')
    })
  })

  describe('Modal Events', () => {
    it('should close modal when close button is clicked', () => {
      const onClose = vi.fn()
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        onClose
      }

      const modal = modalFactory.create(config)
      const closeBtn = modal.querySelector('.modal-close-btn')

      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(document.body.contains(modal)).toBe(false)
      expect(onClose).toHaveBeenCalled()
    })

    it('should close modal when backdrop is clicked', () => {
      const onClose = vi.fn()
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        onClose
      }

      const modal = modalFactory.create(config)

      // Simulate backdrop click (click on modal itself, not its children)
      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: modal })
      modal.dispatchEvent(clickEvent)

      expect(document.body.contains(modal)).toBe(false)
      expect(onClose).toHaveBeenCalled()
    })

    it('should not close modal when content is clicked', () => {
      const onClose = vi.fn()
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        onClose
      }

      const modal = modalFactory.create(config)
      const content = modal.querySelector('.bg-white')

      // Simulate click on content
      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: content })
      modal.dispatchEvent(clickEvent)

      expect(document.body.contains(modal)).toBe(true)
      expect(onClose).not.toHaveBeenCalled()
    })

    it('should close modal on Escape key press', () => {
      const onClose = vi.fn()
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        onClose
      }

      const modal = modalFactory.create(config)

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(escapeEvent)

      expect(document.body.contains(modal)).toBe(false)
      expect(onClose).toHaveBeenCalled()
    })

    it('should call action onClick when action button is clicked', () => {
      const onClick = vi.fn()
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        actions: [{ label: 'Confirm', onClick }]
      }

      const modal = modalFactory.create(config)
      const actionBtn = modal.querySelector('.modal-action-btn')

      actionBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(onClick).toHaveBeenCalled()
    })
  })

  describe('closeModal()', () => {
    it('should remove modal from DOM', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title'
      }

      const modal = modalFactory.create(config)
      expect(document.body.contains(modal)).toBe(true)

      modalFactory.closeModal(modal)
      expect(document.body.contains(modal)).toBe(false)
    })
  })

  describe('closeAll()', () => {
    it('should close all open modals', () => {
      const modal1 = modalFactory.create({ type: 'info', title: 'Modal 1' })
      const modal2 = modalFactory.create({ type: 'warning', title: 'Modal 2' })
      const modal3 = modalFactory.create({ type: 'error', title: 'Modal 3' })

      expect(document.body.contains(modal1)).toBe(true)
      expect(document.body.contains(modal2)).toBe(true)
      expect(document.body.contains(modal3)).toBe(true)

      modalFactory.closeAll()

      expect(document.body.contains(modal1)).toBe(false)
      expect(document.body.contains(modal2)).toBe(false)
      expect(document.body.contains(modal3)).toBe(false)
    })
  })

  describe('destroy()', () => {
    it('should close all modals and clean up', () => {
      const modal1 = modalFactory.create({ type: 'info', title: 'Modal 1' })
      const modal2 = modalFactory.create({ type: 'error', title: 'Modal 2' })

      modalFactory.destroy()

      expect(document.body.contains(modal1)).toBe(false)
      expect(document.body.contains(modal2)).toBe(false)
    })
  })

  describe('createNetworkRestrictedModal()', () => {
    const createNetworkConfig = (): NetworkRestrictedConfig => ({
      inaccessibleUrls: ['https://blocked.example.com/image1.png'],
      allUrls: [
        'https://accessible.example.com/image1.png',
        'https://blocked.example.com/image1.png'
      ],
      content: '{"status": "success", "urls": [...]}',
      suggestions: ['Try using a VPN', 'Check your network settings'],
      showToast: vi.fn()
    })

    it('should create network restricted modal with correct structure', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      expect(modal).toBeInstanceOf(HTMLElement)
      expect(modal.getAttribute('role')).toBe('dialog')
      expect(modal.getAttribute('aria-modal')).toBe('true')
      expect(document.body.contains(modal)).toBe(true)
    })

    it('should display all URLs with accessibility status', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      expect(modal.innerHTML).toContain('accessible.example.com')
      expect(modal.innerHTML).toContain('blocked.example.com')
      expect(modal.innerHTML).toContain('可访问')
      expect(modal.innerHTML).toContain('网络受限')
    })

    it('should display suggestions', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      expect(modal.innerHTML).toContain('Try using a VPN')
      expect(modal.innerHTML).toContain('Check your network settings')
    })

    it('should display URL count correctly', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      expect(modal.innerHTML).toContain('2张')
    })

    it('should close when close button is clicked', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const closeBtn = modal.querySelector('.network-close-btn')
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(document.body.contains(modal)).toBe(false)
    })

    it('should close when footer close button is clicked', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const closeBtn = modal.querySelector('.network-close-btn-footer')
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

      expect(document.body.contains(modal)).toBe(false)
    })

    it('should close when backdrop is clicked', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: modal })
      modal.dispatchEvent(clickEvent)

      expect(document.body.contains(modal)).toBe(false)
    })

    it('should close on Escape key press', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(escapeEvent)

      expect(document.body.contains(modal)).toBe(false)
    })

    it('should copy URL when copy button is clicked', async () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      // Mock clipboard API
      const writeTextMock = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock }
      })

      const copyBtn = modal.querySelector('.copy-url-btn') as HTMLButtonElement
      copyBtn?.click()

      await vi.waitFor(() => {
        expect(writeTextMock).toHaveBeenCalled()
      })
    })

    it('should show toast on successful URL copy', async () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      // Mock clipboard API
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
      })

      const copyBtn = modal.querySelector('.copy-url-btn') as HTMLButtonElement
      copyBtn?.click()

      await vi.waitFor(() => {
        expect(config.showToast).toHaveBeenCalledWith('图片地址已复制', 'success')
      })
    })

    it('should show error toast when URL copy fails', async () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      // Mock clipboard API to reject
      Object.assign(navigator, {
        clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Copy failed')) }
      })

      const copyBtn = modal.querySelector('.copy-url-btn') as HTMLButtonElement
      copyBtn?.click()

      await vi.waitFor(() => {
        expect(config.showToast).toHaveBeenCalledWith('复制失败', 'error')
      })
    })

    it('should open URL in new window when open button is clicked', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

      const openBtn = modal.querySelector('.open-url-btn') as HTMLButtonElement
      openBtn?.click()

      expect(windowOpenSpy).toHaveBeenCalledWith(expect.any(String), '_blank')
      windowOpenSpy.mockRestore()
    })

    it('should copy all URLs when copy all button is clicked', async () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const writeTextMock = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, {
        clipboard: { writeText: writeTextMock }
      })

      const copyAllBtn = modal.querySelector('.copy-all-urls-btn') as HTMLButtonElement
      copyAllBtn?.click()

      await vi.waitFor(() => {
        expect(writeTextMock).toHaveBeenCalled()
        expect(config.showToast).toHaveBeenCalledWith('所有图片地址已复制', 'success')
      })
    })

    it('should toggle technical info visibility', () => {
      const config = createNetworkConfig()
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const toggleBtn = modal.querySelector('.toggle-technical-info')
      const techContent = modal.querySelector('.technical-info-content')

      expect(techContent?.classList.contains('hidden')).toBe(true)

      toggleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(techContent?.classList.contains('hidden')).toBe(false)

      toggleBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(techContent?.classList.contains('hidden')).toBe(true)
    })

    it('should call markUrlAsAccessible callback when mark button is clicked', () => {
      const markUrlAsAccessible = vi.fn()
      const config: NetworkRestrictedConfig = {
        ...createNetworkConfig(),
        markUrlAsAccessible
      }
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const markBtn = modal.querySelector('.mark-accessible-btn') as HTMLButtonElement
      markBtn?.click()

      expect(markUrlAsAccessible).toHaveBeenCalledWith('https://blocked.example.com/image1.png')
    })

    it('should save to history when save button is clicked', () => {
      const onSaveToHistory = vi.fn()
      const config: NetworkRestrictedConfig = {
        ...createNetworkConfig(),
        onSaveToHistory,
        currentPrompt: 'Test prompt'
      }
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const saveBtn = modal.querySelector('.save-to-history-btn') as HTMLButtonElement
      saveBtn?.click()

      expect(onSaveToHistory).toHaveBeenCalledWith(
        config.allUrls,
        'Test prompt',
        'network_restricted'
      )
      expect(config.showToast).toHaveBeenCalledWith('已保存到历史记录', 'success')
    })

    it('should use "未知提示词" when currentPrompt is not provided', () => {
      const onSaveToHistory = vi.fn()
      const config: NetworkRestrictedConfig = {
        ...createNetworkConfig(),
        onSaveToHistory
      }
      const modal = modalFactory.createNetworkRestrictedModal(config)

      const saveBtn = modal.querySelector('.save-to-history-btn') as HTMLButtonElement
      saveBtn?.click()

      expect(onSaveToHistory).toHaveBeenCalledWith(
        config.allUrls,
        '未知提示词',
        'network_restricted'
      )
    })
  })

  describe('Singleton pattern', () => {
    it('getModalFactory should return same instance', () => {
      const instance1 = getModalFactory()
      const instance2 = getModalFactory()

      expect(instance1).toBe(instance2)
    })

    it('createModalFactory should create new instance each time', () => {
      const instance1 = createModalFactory()
      const instance2 = createModalFactory()

      expect(instance1).not.toBe(instance2)

      instance1.destroy()
      instance2.destroy()
    })
  })

  describe('Multiple modals', () => {
    it('should track multiple active modals', () => {
      const modal1 = modalFactory.create({ type: 'info', title: 'Modal 1' })
      const modal2 = modalFactory.create({ type: 'warning', title: 'Modal 2' })

      expect(document.body.contains(modal1)).toBe(true)
      expect(document.body.contains(modal2)).toBe(true)

      modalFactory.closeModal(modal1)
      expect(document.body.contains(modal1)).toBe(false)
      expect(document.body.contains(modal2)).toBe(true)

      modalFactory.closeModal(modal2)
      expect(document.body.contains(modal2)).toBe(false)
    })
  })

  describe('Edge cases', () => {
    it('should handle modal without actions', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        content: 'Just content, no actions'
      }

      const modal = modalFactory.create(config)

      expect(modal.querySelectorAll('.modal-action-btn').length).toBe(0)
    })

    it('should handle empty actions array', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        actions: []
      }

      const modal = modalFactory.create(config)

      expect(modal.querySelectorAll('.modal-action-btn').length).toBe(0)
    })

    it('should handle action without className', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title',
        actions: [{ label: 'Default Style', onClick: vi.fn() }]
      }

      const modal = modalFactory.create(config)
      const actionBtn = modal.querySelector('.modal-action-btn')

      expect(actionBtn?.classList.contains('bg-gray-500')).toBe(true)
    })

    it('should handle closing already closed modal gracefully', () => {
      const config: ModalConfig = {
        type: 'info',
        title: 'Title'
      }

      const modal = modalFactory.create(config)
      modalFactory.closeModal(modal)

      // Should not throw
      expect(() => modalFactory.closeModal(modal)).not.toThrow()
    })

    it('should handle network modal with all accessible URLs', () => {
      const config: NetworkRestrictedConfig = {
        inaccessibleUrls: [],
        allUrls: ['https://accessible.example.com/image1.png'],
        content: '{}',
        suggestions: [],
        showToast: vi.fn()
      }

      const modal = modalFactory.createNetworkRestrictedModal(config)

      // Should not have mark-accessible buttons when all URLs are accessible
      expect(modal.querySelectorAll('.mark-accessible-btn').length).toBe(0)
    })
  })
})
