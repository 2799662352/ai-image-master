// src/renderer/src/utils/dom.ts
/**
 * DOM 操作工具函数
 */

/**
 * 安全获取元素
 */
export function getElement<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

/**
 * 安全获取元素（必须存在）
 */
export function getElementOrThrow<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T | null
  if (!el) throw new Error(`Element with id "${id}" not found`)
  return el
}

/**
 * 查询选择器
 */
export function $<T extends Element>(selector: string, parent: Element | Document = document): T | null {
  return parent.querySelector<T>(selector)
}

/**
 * 查询所有选择器
 */
export function $$<T extends Element>(selector: string, parent: Element | Document = document): T[] {
  return Array.from(parent.querySelectorAll<T>(selector))
}

/**
 * 添加事件监听器
 */
export function on<K extends keyof HTMLElementEventMap>(
  element: HTMLElement | null,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions
): void {
  element?.addEventListener(event, handler as EventListener, options)
}

/**
 * 移除事件监听器
 */
export function off<K extends keyof HTMLElementEventMap>(
  element: HTMLElement | null,
  event: K,
  handler: (e: HTMLElementEventMap[K]) => void
): void {
  element?.removeEventListener(event, handler as EventListener)
}

/**
 * 添加 CSS 类
 */
export function addClass(element: HTMLElement | null, className: string): void {
  element?.classList.add(className)
}

/**
 * 移除 CSS 类
 */
export function removeClass(element: HTMLElement | null, className: string): void {
  element?.classList.remove(className)
}

/**
 * 检测是否有 CSS 类
 */
export function hasClass(element: HTMLElement | null, className: string): boolean {
  return element?.classList.contains(className) ?? false
}

/**
 * 添加/移除 CSS 类
 */
export function toggleClass(element: HTMLElement | null, className: string, force?: boolean): void {
  element?.classList.toggle(className, force)
}

/**
 * 显示元素
 */
export function show(element: HTMLElement | null): void {
  if (element) {
    element.style.display = ''
  }
}

/**
 * 隐藏元素
 */
export function hide(element: HTMLElement | null): void {
  if (element) {
    element.style.display = 'none'
  }
}

/**
 * 切换元素显示
 */
export function toggle(element: HTMLElement | null): void {
  element?.classList.toggle('hidden')
}

/**
 * 创建元素
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, any>,
  children?: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  
  if (attrs) {
    Object.entries(attrs).forEach(([key, value]) => {
      if (key === 'className') {
        el.className = value
      } else if (key === 'textContent') {
        el.textContent = value
      } else if (key in el) {
        // 直接设置 DOM 属性 (如 type, placeholder 等)
        (el as any)[key] = value
      } else {
        el.setAttribute(key, value)
      }
    })
  }
  
  if (children) {
    children.forEach(child => {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child))
      } else {
        el.appendChild(child)
      }
    })
  }
  
  return el
}

/**
 * 清空元素内容
 */
export function empty(element: HTMLElement | null): void {
  if (element) {
    element.innerHTML = ''
  }
}

/**
 * 等待 DOM 加载完成
 */
export function ready(callback: () => void): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback)
  } else {
    callback()
  }
}

/**
 * 延迟执行
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 防抖函数
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null
  
  return function (this: any, ...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout)
    timeout = setTimeout(() => fn.apply(this, args), wait)
  }
}

/**
 * 节流函数
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle = false
  
  return function (this: any, ...args: Parameters<T>) {
    if (!inThrottle) {
      fn.apply(this, args)
      inThrottle = true
      setTimeout(() => (inThrottle = false), limit)
    }
  }
}
