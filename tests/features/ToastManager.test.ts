/** @vitest-environment jsdom */
// tests/features/ToastManager.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { 
  ToastManager, 
  getToastManager, 
  createToastManager,
  ToastType,
  ToastConfig 
} from '../../src/renderer/src/features/toast/ToastManager'

describe('ToastManager', () => {
  let toastManager: ToastManager
  let mockToastContainer: HTMLElement
  let mockToastIcon: HTMLElement
  let mockToastMessage: HTMLElement

  beforeEach(() => {
    // Create mock DOM elements
    mockToastContainer = document.createElement('div')
    mockToastContainer.id = 'toast'
    mockToastContainer.classList.add('hidden')
    document.body.appendChild(mockToastContainer)

    mockToastIcon = document.createElement('span')
    mockToastIcon.id = 'toastIcon'
    document.body.appendChild(mockToastIcon)

    mockToastMessage = document.createElement('span')
    mockToastMessage.id = 'toastMessage'
    document.body.appendChild(mockToastMessage)

    // Use fake timers for testing auto-dismiss
    vi.useFakeTimers()

    toastManager = createToastManager()
  })

  afterEach(() => {
    toastManager.destroy()
    document.body.innerHTML = ''
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  describe('instance creation', () => {
    it('should create instance with default config', () => {
      const manager = createToastManager()
      expect(manager).toBeInstanceOf(ToastManager)
      manager.destroy()
    })

    it('should create instance with custom config', () => {
      const customConfig: ToastConfig = {
        duration: 5000,
        containerId: 'customToast',
        iconId: 'customIcon',
        messageId: 'customMessage'
      }
      const manager = createToastManager(customConfig)
      expect(manager).toBeInstanceOf(ToastManager)
      manager.destroy()
    })

    it('should merge custom config with defaults', () => {
      // Create elements with custom IDs
      const customContainer = document.createElement('div')
      customContainer.id = 'customToast'
      customContainer.classList.add('hidden')
      document.body.appendChild(customContainer)

      const customIcon = document.createElement('span')
      customIcon.id = 'toastIcon' // Using default icon ID
      document.body.appendChild(customIcon)

      const customMessage = document.createElement('span')
      customMessage.id = 'toastMessage' // Using default message ID
      document.body.appendChild(customMessage)

      const manager = createToastManager({ containerId: 'customToast' })
      manager.show('Test message', 'success')
      
      // Should use custom container
      expect(customContainer.classList.contains('hidden')).toBe(false)
      manager.destroy()
    })
  })

  describe('singleton pattern', () => {
    afterEach(() => {
      // Reset the singleton by calling getToastManager in a fresh module context
      // For this test, we'll just verify the behavior
    })

    it('should return same instance from getToastManager', () => {
      const manager1 = getToastManager()
      const manager2 = getToastManager()
      expect(manager1).toBe(manager2)
    })

    it('should create new instances with createToastManager', () => {
      const manager1 = createToastManager()
      const manager2 = createToastManager()
      expect(manager1).not.toBe(manager2)
      manager1.destroy()
      manager2.destroy()
    })
  })

  describe('show()', () => {
    it('should show toast with default info type', () => {
      toastManager.show('Test message')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('Test message')
      expect(mockToastIcon.innerHTML).toContain('info-circle')
    })

    it('should show success toast', () => {
      toastManager.show('Success!', 'success')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('Success!')
      expect(mockToastIcon.innerHTML).toContain('check-circle')
      expect(mockToastIcon.innerHTML).toContain('text-green-500')
    })

    it('should show error toast', () => {
      toastManager.show('Error occurred', 'error')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('Error occurred')
      expect(mockToastIcon.innerHTML).toContain('exclamation-circle')
      expect(mockToastIcon.innerHTML).toContain('text-red-500')
    })

    it('should show warning toast', () => {
      toastManager.show('Warning!', 'warning')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('Warning!')
      expect(mockToastIcon.innerHTML).toContain('exclamation-triangle')
      expect(mockToastIcon.innerHTML).toContain('text-yellow-500')
    })

    it('should show info toast', () => {
      toastManager.show('Info message', 'info')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('Info message')
      expect(mockToastIcon.innerHTML).toContain('info-circle')
      expect(mockToastIcon.innerHTML).toContain('text-blue-500')
    })

    it('should fallback to console.log when DOM elements missing', () => {
      document.body.innerHTML = '' // Remove all elements
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      
      const manager = createToastManager()
      manager.show('Test message', 'info')
      
      expect(consoleSpy).toHaveBeenCalledWith('[Toast info] Test message')
      consoleSpy.mockRestore()
      manager.destroy()
    })
  })

  describe('auto-dismiss', () => {
    it('should auto-dismiss after default duration (3000ms)', () => {
      toastManager.show('Test message')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      
      vi.advanceTimersByTime(3000)
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })

    it('should use custom duration', () => {
      const manager = createToastManager({ duration: 5000 })
      manager.show('Test message')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      
      vi.advanceTimersByTime(3000)
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      
      vi.advanceTimersByTime(2000)
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
      
      manager.destroy()
    })

    it('should clear previous timeout when showing new toast', () => {
      toastManager.show('First message')
      
      vi.advanceTimersByTime(2000)
      toastManager.show('Second message')
      
      // At 3000ms total, the first toast would have dismissed, but we reset
      vi.advanceTimersByTime(1000) // 3000ms total
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('Second message')
      
      // After full duration from second show
      vi.advanceTimersByTime(2000) // 5000ms total (3000ms from second show)
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })
  })

  describe('dismiss()', () => {
    it('should hide toast immediately', () => {
      toastManager.show('Test message')
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      
      toastManager.dismiss()
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })

    it('should clear timeout when dismissed', () => {
      toastManager.show('Test message')
      toastManager.dismiss()
      
      // Even after timeout duration, no errors should occur
      vi.advanceTimersByTime(5000)
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })

    it('should handle dismiss when no toast is showing', () => {
      // Should not throw
      expect(() => toastManager.dismiss()).not.toThrow()
    })
  })

  describe('showWithAction()', () => {
    it('should show toast with action button', () => {
      const action = {
        label: 'Retry',
        onClick: vi.fn()
      }
      
      toastManager.showWithAction('Failed to save', action, 'error')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.innerHTML).toContain('Failed to save')
      expect(mockToastMessage.innerHTML).toContain('Retry')
      expect(mockToastMessage.querySelector('.toast-action-btn')).not.toBeNull()
    })

    it('should call action onClick and dismiss when button clicked', () => {
      const action = {
        label: 'Undo',
        onClick: vi.fn()
      }
      
      toastManager.showWithAction('Item deleted', action, 'info')
      
      const actionBtn = mockToastMessage.querySelector('.toast-action-btn') as HTMLElement
      expect(actionBtn).not.toBeNull()
      
      actionBtn.click()
      
      expect(action.onClick).toHaveBeenCalledTimes(1)
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })

    it('should auto-dismiss with double duration for action toasts', () => {
      const action = {
        label: 'Action',
        onClick: vi.fn()
      }
      
      toastManager.showWithAction('Test message', action)
      
      // Default duration is 3000ms, action toast should be 6000ms
      vi.advanceTimersByTime(3000)
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      
      vi.advanceTimersByTime(3000)
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })

    it('should fallback to console when DOM elements missing', () => {
      document.body.innerHTML = ''
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      
      const manager = createToastManager()
      const action = { label: 'Retry', onClick: vi.fn() }
      manager.showWithAction('Error', action, 'error')
      
      expect(consoleSpy).toHaveBeenCalledWith('[Toast error] Error [Action: Retry]')
      consoleSpy.mockRestore()
      manager.destroy()
    })
  })

  describe('enqueue()', () => {
    it('should show immediately when no toast is showing', () => {
      toastManager.enqueue('First message', 'info')
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
      expect(mockToastMessage.textContent).toBe('First message')
    })

    it('should queue toast when another is showing', () => {
      toastManager.show('First message')
      toastManager.enqueue('Second message', 'success')
      
      // First message should still be showing
      expect(mockToastMessage.textContent).toBe('First message')
      
      // Dismiss first toast
      vi.advanceTimersByTime(3000)
      
      // Wait for queue processing delay (300ms)
      vi.advanceTimersByTime(300)
      
      expect(mockToastMessage.textContent).toBe('Second message')
    })

    it('should queue multiple toasts', () => {
      toastManager.show('First')
      toastManager.enqueue('Second', 'info')
      toastManager.enqueue('Third', 'success')
      
      expect(mockToastMessage.textContent).toBe('First')
      
      // Process first toast
      vi.advanceTimersByTime(3300) // 3000 + 300 delay
      expect(mockToastMessage.textContent).toBe('Second')
      
      // Process second toast
      vi.advanceTimersByTime(3300)
      expect(mockToastMessage.textContent).toBe('Third')
    })
  })

  describe('clearQueue()', () => {
    it('should clear all queued toasts', () => {
      toastManager.show('First')
      toastManager.enqueue('Second', 'info')
      toastManager.enqueue('Third', 'success')
      
      toastManager.clearQueue()
      
      // Complete first toast
      vi.advanceTimersByTime(3300)
      
      // No more toasts should appear
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })
  })

  describe('destroy()', () => {
    it('should dismiss current toast and clear queue', () => {
      toastManager.show('First')
      toastManager.enqueue('Second', 'info')
      
      toastManager.destroy()
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
      
      // No more toasts should appear
      vi.advanceTimersByTime(5000)
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })
  })

  describe('all toast types', () => {
    const toastTypes: ToastType[] = ['success', 'error', 'info', 'warning']
    
    toastTypes.forEach((type) => {
      it(`should show ${type} toast correctly`, () => {
        toastManager.show(`${type} message`, type)
        
        expect(mockToastContainer.classList.contains('hidden')).toBe(false)
        expect(mockToastMessage.textContent).toBe(`${type} message`)
      })
    })
  })

  describe('edge cases', () => {
    it('should handle empty message', () => {
      toastManager.show('')
      expect(mockToastMessage.textContent).toBe('')
      expect(mockToastContainer.classList.contains('hidden')).toBe(false)
    })

    it('should handle long messages', () => {
      const longMessage = 'A'.repeat(1000)
      toastManager.show(longMessage)
      expect(mockToastMessage.textContent).toBe(longMessage)
    })

    it('should handle special characters in message', () => {
      const specialMessage = '<script>alert("xss")</script>'
      toastManager.show(specialMessage)
      // textContent should escape HTML
      expect(mockToastMessage.textContent).toBe(specialMessage)
    })

    it('should handle rapid show/dismiss cycles', () => {
      for (let i = 0; i < 10; i++) {
        toastManager.show(`Message ${i}`)
        toastManager.dismiss()
      }
      
      expect(mockToastContainer.classList.contains('hidden')).toBe(true)
    })

    it('should handle showing multiple toasts rapidly', () => {
      toastManager.show('First')
      toastManager.show('Second')
      toastManager.show('Third')
      
      // Should show the last one
      expect(mockToastMessage.textContent).toBe('Third')
    })
  })

  describe('custom element IDs', () => {
    it('should work with custom element IDs', () => {
      // Create custom elements
      const customContainer = document.createElement('div')
      customContainer.id = 'myToast'
      customContainer.classList.add('hidden')
      document.body.appendChild(customContainer)

      const customIcon = document.createElement('span')
      customIcon.id = 'myIcon'
      document.body.appendChild(customIcon)

      const customMessage = document.createElement('span')
      customMessage.id = 'myMessage'
      document.body.appendChild(customMessage)

      const manager = createToastManager({
        containerId: 'myToast',
        iconId: 'myIcon',
        messageId: 'myMessage'
      })

      manager.show('Custom toast', 'success')

      expect(customContainer.classList.contains('hidden')).toBe(false)
      expect(customMessage.textContent).toBe('Custom toast')
      expect(customIcon.innerHTML).toContain('check-circle')

      manager.destroy()
    })
  })
})
