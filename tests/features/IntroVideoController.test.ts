// tests/features/IntroVideoController.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  IntroVideoController,
  IntroVideoConfig,
  getIntroVideoController,
  initIntroVideo,
  resetIntroVideoController
} from '../../src/renderer/src/features/intro-video/IntroVideoController'

// Helper to create mock HTML elements
function createMockElement(id: string, tagName = 'div'): HTMLElement {
  const el = document.createElement(tagName)
  el.id = id
  return el
}

// Helper to create mock video element
function createMockVideoElement(): HTMLVideoElement {
  const video = document.createElement('video') as HTMLVideoElement
  video.id = 'introVideo'
  // Mock play method that returns a promise
  video.play = vi.fn().mockResolvedValue(undefined)
  video.pause = vi.fn()
  Object.defineProperty(video, 'duration', { value: 10, writable: true })
  Object.defineProperty(video, 'currentTime', { value: 0, writable: true })
  return video
}

describe('IntroVideoController', () => {
  let mockElements: Record<string, HTMLElement | null>
  let mockVideo: HTMLVideoElement
  let setIntervalSpy: ReturnType<typeof vi.spyOn>
  let clearIntervalSpy: ReturnType<typeof vi.spyOn>
  let windowEventListeners: Map<string, Array<EventListener>>

  beforeEach(() => {
    vi.useFakeTimers()
    
    // Reset singleton before each test
    resetIntroVideoController()

    // Create mock elements
    mockVideo = createMockVideoElement()
    mockElements = {
      introVideo: mockVideo,
      pageLoader: createMockElement('pageLoader'),
      mainContent: createMockElement('mainContent'),
      skipIntroBtn: createMockElement('skipIntroBtn', 'button'),
      enterBtn: createMockElement('enterBtn', 'button'),
      introLoadingText: createMockElement('introLoadingText'),
      introProgress: createMockElement('introProgress'),
      fallbackLoader: createMockElement('fallbackLoader'),
      introVideoContainer: createMockElement('introVideoContainer')
    }

    // Mock document.getElementById
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      return mockElements[id] || null
    })

    // Spy on global setInterval and clearInterval FIRST
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    // Then add setInterval and clearInterval to window object (for IntroVideoController which uses window.setInterval)
    // Use wrapper functions that call the original to ensure spies catch the calls
    ;(window as any).setInterval = (callback: TimerHandler, delay?: number, ...args: any[]) => {
      return globalThis.setInterval(callback, delay, ...args)
    }
    ;(window as any).clearInterval = (id: number) => {
      return globalThis.clearInterval(id)
    }

    // Track window event listeners so we can dispatch events properly
    windowEventListeners = new Map()
    ;(window as any).addEventListener = (type: string, listener: EventListener) => {
      if (!windowEventListeners.has(type)) {
        windowEventListeners.set(type, [])
      }
      windowEventListeners.get(type)!.push(listener)
    }
    ;(window as any).removeEventListener = (type: string, listener: EventListener) => {
      const listeners = windowEventListeners.get(type)
      if (listeners) {
        const index = listeners.indexOf(listener)
        if (index !== -1) {
          listeners.splice(index, 1)
        }
      }
    }
    ;(window as any).dispatchEvent = (event: Event) => {
      const listeners = windowEventListeners.get(event.type)
      if (listeners) {
        listeners.forEach(listener => listener(event))
      }
      return true
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    resetIntroVideoController()
  })

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const controller = new IntroVideoController()
      expect(controller).toBeInstanceOf(IntroVideoController)
    })

    it('should create instance with custom config', () => {
      const customConfig: IntroVideoConfig = {
        videoId: 'customVideo',
        messageInterval: 3000,
        videoTimeout: 60000
      }
      const controller = new IntroVideoController(customConfig)
      expect(controller).toBeInstanceOf(IntroVideoController)
    })

    it('should initialize state correctly', () => {
      const controller = new IntroVideoController()
      const state = controller.getState()
      
      expect(state.appInitialized).toBe(false)
      expect(state.videoEnded).toBe(false)
      expect(state.videoLoaded).toBe(false)
      expect(state.skipped).toBe(false)
      expect(state.entered).toBe(false)
    })
  })

  describe('getState', () => {
    it('should return a copy of current state', () => {
      const controller = new IntroVideoController()
      const state1 = controller.getState()
      const state2 = controller.getState()
      
      expect(state1).toEqual(state2)
      expect(state1).not.toBe(state2) // Should be a copy, not reference
    })
  })

  describe('init', () => {
    it('should cache DOM elements', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      expect(document.getElementById).toHaveBeenCalledWith('introVideo')
      expect(document.getElementById).toHaveBeenCalledWith('pageLoader')
      expect(document.getElementById).toHaveBeenCalledWith('mainContent')
      expect(document.getElementById).toHaveBeenCalledWith('skipIntroBtn')
      expect(document.getElementById).toHaveBeenCalledWith('enterBtn')
    })

    it('should start message cycle', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      expect(setIntervalSpy).toHaveBeenCalled()
    })

    it('should use fallback loader when video element is missing', () => {
      mockElements['introVideo'] = null
      
      const controller = new IntroVideoController()
      controller.init()
      
      const state = controller.getState()
      expect(state.videoEnded).toBe(true) // Video is considered "ended" when missing
    })

    it('should initialize video when video element exists', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Video element should have event listeners added
      // We can verify by triggering events later
      expect(controller.getState().videoEnded).toBe(false)
    })
  })

  describe('video events', () => {
    it('should handle canplaythrough event', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger canplaythrough event
      mockVideo.dispatchEvent(new Event('canplaythrough'))
      
      const state = controller.getState()
      expect(state.videoLoaded).toBe(true)
      expect(mockVideo.play).toHaveBeenCalled()
    })

    it('should handle ended event', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger ended event
      mockVideo.dispatchEvent(new Event('ended'))
      
      const state = controller.getState()
      expect(state.videoEnded).toBe(true)
    })

    it('should handle error event', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger error event
      mockVideo.dispatchEvent(new Event('error'))
      
      const state = controller.getState()
      expect(state.videoEnded).toBe(true)
    })

    it('should handle timeupdate event and update progress', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Set current time and duration
      Object.defineProperty(mockVideo, 'currentTime', { value: 5, writable: true })
      Object.defineProperty(mockVideo, 'duration', { value: 10, writable: true })
      
      // Trigger timeupdate event
      mockVideo.dispatchEvent(new Event('timeupdate'))
      
      const progressBar = mockElements['introProgress']
      expect(progressBar?.style.width).toBe('50%')
    })
  })

  describe('video playback', () => {
    it('should try muted playback when autoplay with sound is blocked', async () => {
      // Mock play to reject first time, then resolve
      mockVideo.play = vi.fn()
        .mockRejectedValueOnce(new Error('Autoplay blocked'))
        .mockResolvedValueOnce(undefined)

      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger canplaythrough to start playback
      mockVideo.dispatchEvent(new Event('canplaythrough'))
      
      await vi.runAllTimersAsync()
      
      expect(mockVideo.muted).toBe(true)
      expect(mockVideo.play).toHaveBeenCalledTimes(2)
    })

    it('should show fallback loader when both play attempts fail', async () => {
      mockVideo.play = vi.fn()
        .mockRejectedValueOnce(new Error('Autoplay blocked'))
        .mockRejectedValueOnce(new Error('Muted autoplay also blocked'))

      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger canplaythrough
      mockVideo.dispatchEvent(new Event('canplaythrough'))
      
      // Need to flush microtasks for the promise chain to complete
      // First rejection -> catch handler -> second play call -> second rejection -> second catch handler
      await Promise.resolve() // First rejection
      await Promise.resolve() // First catch handler starts
      await Promise.resolve() // Second play call rejects
      await Promise.resolve() // Second catch handler executes
      await Promise.resolve() // Extra flush just in case
      
      const fallbackLoader = mockElements['fallbackLoader']
      expect(fallbackLoader?.classList.contains('active')).toBe(true)
    })
  })

  describe('skipIntro', () => {
    it('should skip intro and pause video', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.skipIntro()
      
      const state = controller.getState()
      expect(state.skipped).toBe(true)
      expect(state.videoEnded).toBe(true)
      expect(mockVideo.pause).toHaveBeenCalled()
    })

    it('should not skip twice', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.skipIntro()
      controller.skipIntro() // Second call should be ignored
      
      expect(mockVideo.pause).toHaveBeenCalledTimes(1)
    })

    it('should hide loader if app is already initialized', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Simulate app being ready
      window.dispatchEvent(new Event('appReady'))
      
      controller.skipIntro()
      
      const loader = mockElements['pageLoader']
      expect(loader?.classList.contains('loaded')).toBe(true)
    })

    it('should show fallback loader if app is not initialized', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.skipIntro()
      
      const fallbackLoader = mockElements['fallbackLoader']
      expect(fallbackLoader?.classList.contains('active')).toBe(true)
    })
  })

  describe('enterApp', () => {
    it('should enter app and hide loader', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.enterApp()
      
      const state = controller.getState()
      expect(state.entered).toBe(true)
      
      const loader = mockElements['pageLoader']
      expect(loader?.classList.contains('loaded')).toBe(true)
    })

    it('should not enter twice', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.enterApp()
      
      const loader = mockElements['pageLoader']
      const classListAddSpy = vi.spyOn(loader!.classList, 'add')
      classListAddSpy.mockClear()
      
      controller.enterApp() // Second call should be ignored
      
      // classList.add should not be called again
      expect(classListAddSpy).not.toHaveBeenCalled()
    })
  })

  describe('keyboard shortcuts', () => {
    it('should skip on Escape key', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      const event = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(event)
      
      const state = controller.getState()
      expect(state.skipped).toBe(true)
    })

    it('should skip on Space key', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      const event = new KeyboardEvent('keydown', { key: ' ' })
      document.dispatchEvent(event)
      
      const state = controller.getState()
      expect(state.skipped).toBe(true)
    })

    it('should not skip if video already ended', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // End the video first
      mockVideo.dispatchEvent(new Event('ended'))
      
      const event = new KeyboardEvent('keydown', { key: 'Escape' })
      const preventDefaultSpy = vi.spyOn(event, 'preventDefault')
      document.dispatchEvent(event)
      
      // preventDefault should not be called if video already ended
      // (the skip handler checks state.videoEnded)
      const state = controller.getState()
      expect(state.skipped).toBe(false) // Not skipped via keyboard after video ended
    })

    it('should not skip if already skipped', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.skipIntro() // Skip first
      mockVideo.pause.mockClear()
      
      const event = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(event)
      
      // pause should not be called again
      expect(mockVideo.pause).not.toHaveBeenCalled()
    })
  })

  describe('button click events', () => {
    it('should skip when skip button is clicked', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      const skipButton = mockElements['skipIntroBtn']
      skipButton?.dispatchEvent(new Event('click'))
      
      const state = controller.getState()
      expect(state.skipped).toBe(true)
    })

    it('should enter app when enter button is clicked', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      const enterButton = mockElements['enterBtn']
      enterButton?.dispatchEvent(new Event('click'))
      
      const state = controller.getState()
      expect(state.entered).toBe(true)
    })
  })

  describe('message cycling', () => {
    it('should cycle through loading messages', () => {
      const customMessages = ['Message 1', 'Message 2', 'Message 3']
      const controller = new IntroVideoController({
        loadingMessages: customMessages,
        messageInterval: 1000
      })
      controller.init()
      
      const loadingText = mockElements['introLoadingText']
      expect(loadingText?.textContent).toBe('Message 1')
      
      vi.advanceTimersByTime(1000)
      expect(loadingText?.textContent).toBe('Message 2')
      
      vi.advanceTimersByTime(1000)
      expect(loadingText?.textContent).toBe('Message 3')
      
      vi.advanceTimersByTime(1000)
      expect(loadingText?.textContent).toBe('Message 1') // Should wrap around
    })

    it('should stop message cycle on destroy', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.destroy()
      
      expect(clearIntervalSpy).toHaveBeenCalled()
    })
  })

  describe('timeout handling', () => {
    it('should mark video as ended after video timeout', () => {
      const controller = new IntroVideoController({
        videoTimeout: 5000
      })
      controller.init()
      
      expect(controller.getState().videoEnded).toBe(false)
      
      vi.advanceTimersByTime(5000)
      
      expect(controller.getState().videoEnded).toBe(true)
    })

    it('should mark app as initialized after app init timeout', () => {
      const controller = new IntroVideoController({
        appInitTimeout: 5000
      })
      controller.init()
      
      expect(controller.getState().appInitialized).toBe(false)
      
      vi.advanceTimersByTime(5000)
      
      expect(controller.getState().appInitialized).toBe(true)
    })

    it('should show enter button when app timeout occurs and video ended', () => {
      const controller = new IntroVideoController({
        appInitTimeout: 5000
      })
      controller.init()
      
      // End the video first
      mockVideo.dispatchEvent(new Event('ended'))
      
      // Then timeout for app init
      vi.advanceTimersByTime(5000)
      
      const enterButton = mockElements['enterBtn']
      expect(enterButton?.style.display).toBe('block')
    })
  })

  describe('appReady event', () => {
    it('should set appInitialized on appReady event', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      expect(controller.getState().appInitialized).toBe(false)
      
      window.dispatchEvent(new Event('appReady'))
      
      expect(controller.getState().appInitialized).toBe(true)
    })

    it('should show enter button when appReady and video ended', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // End video first
      mockVideo.dispatchEvent(new Event('ended'))
      
      // Then app ready
      window.dispatchEvent(new Event('appReady'))
      
      const enterButton = mockElements['enterBtn']
      expect(enterButton?.style.display).toBe('block')
    })
  })

  describe('showEnterButton UI changes', () => {
    it('should show enter button and hide other elements', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger conditions for showing enter button
      mockVideo.dispatchEvent(new Event('ended'))
      window.dispatchEvent(new Event('appReady'))
      
      const enterButton = mockElements['enterBtn']
      const skipButton = mockElements['skipIntroBtn']
      const loadingText = mockElements['introLoadingText']
      const progressBar = mockElements['introProgress']
      const fallbackLoader = mockElements['fallbackLoader']
      
      expect(enterButton?.style.display).toBe('block')
      expect(skipButton?.style.display).toBe('none')
      expect(loadingText?.style.display).toBe('none')
      expect(progressBar?.style.display).toBe('none')
      expect(fallbackLoader?.classList.contains('active')).toBe(false)
    })

    it('should stop message cycle when showing enter button', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Trigger conditions for showing enter button
      mockVideo.dispatchEvent(new Event('ended'))
      window.dispatchEvent(new Event('appReady'))
      
      expect(clearIntervalSpy).toHaveBeenCalled()
    })
  })

  describe('hideLoader', () => {
    it('should add loaded class to loader and main content', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.enterApp()
      
      const loader = mockElements['pageLoader']
      const mainContent = mockElements['mainContent']
      
      expect(loader?.classList.contains('loaded')).toBe(true)
      expect(mainContent?.classList.contains('loaded')).toBe(true)
    })

    it('should remove loader after transition duration', () => {
      const controller = new IntroVideoController({
        transitionDuration: 500
      })
      controller.init()
      
      // Create a parent for the loader
      const parent = document.createElement('div')
      const loader = mockElements['pageLoader']!
      parent.appendChild(loader)
      
      controller.enterApp()
      
      // Loader should still exist
      expect(loader.parentNode).toBe(parent)
      
      // Advance past transition duration
      vi.advanceTimersByTime(500)
      
      // Loader should be removed
      expect(loader.parentNode).toBeNull()
    })
  })

  describe('showFallbackLoader', () => {
    it('should show fallback loader and hide video container', () => {
      // Make video unavailable to trigger fallback
      mockElements['introVideo'] = null
      
      const controller = new IntroVideoController()
      controller.init()
      
      const fallbackLoader = mockElements['fallbackLoader']
      const videoContainer = mockElements['introVideoContainer']
      
      expect(fallbackLoader?.classList.contains('active')).toBe(true)
      expect(videoContainer?.style.display).toBe('none')
    })
  })

  describe('destroy', () => {
    it('should stop message cycle', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.destroy()
      
      expect(clearIntervalSpy).toHaveBeenCalled()
    })

    it('should clear element references', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      controller.destroy()
      
      // After destroy, the internal elements should be cleared
      // We can't directly access private properties, but we can verify
      // the controller doesn't throw when methods are called after destroy
      expect(() => controller.skipIntro()).not.toThrow()
    })
  })

  describe('getIntroVideoController singleton', () => {
    it('should return singleton instance', () => {
      const instance1 = getIntroVideoController()
      const instance2 = getIntroVideoController()
      
      expect(instance1).toBe(instance2)
    })

    it('should apply config only on first call', () => {
      const instance1 = getIntroVideoController({ videoTimeout: 5000 })
      const instance2 = getIntroVideoController({ videoTimeout: 10000 })
      
      expect(instance1).toBe(instance2)
      // Config from second call is ignored
    })
  })

  describe('initIntroVideo', () => {
    it('should create and initialize controller', () => {
      const controller = initIntroVideo()
      
      expect(controller).toBeInstanceOf(IntroVideoController)
      // init() was called, so getElementById should have been called
      expect(document.getElementById).toHaveBeenCalled()
    })

    it('should pass config to controller', () => {
      const customMessages = ['Custom Message']
      const controller = initIntroVideo({
        loadingMessages: customMessages
      })
      
      controller.init() // Re-init to apply cached elements with new messages
      
      // Should use custom message
      const loadingText = mockElements['introLoadingText']
      // The first message should be set
      expect(loadingText?.textContent).toBe(customMessages[0])
    })
  })

  describe('resetIntroVideoController', () => {
    it('should reset singleton instance', () => {
      const instance1 = getIntroVideoController()
      resetIntroVideoController()
      const instance2 = getIntroVideoController()
      
      expect(instance1).not.toBe(instance2)
    })

    it('should destroy existing instance on reset', () => {
      const instance = getIntroVideoController()
      instance.init()
      
      resetIntroVideoController()
      
      expect(clearIntervalSpy).toHaveBeenCalled()
    })
  })

  describe('edge cases', () => {
    it('should handle missing loader element gracefully', () => {
      mockElements['pageLoader'] = null
      
      const controller = new IntroVideoController()
      controller.init()
      
      // Should not throw
      expect(() => controller.enterApp()).not.toThrow()
    })

    it('should handle missing main content element gracefully', () => {
      mockElements['mainContent'] = null
      
      const controller = new IntroVideoController()
      controller.init()
      
      // Should not throw
      expect(() => controller.enterApp()).not.toThrow()
    })

    it('should handle missing loading text element gracefully', () => {
      mockElements['introLoadingText'] = null
      
      const controller = new IntroVideoController()
      
      // Should not throw during message cycling
      expect(() => controller.init()).not.toThrow()
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
    })

    it('should handle missing progress bar gracefully', () => {
      mockElements['introProgress'] = null
      
      const controller = new IntroVideoController()
      controller.init()
      
      // Should not throw when updating progress
      expect(() => mockVideo.dispatchEvent(new Event('timeupdate'))).not.toThrow()
    })

    it('should handle video without duration gracefully', () => {
      Object.defineProperty(mockVideo, 'duration', { value: 0, writable: true })
      
      const controller = new IntroVideoController()
      controller.init()
      
      // Should not throw or update progress
      expect(() => mockVideo.dispatchEvent(new Event('timeupdate'))).not.toThrow()
    })

    it('should handle missing skip button gracefully', () => {
      mockElements['skipIntroBtn'] = null
      
      const controller = new IntroVideoController()
      
      // Should not throw during init
      expect(() => controller.init()).not.toThrow()
    })

    it('should handle missing enter button gracefully', () => {
      mockElements['enterBtn'] = null
      
      const controller = new IntroVideoController()
      controller.init()
      
      // Should not throw when showing enter button
      mockVideo.dispatchEvent(new Event('ended'))
      expect(() => window.dispatchEvent(new Event('appReady'))).not.toThrow()
    })
  })

  describe('progress bar update', () => {
    it('should update progress bar based on video progress', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Set video at 25% progress
      Object.defineProperty(mockVideo, 'currentTime', { value: 2.5, writable: true })
      Object.defineProperty(mockVideo, 'duration', { value: 10, writable: true })
      
      mockVideo.dispatchEvent(new Event('timeupdate'))
      
      const progressBar = mockElements['introProgress']
      expect(progressBar?.style.width).toBe('25%')
    })

    it('should show 100% progress at video end', () => {
      const controller = new IntroVideoController()
      controller.init()
      
      // Set video at 100% progress
      Object.defineProperty(mockVideo, 'currentTime', { value: 10, writable: true })
      Object.defineProperty(mockVideo, 'duration', { value: 10, writable: true })
      
      mockVideo.dispatchEvent(new Event('timeupdate'))
      
      const progressBar = mockElements['introProgress']
      expect(progressBar?.style.width).toBe('100%')
    })
  })
})
