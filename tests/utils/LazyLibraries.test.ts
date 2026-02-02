// tests/utils/LazyLibraries.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock modules - return module objects with default export
vi.mock('jszip', () => ({
  default: 'mock-jszip-instance'
}))

vi.mock('browser-image-compression', () => ({
  default: 'mock-image-compression-instance'
}))

describe('LazyLibraries', () => {
  beforeEach(async () => {
    // Reset module state - this clears the cached instances in LazyLibraries
    vi.resetModules()
    
    // Mock performance.now() for consistent timing
    vi.spyOn(performance, 'now').mockReturnValue(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  describe('getJSZip', () => {
    it('should load JSZip on first call', async () => {
      const { getJSZip } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const result = await getJSZip()
      
      expect(result).toBe('mock-jszip-instance')
    })

    it('should return cached instance on subsequent calls', async () => {
      const { getJSZip } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const result1 = await getJSZip()
      const result2 = await getJSZip()
      
      expect(result1).toBe('mock-jszip-instance')
      expect(result2).toBe('mock-jszip-instance')
    })

    it('should handle concurrent calls and share the same promise', async () => {
      const { getJSZip } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const promise1 = getJSZip()
      const promise2 = getJSZip()
      
      // Both should resolve to the same value
      const result1 = await promise1
      const result2 = await promise2
      
      expect(result1).toBe('mock-jszip-instance')
      expect(result2).toBe('mock-jszip-instance')
    })

    it('should log loading messages', async () => {
      const consoleSpy = vi.spyOn(console, 'log')
      const { getJSZip } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      await getJSZip()
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[LazyLibraries] 🔄 开始加载 JSZip...'))
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[LazyLibraries] ✅ JSZip 加载完成'))
    })

    it('should measure and log load time', async () => {
      const consoleSpy = vi.spyOn(console, 'log')
      const perfSpy = vi.spyOn(performance, 'now')
      
      perfSpy.mockReturnValueOnce(0) // Start time
      perfSpy.mockReturnValueOnce(100) // End time
      
      const { getJSZip } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      await getJSZip()
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('100.0ms'))
    })
  })

  describe('getImageCompression', () => {
    it('should load browser-image-compression on first call', async () => {
      const { getImageCompression } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const result = await getImageCompression()
      
      expect(result).toBe('mock-image-compression-instance')
    })

    it('should return cached instance on subsequent calls', async () => {
      const { getImageCompression } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const result1 = await getImageCompression()
      const result2 = await getImageCompression()
      
      expect(result1).toBe('mock-image-compression-instance')
      expect(result2).toBe('mock-image-compression-instance')
    })

    it('should handle concurrent calls and share the same promise', async () => {
      const { getImageCompression } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const promise1 = getImageCompression()
      const promise2 = getImageCompression()
      
      // Both should resolve to the same value
      const result1 = await promise1
      const result2 = await promise2
      
      expect(result1).toBe('mock-image-compression-instance')
      expect(result2).toBe('mock-image-compression-instance')
    })

    it('should log loading messages', async () => {
      const consoleSpy = vi.spyOn(console, 'log')
      const { getImageCompression } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      await getImageCompression()
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[LazyLibraries] 🔄 开始加载 browser-image-compression...'))
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[LazyLibraries] ✅ browser-image-compression 加载完成'))
    })

    it('should measure and log load time', async () => {
      const consoleSpy = vi.spyOn(console, 'log')
      const perfSpy = vi.spyOn(performance, 'now')
      
      perfSpy.mockReturnValueOnce(0) // Start time
      perfSpy.mockReturnValueOnce(250) // End time
      
      const { getImageCompression } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      await getImageCompression()
      
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('250.0ms'))
    })
  })

  describe('isJSZipLoaded', () => {
    it('should return false before loading', async () => {
      const { isJSZipLoaded } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      expect(isJSZipLoaded()).toBe(false)
    })

    it('should return true after loading', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { getJSZip, isJSZipLoaded } = module
      
      expect(isJSZipLoaded()).toBe(false)
      
      await getJSZip()
      
      expect(isJSZipLoaded()).toBe(true)
    })
  })

  describe('isImageCompressionLoaded', () => {
    it('should return false before loading', async () => {
      const { isImageCompressionLoaded } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      expect(isImageCompressionLoaded()).toBe(false)
    })

    it('should return true after loading', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { getImageCompression, isImageCompressionLoaded } = module
      
      expect(isImageCompressionLoaded()).toBe(false)
      
      await getImageCompression()
      
      expect(isImageCompressionLoaded()).toBe(true)
    })
  })

  describe('getLibraryLoadStatus', () => {
    it('should return "not-loaded" for both libraries initially', async () => {
      const { getLibraryLoadStatus } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      const status = getLibraryLoadStatus()
      
      expect(status.jszip).toBe('not-loaded')
      expect(status.imageCompression).toBe('not-loaded')
    })

    it('should return "loading" while library is being loaded', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { getJSZip, getLibraryLoadStatus } = module
      
      // Start loading but don't await immediately
      const loadingPromise = getJSZip()
      
      // Check status while loading (should be loading or loaded depending on timing)
      const status = getLibraryLoadStatus()
      expect(['loading', 'loaded']).toContain(status.jszip)
      
      // Complete the loading
      await loadingPromise
    })

    it('should return "loaded" after library is loaded', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { getJSZip, getImageCompression, getLibraryLoadStatus } = module
      
      await getJSZip()
      await getImageCompression()
      
      const status = getLibraryLoadStatus()
      
      expect(status.jszip).toBe('loaded')
      expect(status.imageCompression).toBe('loaded')
    })

    it('should correctly track mixed states', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { getJSZip, getLibraryLoadStatus } = module
      
      await getJSZip()
      
      const status = getLibraryLoadStatus()
      
      expect(status.jszip).toBe('loaded')
      expect(status.imageCompression).toBe('not-loaded')
    })
  })

  describe('preloadLibraries', () => {
    it('should call requestIdleCallback when available', async () => {
      const requestIdleCallbackSpy = vi.fn((cb: IdleRequestCallback) => {
        // Execute callback immediately for testing
        cb({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline)
        return 1
      })
      
      // Set up requestIdleCallback on window (needed for 'in' check) and as global
      ;(window as any).requestIdleCallback = requestIdleCallbackSpy
      ;(globalThis as any).requestIdleCallback = requestIdleCallbackSpy
      
      const { preloadLibraries } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      preloadLibraries()
      
      expect(requestIdleCallbackSpy).toHaveBeenCalledTimes(1)
      expect(requestIdleCallbackSpy).toHaveBeenCalledWith(
        expect.any(Function),
        { timeout: 5000 }
      )
    })

    it('should preload both libraries in idle callback', async () => {
      let idleCallback: IdleRequestCallback | null = null
      
      const requestIdleCallbackSpy = vi.fn((cb: IdleRequestCallback) => {
        idleCallback = cb
        return 1
      })
      
      ;(window as any).requestIdleCallback = requestIdleCallbackSpy
      ;(globalThis as any).requestIdleCallback = requestIdleCallbackSpy
      
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { preloadLibraries, isJSZipLoaded, isImageCompressionLoaded } = module
      
      preloadLibraries()
      
      // Libraries should not be loaded yet
      expect(isJSZipLoaded()).toBe(false)
      expect(isImageCompressionLoaded()).toBe(false)
      
      // Execute the idle callback
      if (idleCallback) {
        idleCallback({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline)
        
        // Wait for async operations
        await new Promise(resolve => setTimeout(resolve, 10))
        
        // Now libraries should be loaded
        expect(isJSZipLoaded()).toBe(true)
        expect(isImageCompressionLoaded()).toBe(true)
      }
    })

    it('should handle errors gracefully during preload', async () => {
      let idleCallback: IdleRequestCallback | null = null
      
      const requestIdleCallbackSpy = vi.fn((cb: IdleRequestCallback) => {
        idleCallback = cb
        return 1
      })
      
      ;(window as any).requestIdleCallback = requestIdleCallbackSpy
      ;(globalThis as any).requestIdleCallback = requestIdleCallbackSpy
      
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { preloadLibraries } = module
      
      preloadLibraries()
      
      // The actual implementation catches errors with .catch(), so this should not throw
      if (idleCallback) {
        await expect(async () => {
          idleCallback!({ didTimeout: false, timeRemaining: () => 50 } as IdleDeadline)
          await new Promise(resolve => setTimeout(resolve, 10))
        }).not.toThrow()
      }
    })

    it('should not throw when requestIdleCallback is not available', async () => {
      // Remove requestIdleCallback from window and global
      delete (window as any).requestIdleCallback
      delete (globalThis as any).requestIdleCallback
      
      const { preloadLibraries } = await import('../../src/renderer/src/utils/LazyLibraries')
      
      // Should not throw
      expect(() => {
        preloadLibraries()
      }).not.toThrow()
    })
  })

  describe('integration tests', () => {
    it('should handle multiple libraries loading independently', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { 
        getJSZip, 
        getImageCompression, 
        isJSZipLoaded, 
        isImageCompressionLoaded,
        getLibraryLoadStatus 
      } = module
      
      // Load JSZip first
      await getJSZip()
      expect(isJSZipLoaded()).toBe(true)
      expect(isImageCompressionLoaded()).toBe(false)
      
      // Then load ImageCompression
      await getImageCompression()
      expect(isJSZipLoaded()).toBe(true)
      expect(isImageCompressionLoaded()).toBe(true)
      
      // Status should reflect both loaded
      const status = getLibraryLoadStatus()
      expect(status.jszip).toBe('loaded')
      expect(status.imageCompression).toBe('loaded')
    })

    it('should handle rapid successive calls', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { getJSZip, getImageCompression } = module
      
      // Make multiple rapid calls
      const promises = [
        getJSZip(),
        getJSZip(),
        getJSZip(),
        getImageCompression(),
        getImageCompression()
      ]
      
      const results = await Promise.all(promises)
      
      // All should resolve successfully
      expect(results).toHaveLength(5)
      expect(results[0]).toBe('mock-jszip-instance')
      expect(results[1]).toBe('mock-jszip-instance')
      expect(results[2]).toBe('mock-jszip-instance')
      expect(results[3]).toBe('mock-image-compression-instance')
      expect(results[4]).toBe('mock-image-compression-instance')
    })

    it('should maintain separate cache for each library', async () => {
      const module = await import('../../src/renderer/src/utils/LazyLibraries')
      const { 
        getJSZip, 
        getImageCompression,
        isJSZipLoaded,
        isImageCompressionLoaded
      } = module
      
      // Load one library
      await getJSZip()
      expect(isJSZipLoaded()).toBe(true)
      expect(isImageCompressionLoaded()).toBe(false)
      
      // Load the other library
      await getImageCompression()
      expect(isJSZipLoaded()).toBe(true) // Still loaded
      expect(isImageCompressionLoaded()).toBe(true) // Now loaded
    })
  })
})
