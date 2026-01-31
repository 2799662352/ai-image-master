// tests/features/MobileMenuManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MobileMenuManager, createMobileMenuManager } from '../../src/renderer/src/features/mobile-menu'

describe('MobileMenuManager', () => {
  let menuManager: MobileMenuManager
  let mockMenu: HTMLElement
  let mockMenuBtn: HTMLElement
  let mockLine1: HTMLElement
  let mockLine2: HTMLElement
  let mockLine3: HTMLElement

  beforeEach(() => {
    // 创建模拟的菜单元素
    mockMenu = document.createElement('div')
    mockMenu.id = 'mobileMenu'
    mockMenu.classList.add('hidden')
    document.body.appendChild(mockMenu)

    mockMenuBtn = document.createElement('button')
    mockMenuBtn.id = 'mobileMenuBtn'
    document.body.appendChild(mockMenuBtn)

    mockLine1 = document.createElement('div')
    mockLine1.id = 'menuLine1'
    document.body.appendChild(mockLine1)

    mockLine2 = document.createElement('div')
    mockLine2.id = 'menuLine2'
    document.body.appendChild(mockLine2)

    mockLine3 = document.createElement('div')
    mockLine3.id = 'menuLine3'
    document.body.appendChild(mockLine3)

    menuManager = createMobileMenuManager()
    menuManager.init()
  })

  afterEach(() => {
    menuManager.destroy()
    document.body.innerHTML = ''
  })

  describe('init', () => {
    it('should bind click event to menu button', () => {
      expect(menuManager.isOpen()).toBe(false)
      
      mockMenuBtn.click()
      expect(menuManager.isOpen()).toBe(true)
    })
  })

  describe('open', () => {
    it('should show menu', () => {
      menuManager.open()
      expect(mockMenu.classList.contains('hidden')).toBe(false)
      expect(menuManager.isOpen()).toBe(true)
    })

    it('should animate hamburger to X', () => {
      menuManager.open()
      expect(mockLine1.style.transform).toContain('rotate')
      expect(mockLine2.style.opacity).toBe('0')
      expect(mockLine3.style.transform).toContain('rotate')
    })

    it('should call onOpen callback', () => {
      const onOpen = vi.fn()
      const manager = createMobileMenuManager({ onOpen })
      manager.init()
      
      manager.open()
      expect(onOpen).toHaveBeenCalled()
      
      manager.destroy()
    })
  })

  describe('close', () => {
    it('should hide menu', () => {
      menuManager.open()
      menuManager.close()
      expect(mockMenu.classList.contains('hidden')).toBe(true)
      expect(menuManager.isOpen()).toBe(false)
    })

    it('should reset hamburger animation', () => {
      menuManager.open()
      menuManager.close()
      expect(mockLine1.style.transform).toBe('')
      expect(mockLine2.style.opacity).toBe('')
      expect(mockLine3.style.transform).toBe('')
    })

    it('should call onClose callback', () => {
      const onClose = vi.fn()
      const manager = createMobileMenuManager({ onClose })
      manager.init()
      
      manager.open()
      manager.close()
      expect(onClose).toHaveBeenCalled()
      
      manager.destroy()
    })
  })

  describe('toggle', () => {
    it('should open menu when closed', () => {
      menuManager.toggle()
      expect(menuManager.isOpen()).toBe(true)
    })

    it('should close menu when open', () => {
      menuManager.open()
      menuManager.toggle()
      expect(menuManager.isOpen()).toBe(false)
    })
  })

  describe('isOpen', () => {
    it('should return false initially', () => {
      expect(menuManager.isOpen()).toBe(false)
    })

    it('should return true after opening', () => {
      menuManager.open()
      expect(menuManager.isOpen()).toBe(true)
    })
  })

  describe('isMobileViewport', () => {
    it('should check viewport width against breakpoint', () => {
      // 默认断点是 768px
      Object.defineProperty(window, 'innerWidth', { value: 500, writable: true })
      expect(menuManager.isMobileViewport()).toBe(true)
      
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true })
      expect(menuManager.isMobileViewport()).toBe(false)
    })
  })

  describe('resize handler', () => {
    it('should close menu when viewport exceeds breakpoint', () => {
      menuManager.open()
      expect(menuManager.isOpen()).toBe(true)
      
      Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true })
      window.dispatchEvent(new Event('resize'))
      
      expect(menuManager.isOpen()).toBe(false)
    })
  })

  describe('destroy', () => {
    it('should close menu and remove event listeners', () => {
      menuManager.open()
      menuManager.destroy()
      
      expect(menuManager.isOpen()).toBe(false)
    })
  })

  describe('custom config', () => {
    it('should use custom element ids', () => {
      const customMenu = document.createElement('div')
      customMenu.id = 'customMenu'
      customMenu.classList.add('hidden')
      document.body.appendChild(customMenu)

      const manager = createMobileMenuManager({
        menuId: 'customMenu'
      })
      manager.init()
      
      manager.open()
      expect(customMenu.classList.contains('hidden')).toBe(false)
      
      manager.destroy()
    })

    it('should use custom breakpoint', () => {
      const manager = createMobileMenuManager({
        breakpoint: 1024
      })
      manager.init()
      
      Object.defineProperty(window, 'innerWidth', { value: 800, writable: true })
      expect(manager.isMobileViewport()).toBe(true)
      
      Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true })
      expect(manager.isMobileViewport()).toBe(false)
      
      manager.destroy()
    })
  })
})
