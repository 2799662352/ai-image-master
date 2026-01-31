// tests/utils/dom.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  $,
  $$,
  addClass,
  removeClass,
  toggleClass,
  hasClass,
  show,
  hide,
  createElement,
  empty,
  debounce,
  throttle
} from '../../src/renderer/src/utils/dom'

describe('DOM utilities', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="testElement" class="test-class">
        <span class="child">Child 1</span>
        <span class="child">Child 2</span>
      </div>
      <div class="item">Item 1</div>
      <div class="item">Item 2</div>
    `
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('$ (单元素选择器)', () => {
    it('应该通过 ID 选择元素', () => {
      const element = $('#testElement')
      
      expect(element).not.toBeNull()
      expect(element?.id).toBe('testElement')
    })

    it('应该通过类选择器选择第一个元素', () => {
      const element = $('.item')
      
      expect(element).not.toBeNull()
      expect(element?.textContent).toBe('Item 1')
    })

    it('应该返回 null 如果元素不存在', () => {
      const element = $('#nonexistent')
      
      expect(element).toBeNull()
    })
  })

  describe('$$ (多元素选择器)', () => {
    it('应该返回所有匹配的元素', () => {
      const elements = $$('.item')
      
      expect(elements.length).toBe(2)
    })

    it('应该返回空数组如果没有匹配', () => {
      const elements = $$('.nonexistent')
      
      expect(elements.length).toBe(0)
    })
  })

  describe('addClass', () => {
    it('应该添加类名', () => {
      const element = $('#testElement')!
      addClass(element, 'new-class')
      
      expect(element.classList.contains('new-class')).toBe(true)
    })
  })

  describe('removeClass', () => {
    it('应该移除类名', () => {
      const element = $('#testElement')!
      removeClass(element, 'test-class')
      
      expect(element.classList.contains('test-class')).toBe(false)
    })
  })

  describe('toggleClass', () => {
    it('应该切换类名', () => {
      const element = $('#testElement')!
      
      toggleClass(element, 'test-class')
      expect(element.classList.contains('test-class')).toBe(false)
      
      toggleClass(element, 'test-class')
      expect(element.classList.contains('test-class')).toBe(true)
    })

    it('应该支持强制添加或移除', () => {
      const element = $('#testElement')!
      
      toggleClass(element, 'new-class', true)
      expect(element.classList.contains('new-class')).toBe(true)
      
      toggleClass(element, 'new-class', false)
      expect(element.classList.contains('new-class')).toBe(false)
    })
  })

  describe('hasClass', () => {
    it('应该检测类名存在', () => {
      const element = $('#testElement')!
      
      expect(hasClass(element, 'test-class')).toBe(true)
      expect(hasClass(element, 'nonexistent')).toBe(false)
    })
  })

  describe('show', () => {
    it('应该显示元素', () => {
      const element = $('#testElement')!
      element.style.display = 'none'
      
      show(element)
      
      expect(element.style.display).not.toBe('none')
    })
  })

  describe('hide', () => {
    it('应该隐藏元素', () => {
      const element = $('#testElement')!
      
      hide(element)
      
      expect(element.style.display).toBe('none')
    })
  })

  describe('createElement', () => {
    it('应该创建元素', () => {
      const element = createElement('div', {
        className: 'my-class',
        textContent: 'Hello'
      })
      
      expect(element.tagName).toBe('DIV')
      expect(element.className).toBe('my-class')
      expect(element.textContent).toBe('Hello')
    })

    it('应该支持设置属性', () => {
      const element = createElement('input', {
        type: 'text',
        placeholder: 'Enter text'
      })
      
      expect(element.type).toBe('text')
      expect(element.placeholder).toBe('Enter text')
    })
  })

  describe('empty', () => {
    it('应该清空元素内容', () => {
      const element = $('#testElement')!
      
      empty(element)
      
      expect(element.children.length).toBe(0)
    })
  })

  describe('debounce', () => {
    it('应该延迟执行函数', async () => {
      vi.useFakeTimers()
      const fn = vi.fn()
      const debouncedFn = debounce(fn, 100)
      
      debouncedFn()
      debouncedFn()
      debouncedFn()
      
      expect(fn).not.toHaveBeenCalled()
      
      vi.advanceTimersByTime(100)
      
      expect(fn).toHaveBeenCalledTimes(1)
      vi.useRealTimers()
    })
  })

  describe('throttle', () => {
    it('应该限制函数执行频率', async () => {
      vi.useFakeTimers()
      const fn = vi.fn()
      const throttledFn = throttle(fn, 100)
      
      throttledFn()
      throttledFn()
      throttledFn()
      
      expect(fn).toHaveBeenCalledTimes(1)
      
      vi.advanceTimersByTime(100)
      throttledFn()
      
      expect(fn).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })
  })
})
