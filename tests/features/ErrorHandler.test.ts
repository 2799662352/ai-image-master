// tests/features/ErrorHandler.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ErrorHandler, createErrorHandler } from '../../src/renderer/src/features/error-handler'
import type { ErrorInfo, NetworkTestResults } from '../../src/renderer/src/features/error-handler'

describe('ErrorHandler', () => {
  let errorHandler: ErrorHandler
  let showToast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    showToast = vi.fn()
    errorHandler = createErrorHandler({ showToast })
  })

  afterEach(() => {
    errorHandler.closeAll()
    document.body.innerHTML = ''
  })

  describe('getRejectionTypeName', () => {
    it('should return friendly name for known rejection types', () => {
      expect(errorHandler.getRejectionTypeName('watermark_removal')).toBe('去水印请求')
      expect(errorHandler.getRejectionTypeName('faceswap')).toBe('换脸请求')
      expect(errorHandler.getRejectionTypeName('nsfw')).toBe('NSFW内容')
      expect(errorHandler.getRejectionTypeName('finish_reason')).toBe('API 拒绝（finishReason）')
    })

    it('should return original type for unknown rejection types', () => {
      expect(errorHandler.getRejectionTypeName('unknown_type')).toBe('unknown_type')
    })
  })

  describe('formatErrorForCopy', () => {
    it('should format basic error info', () => {
      const errorInfo: ErrorInfo = {
        title: 'Test Error',
        message: 'This is a test error message'
      }

      const formatted = errorHandler.formatErrorForCopy(errorInfo)
      
      expect(formatted).toContain('Test Error')
      expect(formatted).toContain('This is a test error message')
      expect(formatted).toContain('AI图片生成错误详情')
    })

    it('should include details if provided', () => {
      const errorInfo: ErrorInfo = {
        title: 'Test Error',
        message: 'Error message',
        details: ['Check your API key', 'Try again later']
      }

      const formatted = errorHandler.formatErrorForCopy(errorInfo)
      
      expect(formatted).toContain('排查建议')
      expect(formatted).toContain('Check your API key')
      expect(formatted).toContain('Try again later')
    })

    it('should include technical details if provided', () => {
      const errorInfo: ErrorInfo = {
        title: 'Test Error',
        message: 'Error message',
        technicalDetails: ['Status: 500', 'Endpoint: /api/generate']
      }

      const formatted = errorHandler.formatErrorForCopy(errorInfo)
      
      expect(formatted).toContain('技术详情')
      expect(formatted).toContain('Status: 500')
    })

    it('should include raw response if provided', () => {
      const errorInfo: ErrorInfo = {
        title: 'Test Error',
        message: 'Error message',
        rawResponse: '{"error": "Internal server error"}'
      }

      const formatted = errorHandler.formatErrorForCopy(errorInfo)
      
      expect(formatted).toContain('完整接口响应')
      expect(formatted).toContain('Internal server error')
    })

    it('should include candidate structure if provided', () => {
      const errorInfo: ErrorInfo = {
        title: 'Test Error',
        message: 'Error message',
        candidateStructure: '{"finishReason": "SAFETY"}'
      }

      const formatted = errorHandler.formatErrorForCopy(errorInfo)
      
      expect(formatted).toContain('Candidate 结构')
      expect(formatted).toContain('SAFETY')
    })
  })

  describe('showDetailedError', () => {
    it('should create error modal in document', () => {
      const mockApi = {
        formatDetailedError: () => ({
          title: 'API Error',
          message: 'Failed to generate image'
        })
      }
      
      const handler = createErrorHandler({ 
        showToast,
        apiInstance: mockApi
      })

      handler.showDetailedError(new Error('Test error'))
      
      const modal = document.querySelector('.fixed.inset-0')
      expect(modal).not.toBeNull()
      expect(modal?.innerHTML).toContain('API Error')
      
      handler.closeAll()
    })

    it('should handle errors without API instance', () => {
      errorHandler.showDetailedError(new Error('Raw error message'))
      
      const modal = document.querySelector('.fixed.inset-0')
      expect(modal).not.toBeNull()
      expect(modal?.innerHTML).toContain('发生错误')
      
      errorHandler.closeAll()
    })
  })

  describe('showNetworkTestResults', () => {
    it('should display network test results modal', () => {
      const results: NetworkTestResults = {
        browserOnline: true,
        internetAccess: true,
        apiReachable: true,
        timestamp: Date.now()
      }

      errorHandler.showNetworkTestResults(results)
      
      const modal = document.querySelector('.fixed.inset-0')
      expect(modal).not.toBeNull()
      expect(modal?.innerHTML).toContain('网络诊断结果')
    })

    it('should show offline status correctly', () => {
      const results: NetworkTestResults = {
        browserOnline: false,
        internetAccess: null,
        apiReachable: null,
        timestamp: Date.now()
      }

      errorHandler.showNetworkTestResults(results)
      
      const modal = document.querySelector('.fixed.inset-0')
      expect(modal?.innerHTML).toContain('设备处于离线状态')
    })

    it('should show API unreachable status', () => {
      const results: NetworkTestResults = {
        browserOnline: true,
        internetAccess: true,
        apiReachable: false,
        timestamp: Date.now()
      }

      errorHandler.showNetworkTestResults(results)
      
      const modal = document.querySelector('.fixed.inset-0')
      expect(modal?.innerHTML).toContain('API 服务器可能暂时不可用')
    })
  })

  describe('closeAll', () => {
    it('should close all open modals', () => {
      errorHandler.showDetailedError(new Error('Error 1'))
      errorHandler.showDetailedError(new Error('Error 2'))
      
      const modalsBefore = document.querySelectorAll('.fixed.inset-0')
      expect(modalsBefore.length).toBe(2)
      
      errorHandler.closeAll()
      
      const modalsAfter = document.querySelectorAll('.fixed.inset-0')
      expect(modalsAfter.length).toBe(0)
    })
  })
})
