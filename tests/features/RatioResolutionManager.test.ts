/**
 * RatioResolutionManager 单元测试
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  RatioResolutionManager,
  createRatioResolutionManager,
  getRatioResolutionManager,
  type ModelConfig
} from '../../src/renderer/src/features/model-selector/RatioResolutionManager'

describe('RatioResolutionManager', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="ratioButtons"></div>
      <div id="resolutionContainer" class="hidden">
        <div id="resolutionButtons"></div>
      </div>
      <select id="batchRatio"></select>
    `
    
    // Mock localStorage
    vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
  })
  
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })
  
  describe('创建实例', () => {
    it('使用默认配置创建', () => {
      const manager = createRatioResolutionManager()
      expect(manager).toBeDefined()
      expect(manager.getCurrentRatio()).toBe('')
    })
    
    it('使用自定义配置创建', () => {
      const manager = createRatioResolutionManager({
        defaultRatios: [{ key: '4:3', label: '标准' }],
        ratioContainerId: 'customRatioButtons'
      })
      expect(manager).toBeDefined()
    })
  })
  
  describe('渲染比例选项', () => {
    it('渲染默认比例按钮', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model'
      }
      
      manager.renderRatioOptions(modelConfig)
      
      const container = document.getElementById('ratioButtons')!
      const buttons = container.querySelectorAll('.ratio-btn')
      
      expect(buttons.length).toBe(3) // 默认 3 个比例
    })
    
    it('渲染模型指定的比例', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'custom-model',
        displayName: 'Custom Model',
        ratios: [
          { key: '1:1', label: '正方形' },
          { key: '4:3', label: '标准' }
        ]
      }
      
      manager.renderRatioOptions(modelConfig)
      
      const container = document.getElementById('ratioButtons')!
      const buttons = container.querySelectorAll('.ratio-btn')
      
      expect(buttons.length).toBe(2)
    })
    
    it('第一个比例默认激活', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model'
      }
      
      manager.renderRatioOptions(modelConfig)
      
      const container = document.getElementById('ratioButtons')!
      const activeBtn = container.querySelector('.ratio-btn.active')
      
      expect(activeBtn).not.toBeNull()
      expect((activeBtn as HTMLElement).dataset.ratio).toBe('1:1')
    })
    
    it('使用页面引用的当前比例', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model'
      }
      const page = { currentRatio: '16:9' }
      
      manager.renderRatioOptions(modelConfig, page)
      
      const container = document.getElementById('ratioButtons')!
      const activeBtn = container.querySelector('.ratio-btn.active')
      
      expect((activeBtn as HTMLElement).dataset.ratio).toBe('16:9')
    })
  })
  
  describe('选择比例', () => {
    it('点击按钮选择比例', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model'
      }
      
      manager.renderRatioOptions(modelConfig)
      
      const container = document.getElementById('ratioButtons')!
      const buttons = container.querySelectorAll('.ratio-btn')
      
      // 点击第二个按钮
      ;(buttons[1] as HTMLElement).click()
      
      expect(manager.getCurrentRatio()).toBe('16:9')
      expect(buttons[1].classList.contains('active')).toBe(true)
      expect(buttons[0].classList.contains('active')).toBe(false)
    })
    
    it('触发比例变化回调', () => {
      const manager = createRatioResolutionManager()
      const callback = vi.fn()
      manager.onRatioChange(callback)
      
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model'
      }
      
      manager.renderRatioOptions(modelConfig)
      manager.selectRatio('16:9')
      
      expect(callback).toHaveBeenCalledWith('16:9')
    })
    
    it('取消注册回调', () => {
      const manager = createRatioResolutionManager()
      const callback = vi.fn()
      const unsubscribe = manager.onRatioChange(callback)
      
      unsubscribe()
      
      manager.selectRatio('16:9')
      
      expect(callback).not.toHaveBeenCalled()
    })
  })
  
  describe('渲染分辨率选项', () => {
    it('模型不支持分辨率时隐藏容器', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model'
      }
      
      manager.renderResolutionOptions(modelConfig)
      
      const container = document.getElementById('resolutionContainer')!
      expect(container.classList.contains('hidden')).toBe(true)
    })
    
    it('模型支持分辨率时显示按钮', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'gemini',
        displayName: 'Gemini',
        capabilities: { resolutionControl: true },
        resolutions: [
          { key: '512', label: '小' },
          { key: '1024', label: '中' },
          { key: '2048', label: '大' }
        ],
        defaultResolution: '1024'
      }
      
      manager.renderResolutionOptions(modelConfig)
      
      const container = document.getElementById('resolutionContainer')!
      const buttonsContainer = document.getElementById('resolutionButtons')!
      const buttons = buttonsContainer.querySelectorAll('.ratio-btn')
      
      expect(container.classList.contains('hidden')).toBe(false)
      expect(buttons.length).toBe(3)
    })
    
    it('使用默认分辨率', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'gemini',
        displayName: 'Gemini',
        capabilities: { resolutionControl: true },
        resolutions: [
          { key: '512', label: '小' },
          { key: '1024', label: '中' }
        ],
        defaultResolution: '1024'
      }
      
      manager.renderResolutionOptions(modelConfig)
      
      expect(manager.getCurrentResolution()).toBe('1024')
    })
    
    it('从 localStorage 读取保存的分辨率', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('512')
      
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'gemini',
        displayName: 'Gemini',
        capabilities: { resolutionControl: true },
        resolutions: [
          { key: '512', label: '小' },
          { key: '1024', label: '中' }
        ]
      }
      
      manager.renderResolutionOptions(modelConfig)
      
      expect(manager.getCurrentResolution()).toBe('512')
    })
  })
  
  describe('选择分辨率', () => {
    it('保存分辨率到 localStorage', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
      
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'gemini',
        displayName: 'Gemini',
        capabilities: { resolutionControl: true },
        resolutions: [{ key: '1024' }, { key: '2048' }]
      }
      
      manager.renderResolutionOptions(modelConfig)
      manager.selectResolution('2048')
      
      expect(setItemSpy).toHaveBeenCalledWith('gemini_resolution', '2048')
    })
    
    it('触发分辨率变化回调', () => {
      const manager = createRatioResolutionManager()
      const callback = vi.fn()
      manager.onResolutionChange(callback)
      
      const modelConfig: ModelConfig = {
        name: 'gemini',
        displayName: 'Gemini',
        capabilities: { resolutionControl: true },
        resolutions: [{ key: '1024' }, { key: '2048' }]
      }
      
      manager.renderResolutionOptions(modelConfig)
      manager.selectResolution('2048')
      
      expect(callback).toHaveBeenCalledWith('2048')
    })
  })
  
  describe('批量比例选项', () => {
    it('渲染批量比例下拉选项', () => {
      const manager = createRatioResolutionManager()
      const modelConfig: ModelConfig = {
        name: 'test-model',
        displayName: 'Test Model',
        ratios: [
          { key: '1:1', label: '正方形' },
          { key: '16:9', label: '横版' }
        ]
      }
      
      manager.renderBatchRatioOptions(modelConfig)
      
      const select = document.getElementById('batchRatio') as HTMLSelectElement
      expect(select.options.length).toBe(2)
    })
    
    it('保留之前选择的值', () => {
      const manager = createRatioResolutionManager()
      const select = document.getElementById('batchRatio') as HTMLSelectElement
      
      // 先渲染一次
      manager.renderBatchRatioOptions({
        name: 'model1',
        displayName: 'Model 1',
        ratios: [{ key: '1:1' }, { key: '16:9' }]
      })
      
      select.value = '16:9'
      
      // 再次渲染
      manager.renderBatchRatioOptions({
        name: 'model2',
        displayName: 'Model 2',
        ratios: [{ key: '1:1' }, { key: '16:9' }, { key: '9:16' }]
      })
      
      expect(select.value).toBe('16:9')
    })
  })
  
  describe('单例模式', () => {
    it('getRatioResolutionManager 返回相同实例', () => {
      const instance1 = getRatioResolutionManager()
      const instance2 = getRatioResolutionManager()
      expect(instance1).toBe(instance2)
    })
  })
})
