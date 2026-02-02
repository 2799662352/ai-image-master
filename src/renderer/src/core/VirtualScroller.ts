// src/renderer/src/core/VirtualScroller.ts
/**
 * 虚拟滚动器 - 只渲染可见区域的元素
 * 使用窗口/面板级滚动，不创建嵌套滚动容器
 * 基于 TanStack Virtual 最佳实践
 */

export interface VirtualScrollerOptions<T> {
  container: HTMLElement
  items: T[]
  itemHeight: number  // 估计的单项高度
  overscan?: number   // 额外渲染的缓冲项数量
  renderItem: (item: T, index: number) => HTMLElement
  onReachEnd?: () => void  // 滚动到底部回调
}

export class VirtualScroller<T> {
  private container: HTMLElement
  private items: T[]
  private itemHeight: number
  private overscan: number
  private renderItem: (item: T, index: number) => HTMLElement
  private onReachEnd?: () => void
  
  private scrollParent: HTMLElement | Window | null = null
  private contentContainer: HTMLElement | null = null
  private renderedRange: { start: number; end: number } = { start: 0, end: 0 }
  private scrollHandler: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  
  constructor(options: VirtualScrollerOptions<T>) {
    this.container = options.container
    this.items = options.items
    this.itemHeight = options.itemHeight
    this.overscan = options.overscan ?? 5
    this.renderItem = options.renderItem
    this.onReachEnd = options.onReachEnd
  }

  init(): void {
    this.setupDOM()
    this.bindEvents()
    // 延迟首次渲染，确保 DOM 已就绪
    requestAnimationFrame(() => {
      this.updateVisibleItems()
      console.log(`[VirtualScroller] 首次渲染完成，可见范围: ${this.renderedRange.start}-${this.renderedRange.end}`)
    })
  }

  private setupDOM(): void {
    // 不创建嵌套滚动容器，直接在父容器内渲染
    const totalHeight = this.items.length * this.itemHeight
    
    this.contentContainer = document.createElement('div')
    this.contentContainer.className = 'virtual-scroll-content'
    this.contentContainer.style.cssText = `
      min-height: ${totalHeight}px;
      width: 100%;
      position: relative;
    `
    
    this.container.innerHTML = ''
    this.container.appendChild(this.contentContainer)
    
    // 查找最近的可滚动父元素
    this.scrollParent = this.findScrollParent(this.container)
    
    console.log(`[VirtualScroller] 初始化: 总高度=${totalHeight}px, 项目数=${this.items.length}, 滚动父元素=${this.scrollParent === window ? 'window' : 'element'}`)
  }

  /**
   * 查找最近的可滚动父元素
   */
  private findScrollParent(element: HTMLElement): HTMLElement | Window {
    let parent = element.parentElement
    while (parent) {
      const style = getComputedStyle(parent)
      const overflow = style.overflowY
      if (overflow === 'auto' || overflow === 'scroll') {
        return parent
      }
      parent = parent.parentElement
    }
    return window
  }

  private bindEvents(): void {
    this.scrollHandler = this.throttle(() => {
      this.updateVisibleItems()
    }, 16) // ~60fps
    
    if (this.scrollParent) {
      this.scrollParent.addEventListener('scroll', this.scrollHandler, { passive: true })
    }
    
    // 监听窗口大小变化
    window.addEventListener('resize', this.scrollHandler, { passive: true })
    
    // 使用 ResizeObserver 监听容器大小变化
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateVisibleItems()
      })
      this.resizeObserver.observe(this.container)
    }
  }

  private updateVisibleItems(): void {
    if (!this.contentContainer) return
    
    // 获取内容容器相对于视口的位置
    const containerRect = this.contentContainer.getBoundingClientRect()
    const viewportHeight = window.innerHeight
    
    // 计算容器顶部相对于视口的偏移
    // containerRect.top 为正：容器顶部在视口内或下方
    // containerRect.top 为负：容器顶部已滚动出视口上方
    const scrollOffset = Math.max(0, -containerRect.top)
    
    // 计算可见区域在容器内的范围
    const visibleStart = scrollOffset
    const visibleEnd = scrollOffset + viewportHeight
    
    // 计算可见范围的索引
    const startIndex = Math.max(0, Math.floor(visibleStart / this.itemHeight) - this.overscan)
    const endIndex = Math.min(
      this.items.length,
      Math.ceil(visibleEnd / this.itemHeight) + this.overscan
    )
    
    // 确保至少渲染足够的项目填满视口
    const minItemsToRender = Math.ceil(viewportHeight / this.itemHeight) + this.overscan * 2
    const safeEndIndex = Math.max(endIndex, Math.min(this.items.length, startIndex + minItemsToRender))
    
    // 如果范围没变，跳过
    if (startIndex === this.renderedRange.start && safeEndIndex === this.renderedRange.end) {
      return
    }
    
    console.log(`[VirtualScroller] 更新: containerTop=${containerRect.top.toFixed(0)}, scrollOffset=${scrollOffset.toFixed(0)}, range=${startIndex}-${safeEndIndex}/${this.items.length}`)
    
    this.renderedRange = { start: startIndex, end: safeEndIndex }
    this.renderVisibleItems(startIndex, safeEndIndex)
    
    // 触发滚动到底部回调
    if (safeEndIndex >= this.items.length - this.overscan && this.onReachEnd) {
      this.onReachEnd()
    }
  }

  private renderVisibleItems(startIndex: number, endIndex: number): void {
    if (!this.contentContainer) return
    
    // 使用 DocumentFragment 批量更新
    const fragment = document.createDocumentFragment()
    
    for (let i = startIndex; i < endIndex; i++) {
      const item = this.items[i]
      const element = this.renderItem(item, i)
      
      // 设置绝对定位
      element.style.position = 'absolute'
      element.style.top = '0'
      element.style.left = '0'
      element.style.width = '100%'
      element.style.transform = `translateY(${i * this.itemHeight}px)`
      
      // 添加入场动画延迟
      const animationDelay = (i - startIndex) * 30
      element.style.animationDelay = `${animationDelay}ms`
      
      fragment.appendChild(element)
    }
    
    this.contentContainer.innerHTML = ''
    this.contentContainer.appendChild(fragment)
  }

  private throttle(fn: () => void, delay: number): () => void {
    let lastCall = 0
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    
    return () => {
      const now = Date.now()
      const timeSinceLastCall = now - lastCall
      
      if (timeSinceLastCall >= delay) {
        lastCall = now
        fn()
      } else if (!timeoutId) {
        timeoutId = setTimeout(() => {
          lastCall = Date.now()
          timeoutId = null
          fn()
        }, delay - timeSinceLastCall)
      }
    }
  }

  // 更新数据
  updateItems(items: T[]): void {
    this.items = items
    if (this.contentContainer) {
      this.contentContainer.style.minHeight = `${items.length * this.itemHeight}px`
    }
    this.renderedRange = { start: 0, end: 0 }  // 强制重新渲染
    this.updateVisibleItems()
  }

  // 滚动到指定索引
  scrollToIndex(index: number, behavior: ScrollBehavior = 'smooth'): void {
    if (!this.contentContainer) return
    
    const targetY = index * this.itemHeight
    const containerRect = this.contentContainer.getBoundingClientRect()
    const scrollTarget = window.scrollY + containerRect.top + targetY
    
    window.scrollTo({
      top: scrollTarget,
      behavior
    })
  }

  // 获取当前可见范围
  getVisibleRange(): { start: number; end: number } {
    return { ...this.renderedRange }
  }

  // 销毁
  destroy(): void {
    if (this.scrollHandler) {
      if (this.scrollParent) {
        this.scrollParent.removeEventListener('scroll', this.scrollHandler)
      }
      window.removeEventListener('resize', this.scrollHandler)
    }
    
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
    
    this.scrollHandler = null
    this.scrollParent = null
    this.contentContainer = null
    this.container.innerHTML = ''
  }
}
