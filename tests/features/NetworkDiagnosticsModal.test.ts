/**
 * NetworkDiagnosticsModal 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  NetworkDiagnosticsModal,
  createNetworkDiagnosticsModal,
  getNetworkDiagnosticsModal,
  type NetworkRestrictedInfo
} from '../../src/renderer/src/features/error-handler/NetworkDiagnosticsModal'

describe('NetworkDiagnosticsModal', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    })
  })
  
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })
  
  const createTestInfo = (): NetworkRestrictedInfo => ({
    inaccessibleUrls: ['https://example.com/image1.png'],
    allUrls: [
      'https://example.com/image1.png',
      'https://example.com/image2.png'
    ],
    content: '{"status": "success"}',
    suggestions: ['尝试使用 VPN', '检查网络连接']
  })
  
  describe('创建实例', () => {
    it('使用默认配置创建', () => {
      const modal = createNetworkDiagnosticsModal()
      expect(modal).toBeDefined()
    })
    
    it('使用自定义配置创建', () => {
      const showToast = vi.fn()
      const modal = createNetworkDiagnosticsModal({ showToast })
      expect(modal).toBeDefined()
    })
  })
  
  describe('显示模态框', () => {
    it('show() 创建模态框元素', () => {
      const modal = createNetworkDiagnosticsModal()
      
      modal.show(createTestInfo())
      
      const modalElement = document.querySelector('[role="dialog"]')
      expect(modalElement).not.toBeNull()
    })
    
    it('显示正确的标题', () => {
      const modal = createNetworkDiagnosticsModal()
      
      modal.show(createTestInfo())
      
      const title = document.getElementById('network-restricted-title')
      expect(title?.textContent).toContain('网络访问受限')
    })
    
    it('显示所有 URL', () => {
      const modal = createNetworkDiagnosticsModal()
      const info = createTestInfo()
      
      modal.show(info)
      
      const urlItems = document.querySelectorAll('[role="listitem"]')
      expect(urlItems.length).toBe(2)
    })
    
    it('区分可访问和不可访问的 URL', () => {
      const modal = createNetworkDiagnosticsModal()
      
      modal.show(createTestInfo())
      
      const items = document.querySelectorAll('[role="listitem"]')
      
      // 第一个是不可访问的
      expect(items[0].classList.contains('bg-red-50')).toBe(true)
      
      // 第二个是可访问的
      expect(items[1].classList.contains('bg-green-50')).toBe(true)
    })
    
    it('显示解决方案建议', () => {
      const modal = createNetworkDiagnosticsModal()
      
      modal.show(createTestInfo())
      
      const content = document.body.innerHTML
      expect(content).toContain('尝试使用 VPN')
      expect(content).toContain('检查网络连接')
    })
  })
  
  describe('隐藏模态框', () => {
    it('hide() 移除模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      
      modal.show(createTestInfo())
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
      
      modal.hide()
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    
    it('显示新模态框前关闭旧模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      
      modal.show(createTestInfo())
      modal.show(createTestInfo())
      
      const modals = document.querySelectorAll('[role="dialog"]')
      expect(modals.length).toBe(1)
    })
  })
  
  describe('关闭按钮', () => {
    it('点击关闭按钮关闭模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const closeBtn = document.querySelector('.network-close-btn') as HTMLElement
      closeBtn.click()
      
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    
    it('点击页脚关闭按钮关闭模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const closeBtn = document.querySelector('.network-close-btn-footer') as HTMLElement
      closeBtn.click()
      
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    
    it('点击背景关闭模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const backdrop = document.querySelector('[role="dialog"]') as HTMLElement
      backdrop.click()
      
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
    
    it('ESC 键关闭模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const event = new KeyboardEvent('keydown', { key: 'Escape' })
      document.dispatchEvent(event)
      
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
  })
  
  describe('复制功能', () => {
    it('复制单个 URL', async () => {
      const showToast = vi.fn()
      const modal = createNetworkDiagnosticsModal({ showToast })
      modal.show(createTestInfo())
      
      const copyBtn = document.querySelector('.copy-url-btn') as HTMLElement
      copyBtn.click()
      
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled()
        expect(showToast).toHaveBeenCalledWith('图片地址已复制', 'success')
      })
    })
    
    it('复制所有 URL', async () => {
      const showToast = vi.fn()
      const modal = createNetworkDiagnosticsModal({ showToast })
      modal.show(createTestInfo())
      
      const copyAllBtn = document.querySelector('.copy-all-urls-btn') as HTMLElement
      copyAllBtn.click()
      
      await vi.waitFor(() => {
        expect(navigator.clipboard.writeText).toHaveBeenCalled()
        expect(showToast).toHaveBeenCalledWith('所有图片地址已复制', 'success')
      })
    })
  })
  
  describe('新窗口打开', () => {
    it('点击新窗口按钮打开 URL', () => {
      const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
      
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const openBtn = document.querySelector('.open-url-btn') as HTMLElement
      openBtn.click()
      
      expect(windowOpen).toHaveBeenCalledWith(
        expect.stringContaining('example.com'),
        '_blank'
      )
    })
  })
  
  describe('标记可访问', () => {
    it('标记 URL 为可访问', async () => {
      const showToast = vi.fn()
      const markUrlAsAccessible = vi.fn()
      
      const modal = createNetworkDiagnosticsModal({ 
        showToast,
        markUrlAsAccessible
      })
      modal.show(createTestInfo())
      
      const markBtn = document.querySelector('.mark-accessible-btn') as HTMLElement
      markBtn.click()
      
      expect(markUrlAsAccessible).toHaveBeenCalledWith('https://example.com/image1.png')
      expect(showToast).toHaveBeenCalledWith(
        expect.stringContaining('已标记为可访问'),
        'success'
      )
    })
  })
  
  describe('保存到历史记录', () => {
    it('调用 addToHistory 回调', () => {
      const addToHistory = vi.fn()
      const showToast = vi.fn()
      const getPrompt = vi.fn().mockReturnValue('test prompt')
      
      const modal = createNetworkDiagnosticsModal({
        addToHistory,
        showToast,
        getPrompt
      })
      modal.show(createTestInfo())
      
      const saveBtn = document.querySelector('.save-to-history-btn') as HTMLElement
      saveBtn.click()
      
      expect(addToHistory).toHaveBeenCalledWith(
        'network_restricted',
        'test prompt',
        expect.any(Array),
        '网络受限'
      )
      expect(showToast).toHaveBeenCalledWith('已保存到历史记录', 'success')
    })
  })
  
  describe('技术详情', () => {
    it('展开/收起技术详情', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const toggleBtn = document.querySelector('.toggle-technical-info') as HTMLElement
      const content = document.querySelector('.technical-info-content') as HTMLElement
      
      expect(content.classList.contains('hidden')).toBe(true)
      
      toggleBtn.click()
      expect(content.classList.contains('hidden')).toBe(false)
      
      toggleBtn.click()
      expect(content.classList.contains('hidden')).toBe(true)
    })
  })
  
  describe('事件监听', () => {
    it('init() 监听 networkRestrictedImages 事件', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.init()
      
      const event = new CustomEvent('networkRestrictedImages', {
        detail: createTestInfo()
      })
      window.dispatchEvent(event)
      
      expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
  })
  
  describe('销毁', () => {
    it('destroy() 关闭模态框', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      modal.destroy()
      
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
  })
  
  describe('单例模式', () => {
    it('getNetworkDiagnosticsModal 返回相同实例', () => {
      const instance1 = getNetworkDiagnosticsModal()
      const instance2 = getNetworkDiagnosticsModal()
      expect(instance1).toBe(instance2)
    })
  })
  
  describe('可访问性', () => {
    it('模态框有正确的 ARIA 属性', () => {
      const modal = createNetworkDiagnosticsModal()
      modal.show(createTestInfo())
      
      const dialog = document.querySelector('[role="dialog"]')
      expect(dialog?.getAttribute('aria-modal')).toBe('true')
      expect(dialog?.getAttribute('aria-labelledby')).toBe('network-restricted-title')
    })
  })
})
