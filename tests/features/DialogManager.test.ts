// tests/features/DialogManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DialogManager, createDialogManager } from '../../src/renderer/src/features/dialog'

describe('DialogManager', () => {
  let dialogManager: DialogManager
  let mockSettingsModal: HTMLElement
  let mockAboutModal: HTMLElement
  let mockActivityModal: HTMLElement

  beforeEach(() => {
    // 创建模拟的模态框元素
    mockSettingsModal = document.createElement('div')
    mockSettingsModal.id = 'settingsModal'
    mockSettingsModal.classList.add('hidden')
    document.body.appendChild(mockSettingsModal)

    mockAboutModal = document.createElement('div')
    mockAboutModal.id = 'aboutModal'
    mockAboutModal.classList.add('hidden')
    document.body.appendChild(mockAboutModal)

    mockActivityModal = document.createElement('div')
    mockActivityModal.id = 'activityModal'
    mockActivityModal.classList.add('hidden')
    document.body.appendChild(mockActivityModal)

    dialogManager = createDialogManager()
  })

  afterEach(() => {
    dialogManager.destroy()
    document.body.innerHTML = ''
  })

  describe('openSettings / closeSettings', () => {
    it('should open settings modal', () => {
      dialogManager.openSettings()
      expect(mockSettingsModal.classList.contains('hidden')).toBe(false)
      expect(dialogManager.isOpen('settingsModal')).toBe(true)
    })

    it('should close settings modal', () => {
      dialogManager.openSettings()
      dialogManager.closeSettings()
      expect(mockSettingsModal.classList.contains('hidden')).toBe(true)
      expect(dialogManager.isOpen('settingsModal')).toBe(false)
    })
  })

  describe('openAbout / closeAbout', () => {
    it('should open about modal', () => {
      dialogManager.openAbout()
      expect(mockAboutModal.classList.contains('hidden')).toBe(false)
      expect(dialogManager.isOpen('aboutModal')).toBe(true)
    })

    it('should close about modal', () => {
      dialogManager.openAbout()
      dialogManager.closeAbout()
      expect(mockAboutModal.classList.contains('hidden')).toBe(true)
      expect(dialogManager.isOpen('aboutModal')).toBe(false)
    })
  })

  describe('openActivity / closeActivity', () => {
    it('should open activity modal', () => {
      dialogManager.openActivity()
      expect(mockActivityModal.classList.contains('hidden')).toBe(false)
      expect(dialogManager.isOpen('activityModal')).toBe(true)
    })

    it('should close activity modal', () => {
      dialogManager.openActivity()
      dialogManager.closeActivity()
      expect(mockActivityModal.classList.contains('hidden')).toBe(true)
      expect(dialogManager.isOpen('activityModal')).toBe(false)
    })
  })

  describe('open / close generic', () => {
    it('should open modal by id', () => {
      dialogManager.open('settingsModal')
      expect(mockSettingsModal.classList.contains('hidden')).toBe(false)
    })

    it('should close modal by id', () => {
      dialogManager.open('settingsModal')
      dialogManager.close('settingsModal')
      expect(mockSettingsModal.classList.contains('hidden')).toBe(true)
    })

    it('should warn when modal not found', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      dialogManager.open('nonexistentModal')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Modal not found'))
      warnSpy.mockRestore()
    })
  })

  describe('closeAll', () => {
    it('should close all open modals', () => {
      dialogManager.openSettings()
      dialogManager.openAbout()
      expect(dialogManager.hasOpenDialogs()).toBe(true)
      
      dialogManager.closeAll()
      expect(dialogManager.hasOpenDialogs()).toBe(false)
      expect(mockSettingsModal.classList.contains('hidden')).toBe(true)
      expect(mockAboutModal.classList.contains('hidden')).toBe(true)
    })
  })

  describe('closeTopmost', () => {
    it('should close the most recently opened modal', () => {
      dialogManager.openSettings()
      dialogManager.openAbout()
      
      dialogManager.closeTopmost()
      expect(dialogManager.isOpen('aboutModal')).toBe(false)
      expect(dialogManager.isOpen('settingsModal')).toBe(true)
    })
  })

  describe('hasOpenDialogs', () => {
    it('should return false when no dialogs are open', () => {
      expect(dialogManager.hasOpenDialogs()).toBe(false)
    })

    it('should return true when dialogs are open', () => {
      dialogManager.openSettings()
      expect(dialogManager.hasOpenDialogs()).toBe(true)
    })
  })

  describe('getOpenDialogs', () => {
    it('should return list of open dialog ids', () => {
      dialogManager.openSettings()
      dialogManager.openAbout()
      
      const openDialogs = dialogManager.getOpenDialogs()
      expect(openDialogs).toContain('settingsModal')
      expect(openDialogs).toContain('aboutModal')
    })
  })

  describe('registerCallbacks', () => {
    it('should call onOpen callback when dialog opens', () => {
      const onOpen = vi.fn()
      dialogManager.registerCallbacks('settingsModal', { onOpen })
      
      dialogManager.openSettings()
      expect(onOpen).toHaveBeenCalled()
    })

    it('should call onClose callback when dialog closes', () => {
      const onClose = vi.fn()
      dialogManager.registerCallbacks('settingsModal', { onClose })
      
      dialogManager.openSettings()
      dialogManager.closeSettings()
      expect(onClose).toHaveBeenCalled()
    })
  })

  describe('config callbacks', () => {
    it('should call config onOpen callback', () => {
      const onOpen = vi.fn()
      const dm = createDialogManager({ onOpen })
      
      dm.openSettings()
      expect(onOpen).toHaveBeenCalledWith('settingsModal')
      dm.destroy()
    })

    it('should call config onClose callback', () => {
      const onClose = vi.fn()
      const dm = createDialogManager({ onClose })
      
      dm.openSettings()
      dm.closeSettings()
      expect(onClose).toHaveBeenCalledWith('settingsModal')
      dm.destroy()
    })
  })

  describe('backdrop click close', () => {
    it('should close modal when backdrop is clicked', () => {
      dialogManager.openSettings()
      
      // 模拟点击背景
      const clickEvent = new MouseEvent('click', { bubbles: true })
      Object.defineProperty(clickEvent, 'target', { value: mockSettingsModal })
      mockSettingsModal.dispatchEvent(clickEvent)
      
      expect(dialogManager.isOpen('settingsModal')).toBe(false)
    })
  })

  describe('escape key close', () => {
    it('should close topmost modal on Escape key', () => {
      dialogManager.openSettings()
      
      const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(escapeEvent)
      
      expect(dialogManager.isOpen('settingsModal')).toBe(false)
    })
  })
})
