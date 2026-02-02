/** @vitest-environment jsdom */
// tests/features/AccessibilityManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  AccessibilityManager,
  getAccessibilityManager,
  createAccessibilityManager,
  type AccessibilityConfig
} from '../../src/renderer/src/features/accessibility/AccessibilityManager'

describe('AccessibilityManager', () => {
  let manager: AccessibilityManager

  beforeEach(() => {
    // Clear document body before each test
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  afterEach(() => {
    if (manager) {
      manager.destroy()
    }
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  describe('Constructor', () => {
    it('should create instance with default config', () => {
      manager = new AccessibilityManager()
      expect(manager).toBeInstanceOf(AccessibilityManager)
    })

    it('should create instance with custom config', () => {
      const config: AccessibilityConfig = {
        skipLinkTargets: ['custom-content'],
        liveRegionId: 'custom-live-region',
        autoCreateLiveRegion: false,
        enhanceFocusVisibility: false
      }
      manager = new AccessibilityManager(config)
      expect(manager).toBeInstanceOf(AccessibilityManager)
    })

    it('should merge partial config with defaults', () => {
      const config: AccessibilityConfig = {
        liveRegionId: 'custom-live-region'
      }
      manager = new AccessibilityManager(config)
      expect(manager).toBeInstanceOf(AccessibilityManager)
    })
  })

  describe('init()', () => {
    it('should initialize accessibility features', () => {
      manager = new AccessibilityManager()
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      
      manager.init()
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('初始化可访问性功能'))
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('初始化完成'))
      consoleSpy.mockRestore()
    })

    it('should create ARIA live region when autoCreateLiveRegion is true', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      const liveRegion = document.getElementById('aria-live-region')
      expect(liveRegion).toBeTruthy()
      expect(liveRegion?.getAttribute('aria-live')).toBe('polite')
      expect(liveRegion?.getAttribute('aria-atomic')).toBe('true')
    })

    it('should not create live region when autoCreateLiveRegion is false', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: false })
      manager.init()
      
      const liveRegion = document.getElementById('aria-live-region')
      expect(liveRegion).toBeNull()
    })

    it('should use custom liveRegionId', () => {
      manager = new AccessibilityManager({
        autoCreateLiveRegion: true,
        liveRegionId: 'custom-announcer'
      })
      manager.init()
      
      const liveRegion = document.getElementById('custom-announcer')
      expect(liveRegion).toBeTruthy()
    })

    it('should reuse existing live region element', () => {
      // Create pre-existing live region
      const existingRegion = document.createElement('div')
      existingRegion.id = 'aria-live-region'
      existingRegion.textContent = 'existing content'
      document.body.appendChild(existingRegion)
      
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      const regions = document.querySelectorAll('#aria-live-region')
      expect(regions.length).toBe(1)
    })

    it('should add focus visibility styles when enhanceFocusVisibility is true', () => {
      manager = new AccessibilityManager({ enhanceFocusVisibility: true })
      manager.init()
      
      const styleElement = document.getElementById('accessibility-focus-styles')
      expect(styleElement).toBeTruthy()
      expect(styleElement?.textContent).toContain(':focus-visible')
    })

    it('should not add focus styles when enhanceFocusVisibility is false', () => {
      manager = new AccessibilityManager({ enhanceFocusVisibility: false })
      manager.init()
      
      const styleElement = document.getElementById('accessibility-focus-styles')
      expect(styleElement).toBeNull()
    })
  })

  describe('setupSkipLinks()', () => {
    it('should create skip links for existing target elements', () => {
      // Create target elements
      const mainContent = document.createElement('main')
      mainContent.id = 'main-content'
      document.body.appendChild(mainContent)
      
      manager = new AccessibilityManager({
        skipLinkTargets: ['main-content'],
        autoCreateLiveRegion: false
      })
      manager.init()
      
      const skipLinksContainer = document.getElementById('skip-links')
      expect(skipLinksContainer).toBeTruthy()
      
      const skipLink = skipLinksContainer?.querySelector('a[href="#main-content"]')
      expect(skipLink).toBeTruthy()
      expect(skipLink?.textContent).toBe('跳到主要内容')
    })

    it('should not create skip links for non-existent targets', () => {
      manager = new AccessibilityManager({
        skipLinkTargets: ['non-existent-element'],
        autoCreateLiveRegion: false
      })
      manager.init()
      
      // Skip links container should not be added if no valid targets
      const skipLinksContainer = document.getElementById('skip-links')
      expect(skipLinksContainer).toBeNull()
    })

    it('should not duplicate skip links on multiple init calls', () => {
      const mainContent = document.createElement('main')
      mainContent.id = 'main-content'
      document.body.appendChild(mainContent)
      
      manager = new AccessibilityManager({
        skipLinkTargets: ['main-content'],
        autoCreateLiveRegion: false
      })
      manager.init()
      manager.init()
      
      const containers = document.querySelectorAll('#skip-links')
      expect(containers.length).toBe(1)
    })

    it('should focus and scroll target when skip link is clicked', () => {
      const mainContent = document.createElement('main')
      mainContent.id = 'main-content'
      mainContent.tabIndex = -1
      // JSDOM doesn't have scrollIntoView by default, so we mock it
      mainContent.scrollIntoView = vi.fn()
      document.body.appendChild(mainContent)
      
      const focusSpy = vi.spyOn(mainContent, 'focus')
      const scrollSpy = vi.spyOn(mainContent, 'scrollIntoView')
      
      manager = new AccessibilityManager({
        skipLinkTargets: ['main-content'],
        autoCreateLiveRegion: false
      })
      manager.init()
      
      const skipLink = document.querySelector('a[href="#main-content"]') as HTMLAnchorElement
      skipLink.click()
      
      expect(focusSpy).toHaveBeenCalled()
      expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth' })
    })

    it('should add skip link styles', () => {
      const mainContent = document.createElement('main')
      mainContent.id = 'main-content'
      document.body.appendChild(mainContent)
      
      manager = new AccessibilityManager({
        skipLinkTargets: ['main-content'],
        autoCreateLiveRegion: false
      })
      manager.init()
      
      const styleElement = document.getElementById('accessibility-skip-link-styles')
      expect(styleElement).toBeTruthy()
      expect(styleElement?.textContent).toContain('.skip-link')
    })

    it('should provide default text for known skip targets', () => {
      const targets = ['main-content', 'navigation', 'search']
      targets.forEach(id => {
        const el = document.createElement('div')
        el.id = id
        document.body.appendChild(el)
      })
      
      manager = new AccessibilityManager({
        skipLinkTargets: targets,
        autoCreateLiveRegion: false
      })
      manager.init()
      
      expect(document.querySelector('a[href="#main-content"]')?.textContent).toBe('跳到主要内容')
      expect(document.querySelector('a[href="#navigation"]')?.textContent).toBe('跳到导航')
      expect(document.querySelector('a[href="#search"]')?.textContent).toBe('跳到搜索')
    })

    it('should provide fallback text for unknown skip targets', () => {
      const customTarget = document.createElement('div')
      customTarget.id = 'custom-section'
      document.body.appendChild(customTarget)
      
      manager = new AccessibilityManager({
        skipLinkTargets: ['custom-section'],
        autoCreateLiveRegion: false
      })
      manager.init()
      
      expect(document.querySelector('a[href="#custom-section"]')?.textContent).toBe('跳到 custom-section')
    })
  })

  describe('updateAriaLive()', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('should create live region if not exists', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: false })
      
      manager.updateAriaLive('Test message')
      
      const liveRegion = document.getElementById('aria-live-region')
      expect(liveRegion).toBeTruthy()
    })

    it('should update live region with polite priority by default', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      manager.updateAriaLive('Status update')
      
      const liveRegion = document.getElementById('aria-live-region')
      expect(liveRegion?.getAttribute('aria-live')).toBe('polite')
    })

    it('should update live region with assertive priority', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      manager.updateAriaLive('Important alert', 'assertive')
      
      const liveRegion = document.getElementById('aria-live-region')
      expect(liveRegion?.getAttribute('aria-live')).toBe('assertive')
    })

    it('should clear content before setting new message', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      const liveRegion = document.getElementById('aria-live-region')!
      liveRegion.textContent = 'Old message'
      
      manager.updateAriaLive('New message')
      
      // Content is cleared immediately
      expect(liveRegion.textContent).toBe('')
      
      // New content is set in requestAnimationFrame
      vi.runAllTimers()
      // Note: requestAnimationFrame callback is hard to test with fake timers
    })
  })

  describe('trapFocus()', () => {
    let container: HTMLElement
    let button1: HTMLButtonElement
    let button2: HTMLButtonElement
    let button3: HTMLButtonElement

    beforeEach(() => {
      container = document.createElement('div')
      
      button1 = document.createElement('button')
      button1.textContent = 'Button 1'
      
      button2 = document.createElement('button')
      button2.textContent = 'Button 2'
      
      button3 = document.createElement('button')
      button3.textContent = 'Button 3'
      
      container.appendChild(button1)
      container.appendChild(button2)
      container.appendChild(button3)
      document.body.appendChild(container)
    })

    it('should focus first focusable element by default', () => {
      manager = new AccessibilityManager()
      
      manager.trapFocus(container)
      
      expect(document.activeElement).toBe(button1)
    })

    it('should focus specified initial focus element', () => {
      button2.id = 'initial-focus'
      manager = new AccessibilityManager()
      
      manager.trapFocus(container, { initialFocus: '#initial-focus' })
      
      expect(document.activeElement).toBe(button2)
    })

    it('should fall back to first element if initialFocus not found', () => {
      manager = new AccessibilityManager()
      
      manager.trapFocus(container, { initialFocus: '#non-existent' })
      
      expect(document.activeElement).toBe(button1)
    })

    it('should return cleanup function', () => {
      manager = new AccessibilityManager()
      
      const cleanup = manager.trapFocus(container)
      
      expect(typeof cleanup).toBe('function')
    })

    it('should wrap focus from last to first on Tab', () => {
      manager = new AccessibilityManager()
      manager.trapFocus(container)
      
      button3.focus()
      
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: false,
        bubbles: true
      })
      
      const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault')
      container.dispatchEvent(tabEvent)
      
      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(document.activeElement).toBe(button1)
    })

    it('should wrap focus from first to last on Shift+Tab', () => {
      manager = new AccessibilityManager()
      manager.trapFocus(container)
      
      button1.focus()
      
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true
      })
      
      const preventDefaultSpy = vi.spyOn(tabEvent, 'preventDefault')
      container.dispatchEvent(tabEvent)
      
      expect(preventDefaultSpy).toHaveBeenCalled()
      expect(document.activeElement).toBe(button3)
    })

    it('should call onEscape callback when Escape is pressed with closeOnEscape', () => {
      const onEscape = vi.fn()
      manager = new AccessibilityManager()
      
      manager.trapFocus(container, { closeOnEscape: true, onEscape })
      
      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      })
      container.dispatchEvent(escapeEvent)
      
      expect(onEscape).toHaveBeenCalled()
    })

    it('should not call onEscape when closeOnEscape is false', () => {
      const onEscape = vi.fn()
      manager = new AccessibilityManager()
      
      manager.trapFocus(container, { closeOnEscape: false, onEscape })
      
      const escapeEvent = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true
      })
      container.dispatchEvent(escapeEvent)
      
      expect(onEscape).not.toHaveBeenCalled()
    })

    it('should restore focus to previous element on cleanup', () => {
      const outsideButton = document.createElement('button')
      outsideButton.textContent = 'Outside'
      document.body.appendChild(outsideButton)
      outsideButton.focus()
      
      manager = new AccessibilityManager()
      const cleanup = manager.trapFocus(container)
      
      cleanup()
      
      expect(document.activeElement).toBe(outsideButton)
    })

    it('should restore focus to returnFocus element if specified', () => {
      const returnButton = document.createElement('button')
      returnButton.textContent = 'Return'
      document.body.appendChild(returnButton)
      
      manager = new AccessibilityManager()
      const cleanup = manager.trapFocus(container, { returnFocus: returnButton })
      
      cleanup()
      
      expect(document.activeElement).toBe(returnButton)
    })

    it('should filter out disabled elements', () => {
      button1.disabled = true
      manager = new AccessibilityManager()
      
      manager.trapFocus(container)
      
      expect(document.activeElement).toBe(button2)
    })

    it('should use custom focusable selector', () => {
      const link = document.createElement('a')
      link.href = '#'
      link.textContent = 'Link'
      container.appendChild(link)
      
      manager = new AccessibilityManager()
      manager.trapFocus(container, { focusableSelector: 'a[href]' })
      
      expect(document.activeElement).toBe(link)
    })
  })

  describe('releaseFocusTrap()', () => {
    it('should release focus trap and restore focus', () => {
      const container = document.createElement('div')
      const button = document.createElement('button')
      container.appendChild(button)
      document.body.appendChild(container)
      
      const outsideButton = document.createElement('button')
      document.body.appendChild(outsideButton)
      outsideButton.focus()
      
      manager = new AccessibilityManager()
      manager.trapFocus(container)
      
      manager.releaseFocusTrap(container)
      
      expect(document.activeElement).toBe(outsideButton)
    })

    it('should do nothing if container has no active trap', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      
      manager = new AccessibilityManager()
      
      // Should not throw
      expect(() => manager.releaseFocusTrap(container)).not.toThrow()
    })
  })

  describe('restoreFocus()', () => {
    it('should restore focus to previous element', () => {
      const button = document.createElement('button')
      document.body.appendChild(button)
      button.focus()
      
      const container = document.createElement('div')
      const innerButton = document.createElement('button')
      container.appendChild(innerButton)
      document.body.appendChild(container)
      
      manager = new AccessibilityManager()
      manager.trapFocus(container)
      
      manager.restoreFocus()
      
      expect(document.activeElement).toBe(button)
    })

    it('should not focus if previous element is removed from DOM', () => {
      const button = document.createElement('button')
      document.body.appendChild(button)
      button.focus()
      
      const container = document.createElement('div')
      const innerButton = document.createElement('button')
      container.appendChild(innerButton)
      document.body.appendChild(container)
      
      manager = new AccessibilityManager()
      manager.trapFocus(container)
      
      // Remove the original button
      button.remove()
      
      manager.restoreFocus()
      
      // Should not throw, activeElement should not be the removed button
      expect(document.activeElement).not.toBe(button)
    })
  })

  describe('enableArrowNavigation()', () => {
    let container: HTMLElement
    let items: HTMLButtonElement[]

    beforeEach(() => {
      container = document.createElement('div')
      items = []
      
      for (let i = 0; i < 3; i++) {
        const item = document.createElement('button')
        item.setAttribute('role', 'menuitem')
        item.textContent = `Item ${i + 1}`
        items.push(item)
        container.appendChild(item)
      }
      
      document.body.appendChild(container)
    })

    it('should navigate down with ArrowDown in vertical mode', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { vertical: true })
      
      items[0].focus()
      
      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      container.dispatchEvent(arrowDownEvent)
      
      expect(document.activeElement).toBe(items[1])
    })

    it('should navigate up with ArrowUp in vertical mode', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { vertical: true })
      
      items[1].focus()
      
      const arrowUpEvent = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true
      })
      container.dispatchEvent(arrowUpEvent)
      
      expect(document.activeElement).toBe(items[0])
    })

    it('should navigate right with ArrowRight in horizontal mode', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { horizontal: true, vertical: false })
      
      items[0].focus()
      
      const arrowRightEvent = new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true
      })
      container.dispatchEvent(arrowRightEvent)
      
      expect(document.activeElement).toBe(items[1])
    })

    it('should navigate left with ArrowLeft in horizontal mode', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { horizontal: true, vertical: false })
      
      items[1].focus()
      
      const arrowLeftEvent = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        bubbles: true
      })
      container.dispatchEvent(arrowLeftEvent)
      
      expect(document.activeElement).toBe(items[0])
    })

    it('should loop from last to first when loop is true', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { vertical: true, loop: true })
      
      items[2].focus()
      
      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      container.dispatchEvent(arrowDownEvent)
      
      expect(document.activeElement).toBe(items[0])
    })

    it('should loop from first to last when loop is true', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { vertical: true, loop: true })
      
      items[0].focus()
      
      const arrowUpEvent = new KeyboardEvent('keydown', {
        key: 'ArrowUp',
        bubbles: true
      })
      container.dispatchEvent(arrowUpEvent)
      
      expect(document.activeElement).toBe(items[2])
    })

    it('should not loop when loop is false', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { vertical: true, loop: false })
      
      items[2].focus()
      
      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      container.dispatchEvent(arrowDownEvent)
      
      // Should stay on last item
      expect(document.activeElement).toBe(items[2])
    })

    it('should navigate to first item on Home key', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container)
      
      items[2].focus()
      
      const homeEvent = new KeyboardEvent('keydown', {
        key: 'Home',
        bubbles: true
      })
      container.dispatchEvent(homeEvent)
      
      expect(document.activeElement).toBe(items[0])
    })

    it('should navigate to last item on End key', () => {
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container)
      
      items[0].focus()
      
      const endEvent = new KeyboardEvent('keydown', {
        key: 'End',
        bubbles: true
      })
      container.dispatchEvent(endEvent)
      
      expect(document.activeElement).toBe(items[2])
    })

    it('should skip disabled elements', () => {
      items[1].disabled = true
      
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, { vertical: true })
      
      items[0].focus()
      
      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      container.dispatchEvent(arrowDownEvent)
      
      expect(document.activeElement).toBe(items[2])
    })

    it('should return cleanup function that removes listener', () => {
      manager = new AccessibilityManager()
      const cleanup = manager.enableArrowNavigation(container, { vertical: true })
      
      items[0].focus()
      cleanup()
      
      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      container.dispatchEvent(arrowDownEvent)
      
      // Should not navigate after cleanup
      expect(document.activeElement).toBe(items[0])
    })

    it('should use custom selector', () => {
      // Add a different element type
      const customItem = document.createElement('div')
      customItem.setAttribute('role', 'custom')
      customItem.tabIndex = 0
      container.appendChild(customItem)
      
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container, {
        selector: '[role="custom"]',
        vertical: true
      })
      
      customItem.focus()
      
      // Only custom elements should be navigable
      const arrowDownEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      container.dispatchEvent(arrowDownEvent)
      
      // Should stay on custom item since it's the only one matching selector
      expect(document.activeElement).toBe(customItem)
    })
  })

  describe('setAriaAttributes()', () => {
    let element: HTMLElement

    beforeEach(() => {
      element = document.createElement('div')
      document.body.appendChild(element)
    })

    it('should set aria attribute with string value', () => {
      manager = new AccessibilityManager()
      
      manager.setAriaAttributes(element, { label: 'Test label' })
      
      expect(element.getAttribute('aria-label')).toBe('Test label')
    })

    it('should set aria attribute with boolean true value', () => {
      manager = new AccessibilityManager()
      
      manager.setAriaAttributes(element, { expanded: true })
      
      expect(element.getAttribute('aria-expanded')).toBe('true')
    })

    it('should remove aria attribute with boolean false value', () => {
      element.setAttribute('aria-hidden', 'true')
      
      manager = new AccessibilityManager()
      
      manager.setAriaAttributes(element, { hidden: false })
      
      expect(element.hasAttribute('aria-hidden')).toBe(false)
    })

    it('should set multiple aria attributes at once', () => {
      manager = new AccessibilityManager()
      
      manager.setAriaAttributes(element, {
        label: 'Button',
        pressed: true,
        describedby: 'description'
      })
      
      expect(element.getAttribute('aria-label')).toBe('Button')
      expect(element.getAttribute('aria-pressed')).toBe('true')
      expect(element.getAttribute('aria-describedby')).toBe('description')
    })
  })

  describe('updateLoadingState()', () => {
    let element: HTMLElement

    beforeEach(() => {
      element = document.createElement('button')
      document.body.appendChild(element)
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
    })

    it('should set busy and disabled when loading', () => {
      manager.updateLoadingState(element, true)
      
      expect(element.getAttribute('aria-busy')).toBe('true')
      expect(element.getAttribute('aria-disabled')).toBe('true')
    })

    it('should remove busy and disabled when not loading', () => {
      manager.updateLoadingState(element, true)
      manager.updateLoadingState(element, false)
      
      expect(element.hasAttribute('aria-busy')).toBe(false)
      expect(element.hasAttribute('aria-disabled')).toBe(false)
    })

    it('should announce message when loading with message', () => {
      const updateSpy = vi.spyOn(manager, 'updateAriaLive')
      
      manager.updateLoadingState(element, true, 'Loading data...')
      
      expect(updateSpy).toHaveBeenCalledWith('Loading data...', 'polite')
    })

    it('should announce assertive message when loading complete', () => {
      const updateSpy = vi.spyOn(manager, 'updateAriaLive')
      
      manager.updateLoadingState(element, false, 'Data loaded')
      
      expect(updateSpy).toHaveBeenCalledWith('Data loaded', 'assertive')
    })
  })

  describe('announceAlert()', () => {
    it('should announce message with assertive priority', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      const updateSpy = vi.spyOn(manager, 'updateAriaLive')
      
      manager.announceAlert('Error occurred!')
      
      expect(updateSpy).toHaveBeenCalledWith('Error occurred!', 'assertive')
    })
  })

  describe('announceStatus()', () => {
    it('should announce message with polite priority', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      const updateSpy = vi.spyOn(manager, 'updateAriaLive')
      
      manager.announceStatus('Item saved')
      
      expect(updateSpy).toHaveBeenCalledWith('Item saved', 'polite')
    })
  })

  describe('destroy()', () => {
    it('should remove live region', () => {
      manager = new AccessibilityManager({ autoCreateLiveRegion: true })
      manager.init()
      
      expect(document.getElementById('aria-live-region')).toBeTruthy()
      
      manager.destroy()
      
      expect(document.getElementById('aria-live-region')).toBeNull()
    })

    it('should remove skip links', () => {
      const mainContent = document.createElement('main')
      mainContent.id = 'main-content'
      document.body.appendChild(mainContent)
      
      manager = new AccessibilityManager({
        skipLinkTargets: ['main-content'],
        autoCreateLiveRegion: false
      })
      manager.init()
      
      expect(document.getElementById('skip-links')).toBeTruthy()
      
      manager.destroy()
      
      expect(document.getElementById('skip-links')).toBeNull()
    })

    it('should release all active focus traps', () => {
      const container1 = document.createElement('div')
      const button1 = document.createElement('button')
      container1.appendChild(button1)
      document.body.appendChild(container1)
      
      const container2 = document.createElement('div')
      const button2 = document.createElement('button')
      container2.appendChild(button2)
      document.body.appendChild(container2)
      
      manager = new AccessibilityManager()
      manager.trapFocus(container1)
      manager.trapFocus(container2)
      
      manager.destroy()
      
      // Focus traps should be cleared - attempting to release should do nothing
      expect(() => manager.releaseFocusTrap(container1)).not.toThrow()
      expect(() => manager.releaseFocusTrap(container2)).not.toThrow()
    })
  })

  describe('Singleton Pattern', () => {
    beforeEach(() => {
      // Reset singleton before each test by creating new instance
      createAccessibilityManager()
    })

    afterEach(() => {
      // Reset singleton by creating new instance
      createAccessibilityManager()
    })

    it('getAccessibilityManager should return same instance', () => {
      // Reset to ensure clean state
      createAccessibilityManager()
      
      const instance1 = getAccessibilityManager()
      const instance2 = getAccessibilityManager()
      
      expect(instance1).toBe(instance2)
    })

    it('getAccessibilityManager should use config on first call', () => {
      // First reset singleton, then create with custom config
      const instance = createAccessibilityManager({
        liveRegionId: 'singleton-live-region'
      })
      
      instance.init()
      
      const liveRegion = document.getElementById('singleton-live-region')
      expect(liveRegion).toBeTruthy()
      
      instance.destroy()
    })

    it('createAccessibilityManager should create new instance', () => {
      const instance1 = createAccessibilityManager()
      const instance2 = createAccessibilityManager()
      
      // Both calls return the manager, but the second replaces the singleton
      expect(instance1).toBeInstanceOf(AccessibilityManager)
      expect(instance2).toBeInstanceOf(AccessibilityManager)
    })

    it('createAccessibilityManager should replace singleton', () => {
      const instance1 = getAccessibilityManager()
      createAccessibilityManager({ liveRegionId: 'new-live-region' })
      const instance2 = getAccessibilityManager()
      
      // instance2 should be the new instance
      instance2.init()
      expect(document.getElementById('new-live-region')).toBeTruthy()
      
      instance2.destroy()
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty container in trapFocus', () => {
      const emptyContainer = document.createElement('div')
      document.body.appendChild(emptyContainer)
      
      manager = new AccessibilityManager()
      
      // Should not throw
      const cleanup = manager.trapFocus(emptyContainer)
      expect(typeof cleanup).toBe('function')
      cleanup()
    })

    it('should handle Tab in focus trap with no focusable elements', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      
      manager = new AccessibilityManager()
      manager.trapFocus(container)
      
      const tabEvent = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true
      })
      
      // Should not throw
      expect(() => container.dispatchEvent(tabEvent)).not.toThrow()
    })

    it('should handle arrow navigation with no items', () => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container)
      
      const arrowEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      
      // Should not throw
      expect(() => container.dispatchEvent(arrowEvent)).not.toThrow()
    })

    it('should handle arrow navigation when focus is outside items', () => {
      const container = document.createElement('div')
      const item = document.createElement('button')
      item.setAttribute('role', 'menuitem')
      container.appendChild(item)
      document.body.appendChild(container)
      
      const outsideButton = document.createElement('button')
      document.body.appendChild(outsideButton)
      outsideButton.focus()
      
      manager = new AccessibilityManager()
      manager.enableArrowNavigation(container)
      
      const arrowEvent = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true
      })
      
      // Should not throw or change focus (focus is outside container)
      expect(() => container.dispatchEvent(arrowEvent)).not.toThrow()
      expect(document.activeElement).toBe(outsideButton)
    })
  })
})
