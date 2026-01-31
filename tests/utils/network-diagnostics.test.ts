// tests/utils/network-diagnostics.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { 
  NetworkDiagnostics, 
  createNetworkDiagnostics, 
  quickNetworkCheck,
  type NetworkTestResult
} from '../../src/renderer/src/utils/network-diagnostics'

describe('NetworkDiagnostics', () => {
  let diagnostics: NetworkDiagnostics

  beforeEach(() => {
    diagnostics = createNetworkDiagnostics()
    vi.spyOn(global, 'fetch').mockImplementation(() => 
      Promise.resolve(new Response(null, { status: 200 }))
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('checkBrowserOnline', () => {
    it('should return navigator.onLine status', () => {
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true })
      expect(diagnostics.checkBrowserOnline()).toBe(true)
      
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true })
      expect(diagnostics.checkBrowserOnline()).toBe(false)
    })
  })

  describe('testInternetAccess', () => {
    it('should return true when fetch succeeds', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true })
      
      const result = await diagnostics.testInternetAccess()
      expect(result).toBe(true)
    })

    it('should return false when offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true })
      
      const result = await diagnostics.testInternetAccess()
      expect(result).toBe(false)
    })

    it('should return false when fetch fails', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true })
      vi.spyOn(global, 'fetch').mockImplementation(() => 
        Promise.reject(new Error('Network error'))
      )
      
      const result = await diagnostics.testInternetAccess()
      expect(result).toBe(false)
    })
  })

  describe('testApiReachable', () => {
    it('should return true when API responds with 200', async () => {
      const result = await diagnostics.testApiReachable('https://api.example.com')
      expect(result).toBe(true)
    })

    it('should return true for 401/403 (auth errors mean API is reachable)', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(() => 
        Promise.resolve(new Response(null, { status: 401 }))
      )
      
      const result = await diagnostics.testApiReachable('https://api.example.com')
      expect(result).toBe(true)
    })

    it('should return false when no URL provided', async () => {
      const result = await diagnostics.testApiReachable('')
      expect(result).toBe(false)
    })

    it('should return false when fetch fails', async () => {
      vi.spyOn(global, 'fetch').mockImplementation(() => 
        Promise.reject(new Error('Network error'))
      )
      
      const result = await diagnostics.testApiReachable('https://api.example.com')
      expect(result).toBe(false)
    })
  })

  describe('runFullDiagnostics', () => {
    it('should return complete test results', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true })
      
      const results = await diagnostics.runFullDiagnostics('https://api.example.com')
      
      expect(results).toHaveProperty('browserOnline')
      expect(results).toHaveProperty('internetAccess')
      expect(results).toHaveProperty('apiReachable')
      expect(results).toHaveProperty('timestamp')
    })

    it('should skip internet test when offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true })
      
      const results = await diagnostics.runFullDiagnostics('https://api.example.com')
      
      expect(results.browserOnline).toBe(false)
      expect(results.internetAccess).toBeNull()
      expect(results.apiReachable).toBeNull()
    })
  })

  describe('generateSuggestions', () => {
    it('should suggest checking network when offline', () => {
      const results: NetworkTestResult = {
        browserOnline: false,
        internetAccess: null,
        apiReachable: null,
        timestamp: Date.now()
      }
      
      const suggestions = diagnostics.generateSuggestions(results)
      expect(suggestions.some(s => s.includes('离线'))).toBe(true)
    })

    it('should suggest checking internet when no internet access', () => {
      const results: NetworkTestResult = {
        browserOnline: true,
        internetAccess: false,
        apiReachable: null,
        timestamp: Date.now()
      }
      
      const suggestions = diagnostics.generateSuggestions(results)
      expect(suggestions.some(s => s.includes('无法访问互联网'))).toBe(true)
    })

    it('should suggest API issues when API unreachable', () => {
      const results: NetworkTestResult = {
        browserOnline: true,
        internetAccess: true,
        apiReachable: false,
        timestamp: Date.now()
      }
      
      const suggestions = diagnostics.generateSuggestions(results)
      expect(suggestions.some(s => s.includes('API'))).toBe(true)
    })

    it('should suggest retry when all tests pass', () => {
      const results: NetworkTestResult = {
        browserOnline: true,
        internetAccess: true,
        apiReachable: true,
        timestamp: Date.now()
      }
      
      const suggestions = diagnostics.generateSuggestions(results)
      expect(suggestions.some(s => s.includes('正常'))).toBe(true)
    })
  })

  describe('formatReport', () => {
    it('should format report with all information', () => {
      const results: NetworkTestResult = {
        browserOnline: true,
        internetAccess: true,
        apiReachable: true,
        latency: 100,
        timestamp: Date.now()
      }
      const suggestions = ['网络连接正常']
      
      const report = diagnostics.formatReport(results, suggestions, 'https://api.example.com')
      
      expect(report).toContain('网络诊断报告')
      expect(report).toContain('✅')
      expect(report).toContain('https://api.example.com')
      expect(report).toContain('100ms')
    })
  })

  describe('generateReport', () => {
    it('should generate complete diagnosis report', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true })
      
      const report = await diagnostics.generateReport('https://api.example.com')
      
      expect(report).toHaveProperty('results')
      expect(report).toHaveProperty('suggestions')
      expect(report).toHaveProperty('formattedReport')
    })
  })

  describe('quickNetworkCheck', () => {
    it('should return true when online and internet accessible', async () => {
      Object.defineProperty(navigator, 'onLine', { value: true, writable: true })
      
      const result = await quickNetworkCheck()
      expect(result).toBe(true)
    })

    it('should return false when offline', async () => {
      Object.defineProperty(navigator, 'onLine', { value: false, writable: true })
      
      const result = await quickNetworkCheck()
      expect(result).toBe(false)
    })
  })
})
