// tests/core/PageLoader.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PageLoader, createPageLoader } from '../../src/renderer/src/core/PageLoader'

describe('PageLoader', () => {
  let pageLoader: PageLoader

  beforeEach(() => {
    pageLoader = createPageLoader({
      criticalPages: ['generate'],
      showLoadingIndicator: false
    })
  })

  afterEach(() => {
    pageLoader.clear()
    document.body.innerHTML = ''
  })

  describe('registerPage', () => {
    it('should register a page loader', () => {
      const loader = vi.fn().mockResolvedValue({ default: {} })
      pageLoader.registerPage('testPage', loader)
      
      expect(pageLoader.isPageLoaded('testPage')).toBe(false)
    })
  })

  describe('registerPages', () => {
    it('should register multiple page loaders', () => {
      const loaders = {
        page1: vi.fn().mockResolvedValue({ default: {} }),
        page2: vi.fn().mockResolvedValue({ default: {} })
      }
      pageLoader.registerPages(loaders)
      
      expect(pageLoader.isPageLoaded('page1')).toBe(false)
      expect(pageLoader.isPageLoaded('page2')).toBe(false)
    })
  })

  describe('loadPage', () => {
    it('should load a registered page', async () => {
      const mockModule = { init: vi.fn() }
      const loader = vi.fn().mockResolvedValue(mockModule)
      pageLoader.registerPage('testPage', loader)
      
      const module = await pageLoader.loadPage('testPage')
      
      expect(loader).toHaveBeenCalled()
      expect(module).toBe(mockModule)
      expect(pageLoader.isPageLoaded('testPage')).toBe(true)
    })

    it('should return cached module if already loaded', async () => {
      const mockModule = { init: vi.fn() }
      const loader = vi.fn().mockResolvedValue(mockModule)
      pageLoader.registerPage('testPage', loader)
      
      await pageLoader.loadPage('testPage')
      await pageLoader.loadPage('testPage')
      
      expect(loader).toHaveBeenCalledTimes(1)
    })

    it('should return null for unregistered page', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      
      const module = await pageLoader.loadPage('unknownPage')
      
      expect(module).toBeNull()
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('should not duplicate loading for concurrent calls', async () => {
      const mockModule = { init: vi.fn() }
      const loader = vi.fn().mockImplementation(() => 
        new Promise(resolve => setTimeout(() => resolve(mockModule), 100))
      )
      pageLoader.registerPage('testPage', loader)
      
      const promise1 = pageLoader.loadPage('testPage')
      const promise2 = pageLoader.loadPage('testPage')
      
      const [module1, module2] = await Promise.all([promise1, promise2])
      
      expect(loader).toHaveBeenCalledTimes(1)
      expect(module1).toBe(module2)
    })

    it('should call onPageLoaded callback', async () => {
      const onPageLoaded = vi.fn()
      const loader = createPageLoader({ 
        onPageLoaded,
        showLoadingIndicator: false
      })
      
      const mockModule = { init: vi.fn() }
      loader.registerPage('testPage', () => Promise.resolve(mockModule))
      
      await loader.loadPage('testPage')
      
      expect(onPageLoaded).toHaveBeenCalledWith('testPage', mockModule)
    })

    it('should call onLoadError callback on failure', async () => {
      const onLoadError = vi.fn()
      const loader = createPageLoader({ 
        onLoadError,
        showLoadingIndicator: false
      })
      
      const error = new Error('Load failed')
      loader.registerPage('testPage', () => Promise.reject(error))
      
      await expect(loader.loadPage('testPage')).rejects.toThrow('Load failed')
      expect(onLoadError).toHaveBeenCalledWith('testPage', error)
    })
  })

  describe('preloadPage', () => {
    it('should preload a page silently', async () => {
      const mockModule = { init: vi.fn() }
      const loader = vi.fn().mockResolvedValue(mockModule)
      pageLoader.registerPage('testPage', loader)
      
      await pageLoader.preloadPage('testPage')
      
      expect(pageLoader.isPageLoaded('testPage')).toBe(true)
    })

    it('should not throw on preload failure', async () => {
      const loader = vi.fn().mockRejectedValue(new Error('Preload failed'))
      pageLoader.registerPage('testPage', loader)
      
      await expect(pageLoader.preloadPage('testPage')).resolves.not.toThrow()
    })
  })

  describe('preloadPages', () => {
    it('should preload multiple pages', async () => {
      pageLoader.registerPage('page1', () => Promise.resolve({ id: 1 }))
      pageLoader.registerPage('page2', () => Promise.resolve({ id: 2 }))
      
      await pageLoader.preloadPages(['page1', 'page2'])
      
      expect(pageLoader.isPageLoaded('page1')).toBe(true)
      expect(pageLoader.isPageLoaded('page2')).toBe(true)
    })
  })

  describe('isPageLoaded', () => {
    it('should return false for unloaded page', () => {
      pageLoader.registerPage('testPage', () => Promise.resolve({}))
      expect(pageLoader.isPageLoaded('testPage')).toBe(false)
    })

    it('should return true for loaded page', async () => {
      pageLoader.registerPage('testPage', () => Promise.resolve({}))
      await pageLoader.loadPage('testPage')
      expect(pageLoader.isPageLoaded('testPage')).toBe(true)
    })
  })

  describe('isPageLoading', () => {
    it('should return true while page is loading', async () => {
      let resolveLoader: (value: any) => void
      const loaderPromise = new Promise(resolve => { resolveLoader = resolve })
      pageLoader.registerPage('testPage', () => loaderPromise)
      
      const loadPromise = pageLoader.loadPage('testPage')
      expect(pageLoader.isPageLoading('testPage')).toBe(true)
      
      resolveLoader!({})
      await loadPromise
      expect(pageLoader.isPageLoading('testPage')).toBe(false)
    })
  })

  describe('isCriticalPage', () => {
    it('should return true for critical pages', () => {
      expect(pageLoader.isCriticalPage('generate')).toBe(true)
    })

    it('should return false for non-critical pages', () => {
      expect(pageLoader.isCriticalPage('history')).toBe(false)
    })
  })

  describe('getPage', () => {
    it('should return loaded module', async () => {
      const mockModule = { id: 'test' }
      pageLoader.registerPage('testPage', () => Promise.resolve(mockModule))
      await pageLoader.loadPage('testPage')
      
      expect(pageLoader.getPage('testPage')).toBe(mockModule)
    })

    it('should return undefined for unloaded page', () => {
      expect(pageLoader.getPage('testPage')).toBeUndefined()
    })
  })

  describe('getLoadedPages', () => {
    it('should return list of loaded page names', async () => {
      pageLoader.registerPage('page1', () => Promise.resolve({}))
      pageLoader.registerPage('page2', () => Promise.resolve({}))
      
      await pageLoader.loadPage('page1')
      
      expect(pageLoader.getLoadedPages()).toContain('page1')
      expect(pageLoader.getLoadedPages()).not.toContain('page2')
    })
  })

  describe('getLoadingState', () => {
    it('should return loading state for page', async () => {
      pageLoader.registerPage('testPage', () => Promise.resolve({}))
      await pageLoader.loadPage('testPage')
      
      const state = pageLoader.getLoadingState('testPage')
      expect(state?.status).toBe('loaded')
    })

    it('should return undefined for unknown page', () => {
      expect(pageLoader.getLoadingState('unknown')).toBeUndefined()
    })
  })

  describe('unloadPage', () => {
    it('should unload a loaded page', async () => {
      const destroyFn = vi.fn()
      const mockModule = { destroy: destroyFn }
      pageLoader.registerPage('testPage', () => Promise.resolve(mockModule))
      await pageLoader.loadPage('testPage')
      
      pageLoader.unloadPage('testPage')
      
      expect(destroyFn).toHaveBeenCalled()
      expect(pageLoader.isPageLoaded('testPage')).toBe(false)
    })
  })

  describe('clear', () => {
    it('should clear all loaded pages', async () => {
      const destroy1 = vi.fn()
      const destroy2 = vi.fn()
      
      pageLoader.registerPage('page1', () => Promise.resolve({ destroy: destroy1 }))
      pageLoader.registerPage('page2', () => Promise.resolve({ destroy: destroy2 }))
      
      await pageLoader.loadPage('page1')
      await pageLoader.loadPage('page2')
      
      pageLoader.clear()
      
      expect(destroy1).toHaveBeenCalled()
      expect(destroy2).toHaveBeenCalled()
      expect(pageLoader.getLoadedPages()).toHaveLength(0)
    })
  })

  describe('loading indicator', () => {
    it('should show loading indicator when configured', async () => {
      const panel = document.createElement('div')
      panel.id = 'testPagePanel'
      document.body.appendChild(panel)
      
      const loaderWithIndicator = createPageLoader({ showLoadingIndicator: true })
      
      let resolveLoader: (value: any) => void
      const loaderPromise = new Promise(resolve => { resolveLoader = resolve })
      loaderWithIndicator.registerPage('testPage', () => loaderPromise)
      
      const loadPromise = loaderWithIndicator.loadPage('testPage')
      
      // Check indicator is shown
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(panel.querySelector('.page-loading-indicator')).not.toBeNull()
      
      resolveLoader!({})
      await loadPromise
      
      // Check indicator is hidden
      expect(panel.querySelector('.page-loading-indicator')).toBeNull()
      
      loaderWithIndicator.clear()
    })
  })
})
