// src/renderer/src/pages/HistoryPage.ts
/**
 * 历史记录页面模块 (TypeScript)
 * @description 管理生成历史记录的显示和操作
 */

import { BasePage, type AppInterface } from './BasePage'
import { getHistoryManager } from '../features/history/HistoryManager'
import { VirtualScroller } from '../core/VirtualScroller'
import { isValidImageUrl, isPendingUrl, filterValidImageUrls, getFirstValidThumbnail } from '../utils/url-validator'
import { getR2StorageService } from '../services/r2-storage'

// Types
export interface HistoryItem {
  id: number
  type: 'generate' | 'edit' | 'batch' | 'compare' | 'network_restricted' | 'generate-with-reference'
  prompt: string
  urls: string[]
  timestamp: string
  model?: string
  ratio?: string
  r2Storage?: boolean
  uploading?: boolean
  originalUrls?: string[]
  referenceImages?: any[]
  comparison?: {
    leftModelName?: string
    rightModelName?: string
    winnerModelName?: string
  }
}

export interface StorageInfo {
  totalSize: string
  historySize: string
  historyCount: number
  estimatedLimit: number
  r2Enabled: boolean
}

export function resolveHistoryItemDisplayUrls(item: Pick<HistoryItem, 'urls' | 'originalUrls'>): string[] {
  const directUrls = filterValidImageUrls(item.urls || [])
  if (directUrls.length > 0) return directUrls

  const hasPendingPlaceholder = (item.urls || []).some((url) => isPendingUrl(url))
  if (!hasPendingPlaceholder) return []

  return filterValidImageUrls(item.originalUrls || [])
}

export class HistoryPage extends BasePage {
  private storageInfoCache: StorageInfo | null = null
  private storageInfoCacheTime: number = 0
  private readonly CACHE_DURATION: number = 5000
  private readonly CHUNK_SIZE: number = 10
  private historyItemsMap: Map<number, HistoryItem> = new Map()
  private unsubscribeHistoryChange: (() => void) | null = null
  private isLoading: boolean = false
  private loadingTimeout: ReturnType<typeof setTimeout> | null = null
  private virtualScroller: VirtualScroller<HistoryItem> | null = null
  private readonly ITEM_HEIGHT = 88  // 预估卡片高度 (含缩略图)
  private loadRequestId: number = 0  // 用于防止竞态条件

  // 无限滚动分页属性
  private readonly PAGE_SIZE = 30
  private currentPage = 0
  private hasMoreItems = true
  private loadMoreObserver: IntersectionObserver | null = null
  private allHistoryItems: HistoryItem[] = []  // 缓存所有历史记录

  // 图片懒加载 Observer
  private imageObserver: IntersectionObserver | null = null

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  init(): void {
    this.bindEvents()
    this.bindDelegatedEvents()
    this.bindUploadSuccessListener()
    this.subscribeToHistoryChanges()
    this.isInitialized = true
  }

  /**
   * 订阅 HistoryManager 数据变更，实现实时刷新
   */
  private subscribeToHistoryChanges(): void {
    // 避免重复订阅
    if (this.unsubscribeHistoryChange) {
      this.unsubscribeHistoryChange()
    }

    const historyManager = getHistoryManager()
    this.unsubscribeHistoryChange = historyManager.onChange((history, action) => {
      console.log(`[HistoryPage] 收到数据变更通知: ${action}, 记录数: ${history.length}`)
      
      // 同步更新 app.history 确保数据一致性
      this.app.history = [...history]
      
      // 只在页面可见时刷新 UI
      if (this.isVisible()) {
        this.loadPanel()
      }
    })

    console.log('[HistoryPage] 已订阅 HistoryManager 数据变更')
  }

  /**
   * 检查页面是否可见
   */
  private isVisible(): boolean {
    const panel = document.getElementById('historyPanel')
    return panel !== null && !panel.classList.contains('hidden')
  }

  /**
   * 监听上传成功事件，显示视觉反馈
   */
  private bindUploadSuccessListener(): void {
    window.addEventListener('historyUploadSuccess', ((event: CustomEvent) => {
      const { itemId, imageCount } = event.detail
      this.showUploadSuccessFeedback(itemId, imageCount)
    }) as EventListener)
  }

  /**
   * 显示上传成功的视觉反馈 - Cyberpunk 风格
   */
  private showUploadSuccessFeedback(itemId: number, imageCount: number): void {
    // 1. 刷新面板以确保显示最新状态
    this.loadPanel()

    // 2. 延迟一帧确保 DOM 已更新
    requestAnimationFrame(() => {
      // 3. 为对应的历史记录卡片添加成功动画
      const historyCard = document.querySelector(`[data-history-id="${itemId}"]`) as HTMLElement
      if (historyCard) {
        // Cyberpunk 黄色闪光边框效果
        historyCard.style.transition = 'all 0.3s ease-out'
        historyCard.style.boxShadow = '0 0 30px rgba(252, 227, 0, 0.6), inset 0 0 20px rgba(252, 227, 0, 0.1)'
        historyCard.style.borderColor = '#FCE300'
        historyCard.style.borderWidth = '2px'
        historyCard.style.borderStyle = 'solid'
        
        // 找到云端标签并添加弹出 + 闪烁动画
        const cloudBadge = historyCard.querySelector('.cloud-badge') as HTMLElement
        if (cloudBadge) {
          cloudBadge.style.transition = 'all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)'
          cloudBadge.style.transform = 'scale(1.3)'
          cloudBadge.style.boxShadow = '0 0 15px rgba(34, 197, 94, 0.8)'
          
          setTimeout(() => {
            cloudBadge.style.transform = 'scale(1)'
            cloudBadge.style.boxShadow = ''
          }, 400)
        }

        // 移除卡片动画效果
        setTimeout(() => {
          historyCard.style.boxShadow = ''
          historyCard.style.borderColor = ''
          historyCard.style.borderWidth = ''
          historyCard.style.borderStyle = ''
        }, 1500)
      }

      // 4. 显示成功 Toast（带图标）
      const message = imageCount > 1 
        ? this.t('history.messages.uploadSuccess', { count: imageCount })
        : this.t('history.messages.uploadSuccessSingle')
      this.showToast(message, 'success')
    })
  }

  bindEvents(): void {
    const clearHistoryBtn = this.getElement('clearHistory')
    if (clearHistoryBtn) {
      clearHistoryBtn.addEventListener('click', () => this.clearHistory())
    }
  }

  saveState(): void {
    // History page doesn't need to save state
  }

  async restoreState(): Promise<void> {
    // History page loads fresh each time
    this.stateRestored = true
  }

  // ==================== 事件委托 ====================

  private bindDelegatedEvents(): void {
    const historyList = this.getElement('historyList')
    if (!historyList) return

    historyList.addEventListener('click', (e: Event) => {
      const target = e.target as HTMLElement
      // 支持 button 和其他带 data-action 的元素（如缩略图 div）
      const actionElement = target.closest('[data-action]') as HTMLElement | null
      if (!actionElement) return

      const action = actionElement.dataset.action
      const itemId = parseInt(actionElement.dataset.itemId || '0', 10)
      const item = this.historyItemsMap.get(itemId)

      if (!item) {
        console.warn('历史记录项未找到:', itemId)
        return
      }

      switch (action) {
        case 'view':
          this.viewImage(resolveHistoryItemDisplayUrls(item), 0)
          break
        case 'network-restricted':
          this.showNetworkRestrictedActions(item.urls, item.prompt)
          break
        case 'download-single':
          this.downloadImage(resolveHistoryItemDisplayUrls(item)[0] || '')
          break
        case 'download-multiple':
          this.downloadMultipleImages(resolveHistoryItemDisplayUrls(item), item.prompt)
          break
        case 'migrate':
          this.migrateToCloud(itemId)
          break
        case 'delete':
          this.deleteHistoryItem(itemId)
          break
      }
    })
  }

  private viewImage(urls: string[], index: number): void {
    // 过滤掉无效 URL
    const validUrls = filterValidImageUrls(urls)
    if (validUrls.length === 0) return
    
    const imageViewer = (window as any).imageViewerTS
    if (imageViewer?.open) {
      imageViewer.open(validUrls, Math.min(index, validUrls.length - 1))
    } else if ((this.app as any).viewImage) {
      ;(this.app as any).viewImage(validUrls, Math.min(index, validUrls.length - 1))
    }
  }

  private downloadImage(url: string): void {
    // 检查 URL 有效性
    if (!isValidImageUrl(url)) {
      this.showToast(this.t('history.messages.uploading') || '图片正在上传中，请稍候', 'warning')
      return
    }
    
    if ((this.app as any).downloadImage) {
      ;(this.app as any).downloadImage(url)
    } else {
      // Fallback: open in new tab
      window.open(url, '_blank')
    }
  }

  // ==================== 面板加载 ====================

  /**
   * 显示骨架屏加载状态
   */
  private showSkeleton(): void {
    const historyList = this.getElement('historyList')
    if (!historyList) return

    const skeletonCount = 6
    const skeletons = Array(skeletonCount).fill(0).map((_, index) => `
      <div class="history-skeleton bg-white/5 rounded-lg p-4 flex items-center space-x-4"
           style="animation-delay: ${index * 100}ms">
        <div class="flex-shrink-0">
          <div class="w-10 h-10 bg-white/10 rounded-lg skeleton-pulse"></div>
        </div>
        <div class="flex-1 min-w-0 space-y-2">
          <div class="h-4 bg-white/10 rounded w-3/4 skeleton-pulse"></div>
          <div class="flex space-x-2">
            <div class="h-3 bg-white/10 rounded w-16 skeleton-pulse"></div>
            <div class="h-3 bg-white/10 rounded w-24 skeleton-pulse"></div>
          </div>
        </div>
        <div class="flex-shrink-0 flex space-x-2">
          <div class="w-8 h-8 bg-white/10 rounded-lg skeleton-pulse"></div>
          <div class="w-8 h-8 bg-white/10 rounded-lg skeleton-pulse"></div>
          <div class="w-8 h-8 bg-white/10 rounded-lg skeleton-pulse"></div>
        </div>
      </div>
    `).join('')

    historyList.innerHTML = skeletons
  }

  /**
   * 隐藏骨架屏
   */
  private hideSkeleton(): void {
    this.isLoading = false
  }

  loadPanel(): void {
    // React 接管时 (存在 #history-react-root) 直接短路,由 React 版渲染
    if (document.getElementById('history-react-root')) {
      this.isLoading = false
      return
    }

    const historyList = this.getElement('historyList')
    if (!historyList) return

    // 如果正在加载，跳过
    if (this.isLoading) return
    
    // 生成新的请求 ID，用于防止竞态条件
    const currentRequestId = ++this.loadRequestId
    this.isLoading = true

    // 清除之前的加载超时
    if (this.loadingTimeout) {
      clearTimeout(this.loadingTimeout)
    }

    // 先显示骨架屏
    this.showSkeleton()

    // 使用 requestIdleCallback 延迟加载数据，避免阻塞 UI
    this.requestIdleCallback(() => {
      // 检查是否仍是当前请求（防止竞态条件）
      if (currentRequestId !== this.loadRequestId) {
        return
      }
      this.loadPanelData()
    }, { timeout: 100 })
  }

  /**
   * 实际加载面板数据
   */
  private loadPanelData(): void {
    const historyList = this.getElement('historyList')
    if (!historyList) {
      this.isLoading = false
      return
    }
    
    // 优先从 HistoryManager 获取最新数据，确保实时同步
    const historyManager = getHistoryManager()
    const history = historyManager.getAll().length > 0 
      ? historyManager.getAll() 
      : (this.app.history || [])

    // 缓存所有历史记录（用于无限滚动）
    this.allHistoryItems = history
    this.currentPage = 0
    this.hasMoreItems = history.length > this.PAGE_SIZE

    // 清空历史项目映射
    this.historyItemsMap.clear()

    // 构建历史项目映射
    history.forEach((item: HistoryItem) => {
      this.historyItemsMap.set(item.id, item)
    })

    // 更新存储状态（异步，不阻塞）
    this.requestIdleCallback(() => {
      this.updateStorageStatusCached()
    }, { timeout: 500 })

    if (history.length === 0) {
      const emptyText = this.t('history.labels.empty')
      historyList.innerHTML = `
        <div class="text-center text-white opacity-50 py-8">
          <i class="fas fa-history text-4xl mb-4"></i>
          <p>${emptyText}</p>
        </div>
      `
      this.isLoading = false
      return
    }

    // 直接分块渲染所有记录（禁用虚拟滚动，避免渲染 bug）
    historyList.innerHTML = ''
    this.renderHistoryChunked(history, historyList, 0)

    this.isLoading = false
  }

  private initVirtualScroller(history: HistoryItem[], container: HTMLElement): void {
    // 销毁旧实例
    if (this.virtualScroller) {
      this.virtualScroller.destroy()
    }

    this.virtualScroller = new VirtualScroller({
      container,
      items: history,
      itemHeight: this.ITEM_HEIGHT,
      overscan: 5,
      renderItem: (item: HistoryItem, _index: number) => this.createHistoryCard(item)
    })
    
    this.virtualScroller.init()
    console.log(`[HistoryPage] 虚拟滚动已启用，共 ${history.length} 条记录`)

    // 设置无限滚动
    this.requestIdleCallback(() => {
      this.setupInfiniteScroll()
    }, { timeout: 500 })
  }

  /**
   * 设置无限滚动 (Intersection Observer)
   * 注意: VirtualScroller 使用窗口级滚动，已包含所有数据
   * 无限滚动目前不需要，因为虚拟滚动已处理全部数据
   */
  private setupInfiniteScroll(): void {
    // VirtualScroller 已经包含全部数据，使用虚拟渲染
    // 无需额外的无限滚动加载逻辑
    console.log('[HistoryPage] 虚拟滚动已包含全部数据，无需无限滚动')
  }

  /**
   * 旧版无限滚动 (已废弃)
   * 保留用于非虚拟滚动模式
   */
  private setupInfiniteScrollLegacy(): void {
    const historyList = this.getElement('historyList')
    if (!historyList) return
    
    // 清理旧的 Observer
    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect()
      this.loadMoreObserver = null
    }

    // 移除旧的哨兵元素
    const oldSentinel = historyList.querySelector('[data-sentinel="true"]')
    if (oldSentinel) {
      oldSentinel.remove()
    }

    // 创建哨兵元素
    const sentinel = document.createElement('div')
    sentinel.className = 'history-load-more-sentinel'
    sentinel.style.cssText = 'height: 1px; width: 100%;'
    sentinel.setAttribute('data-sentinel', 'true')
    
    // 使用窗口级滚动检测
    const contentContainer = historyList.querySelector('.virtual-scroll-content') || historyList
    contentContainer.appendChild(sentinel)
    
    // 使用 Intersection Observer 检测滚动到底部 (root: null = viewport)
    this.loadMoreObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && this.hasMoreItems && !this.isLoading) {
            this.loadMoreItems()
          }
        })
      },
      {
        root: null,  // 使用视口
        threshold: 0.1,
        rootMargin: '100px'  // 提前 100px 触发
      }
    )
    
    this.loadMoreObserver.observe(sentinel)
    console.log('[HistoryPage] 无限滚动已启用')
  }

  /**
   * 加载更多历史记录
   */
  private loadMoreItems(): void {
    if (!this.hasMoreItems || this.isLoading) return
    
    const nextPage = this.currentPage + 1
    const startIndex = nextPage * this.PAGE_SIZE
    const endIndex = startIndex + this.PAGE_SIZE
    
    if (startIndex >= this.allHistoryItems.length) {
      this.hasMoreItems = false
      return
    }
    
    this.currentPage = nextPage
    
    // 检查是否还有更多
    if (endIndex >= this.allHistoryItems.length) {
      this.hasMoreItems = false
    }
    
    // 获取累积数据
    const itemsToRender = this.allHistoryItems.slice(0, endIndex)
    
    // 更新虚拟滚动数据
    if (this.virtualScroller) {
      this.virtualScroller.updateItems(itemsToRender)
    }
    
    console.log(`[HistoryPage] 加载更多: 第 ${nextPage + 1} 页，共 ${itemsToRender.length}/${this.allHistoryItems.length} 条`)
  }

  private renderHistoryChunked(history: HistoryItem[], container: HTMLElement, startIndex: number): void {
    const endIndex = Math.min(startIndex + this.CHUNK_SIZE, history.length)
    const fragment = document.createDocumentFragment()

    for (let i = startIndex; i < endIndex; i++) {
      const card = this.createHistoryCard(history[i])
      fragment.appendChild(card)
    }

    container.appendChild(fragment)

    if (endIndex < history.length) {
      requestAnimationFrame(() => {
        this.renderHistoryChunked(history, container, endIndex)
      })
    } else {
      // 渲染完成，隐藏骨架屏
      this.isLoading = false
      this.scheduleImagePreload(history)
    }
  }

  // ==================== 历史卡片创建 ====================

  private createHistoryCard(item: HistoryItem): HTMLElement {
    const historyCard = document.createElement('div')

    const isNetworkRestricted = item.type === 'network_restricted'
    const isComparison = item.type === 'compare'
    const isCloudStored = item.r2Storage === true
    const isUploading = item.uploading === true
    const hasPlaceholder = item.urls && item.urls.some((url) => isPendingUrl(url))
    const displayUrls = resolveHistoryItemDisplayUrls(item)
    const hasDisplayUrls = displayUrls.length > 0

    // 添加 data-history-id 用于动画定位
    historyCard.setAttribute('data-history-id', String(item.id))

    // 使用新的 history-card 样式类
    historyCard.className = `history-card rounded-xl p-3 flex items-center gap-4 group ${
      isNetworkRestricted ? 'border-orange-500/30' : ''
    } ${isComparison ? 'border-purple-500/30' : ''}`

    const typeIconMap: Record<string, string> = {
      generate: 'fa-magic',
      edit: 'fa-edit',
      batch: 'fa-layer-group',
      compare: 'fa-balance-scale',
      network_restricted: 'fa-exclamation-triangle',
      'generate-with-reference': 'fa-images'
    }
    const typeIcon = typeIconMap[item.type] || 'fa-image'

    // 格式化日期
    const dateObj = new Date(item.timestamp)
    const date = dateObj.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
    const time = dateObj.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    const imageCountText = item.urls.length > 1 ? `${item.urls.length}张` : ''

    // 获取缩略图 URL（排除无效 URL）
    const thumbnailUrl = getFirstValidThumbnail(displayUrls)

    // 缩略图 HTML - 可点击预览
    const thumbnailHtml = thumbnailUrl 
      ? `<div class="history-thumbnail flex-shrink-0 w-14 h-14 rounded-lg overflow-hidden ring-1 ring-white/10 cursor-pointer relative group/thumb" 
             data-action="view" data-item-id="${item.id}" title="点击预览">
          <img src="${thumbnailUrl}" alt="" class="w-full h-full object-cover transition-transform duration-300 group-hover/thumb:scale-110" loading="lazy" decoding="async" />
          <div class="absolute inset-0 bg-black/0 group-hover/thumb:bg-black/40 transition-all duration-300 flex items-center justify-center">
            <i class="fas fa-search-plus text-white opacity-0 group-hover/thumb:opacity-100 transition-opacity duration-300"></i>
          </div>
        </div>`
      : `<div class="history-thumbnail flex-shrink-0 w-14 h-14 rounded-lg bg-gradient-to-br from-white/10 to-white/5 flex items-center justify-center ring-1 ring-white/10 cursor-pointer"
             data-action="view" data-item-id="${item.id}" title="点击预览">
          <i class="fas ${typeIcon} text-xl ${
            isNetworkRestricted ? 'text-orange-400' : isComparison ? 'text-purple-400' : 'text-white/50'
          }"></i>
        </div>`

    // 存储状态徽章 - 使用新样式
    const storageBadge = isUploading || hasPlaceholder
      ? `<span class="badge-uploading inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-yellow-300 whitespace-nowrap">
          <i class="fas fa-cloud-upload-alt fa-spin text-yellow-400"></i>${this.t('history.storage.uploading')}
        </span>`
      : isCloudStored
      ? `<span class="badge-cloud inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-green-300 whitespace-nowrap">
          <i class="fas fa-check-circle text-green-400"></i>${this.t('history.storage.cloud')}
        </span>`
      : `<span class="badge-local inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full text-gray-400 whitespace-nowrap">
          <i class="fas fa-hdd text-gray-500"></i>${this.t('history.storage.local')}
        </span>`

    // 特殊项目标识
    let specialBadge = ''
    if (isNetworkRestricted) {
      specialBadge = `<span class="inline-flex items-center gap-1 text-xs bg-orange-500/20 text-orange-300 px-2 py-0.5 rounded-full border border-orange-500/30 whitespace-nowrap">
        <i class="fas fa-wifi text-orange-400"></i>${this.t('history.types.networkRestricted')}
      </span>`
    } else if (isComparison && item.comparison?.winnerModelName) {
      specialBadge = `<span class="inline-flex items-center gap-1 text-xs bg-purple-500/20 text-purple-300 px-2 py-0.5 rounded-full border border-purple-500/30 whitespace-nowrap">
        <i class="fas fa-trophy text-purple-400"></i>${this.t('history.types.winner', { model: item.comparison.winnerModelName })}
      </span>`
    } else if (isComparison) {
      specialBadge = `<span class="inline-flex items-center gap-1 text-xs bg-gray-500/20 text-gray-400 px-2 py-0.5 rounded-full border border-gray-500/30 whitespace-nowrap">
        <i class="fas fa-balance-scale text-gray-500"></i>${this.t('history.types.pending')}
      </span>`
    }

    // 对比详情
    const comparisonDetails =
      isComparison && item.comparison
        ? `<div class="text-xs text-white/50 mt-1">
            <span>${item.comparison.leftModelName} vs ${item.comparison.rightModelName}</span>
            ${item.referenceImages && item.referenceImages.length > 0 ? ` · ${item.referenceImages.length}张参考图` : ''}
          </div>`
        : ''

    // 截断过长的提示词
    const maxPromptLength = 50
    const displayPrompt = item.prompt.length > maxPromptLength 
      ? item.prompt.substring(0, maxPromptLength) + '...' 
      : item.prompt

    historyCard.innerHTML = `
      ${thumbnailHtml}
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <h4 class="text-white font-medium text-sm truncate max-w-[200px]" title="${item.prompt}">${displayPrompt}</h4>
          ${imageCountText ? `<span class="text-xs text-cyan-400/80">(${imageCountText})</span>` : ''}
          ${storageBadge}
          ${specialBadge}
        </div>
        <div class="flex items-center gap-2 mt-1 text-xs text-white/40">
          <span class="inline-flex items-center gap-1">
            <i class="fas fa-clock text-white/30"></i>${date} ${time}
          </span>
          ${item.model ? `<span class="meta-dot"></span><span class="inline-flex items-center gap-1"><i class="fas fa-robot text-cyan-400/50"></i>${item.model}</span>` : ''}
          ${item.ratio && item.ratio !== '网络受限' ? `<span class="meta-dot"></span><span class="inline-flex items-center gap-1"><i class="fas fa-expand text-purple-400/50"></i>${item.ratio}</span>` : ''}
        </div>
        ${isNetworkRestricted ? '<p class="text-orange-300/80 text-xs mt-1">✓ 生成成功，需要特殊网络访问</p>' : ''}
        ${comparisonDetails}
      </div>
      <div class="flex items-center gap-1.5 flex-shrink-0">
        ${
          hasDisplayUrls
            ? `
            <button data-action="view" data-item-id="${item.id}" class="history-action-btn view-btn p-2 rounded-lg bg-white/5 hover:bg-cyan-500/20 text-white/70 hover:text-cyan-400" title="查看图片">
              <i class="fas fa-eye"></i>
            </button>
            ${
              isNetworkRestricted
                ? `<button data-action="network-restricted" data-item-id="${item.id}" class="history-action-btn p-2 rounded-lg bg-orange-500/20 hover:bg-orange-500/30 text-orange-400" title="网络受限选项">
                    <i class="fas fa-link"></i>
                  </button>`
                : displayUrls.length === 1
                ? `<button data-action="download-single" data-item-id="${item.id}" class="history-action-btn download-btn p-2 rounded-lg bg-white/5 hover:bg-green-500/20 text-white/70 hover:text-green-400" title="下载图片">
                    <i class="fas fa-download"></i>
                  </button>`
                : `<button data-action="download-multiple" data-item-id="${item.id}" class="history-action-btn download-btn p-2 rounded-lg bg-white/5 hover:bg-green-500/20 text-white/70 hover:text-green-400" title="批量下载">
                    <i class="fas fa-file-archive"></i>
                  </button>`
            }`
            : hasPlaceholder
            ? `<button disabled class="p-2 rounded-lg bg-gray-500/10 text-gray-500 cursor-not-allowed" title="图片上传中">
                <i class="fas fa-hourglass-half"></i>
              </button>`
            : ''
        }
        ${
          !isCloudStored && !hasPlaceholder && item.urls.some((url) => url.startsWith('data:'))
            ? `<button data-action="migrate" data-item-id="${item.id}" class="history-action-btn p-2 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 text-blue-400" title="迁移到云端">
                <i class="fas fa-cloud-upload-alt"></i>
              </button>`
            : ''
        }
        <button data-action="delete" data-item-id="${item.id}" class="history-action-btn delete-btn p-2 rounded-lg bg-white/5 hover:bg-red-500/20 text-white/70 hover:text-red-400" title="删除记录">
          <i class="fas fa-trash-alt"></i>
        </button>
      </div>
    `

    return historyCard
  }

  // ==================== 图片预加载 ====================

  private scheduleImagePreload(history: HistoryItem[]): void {
    // 只预加载前 8 条记录的首张图片（减少内存压力）
    const itemsToPreload = history.slice(0, 8)
    
    const allUrls = itemsToPreload
      .map((item) => item.urls?.[0])  // 只取每条记录的第一张图
      .filter((url): url is string => isValidImageUrl(url))
    
    // 限制最多 8 张图片
    const limitedUrls = allUrls.slice(0, 8)
    
    if (limitedUrls.length > 0) {
      this.requestIdleCallback(
        () => {
          this.getApi()?.preloadImages?.(limitedUrls)
          console.log(`[HistoryPage] 预加载 ${limitedUrls.length} 张首屏图片`)
        },
        { timeout: 2000 }
      )
    }
  }

  /**
   * 设置图片懒加载 (Intersection Observer)
   * 用于更精细的图片加载控制
   */
  private setupImageLazyLoading(): void {
    // 清理旧的 Observer
    if (this.imageObserver) {
      this.imageObserver.disconnect()
    }
    
    this.imageObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const img = entry.target as HTMLImageElement
            if (img.dataset.src) {
              img.src = img.dataset.src
              img.removeAttribute('data-src')
              observer.unobserve(img)
            }
          }
        })
      },
      { 
        threshold: 0.1,
        rootMargin: '50px'  // 提前 50px 开始加载
      }
    )
  }

  /**
   * 为图片元素添加懒加载属性
   * @param img 图片元素
   * @param src 图片源地址
   */
  private applyLazyLoading(img: HTMLImageElement, src: string): void {
    // 使用原生浏览器懒加载
    img.loading = 'lazy'
    img.decoding = 'async'
    
    // 如果需要 Intersection Observer 懒加载，使用 data-src
    // img.dataset.src = src
    // this.imageObserver?.observe(img)
    
    // 直接设置 src（配合 loading="lazy"）
    img.src = src
  }

  // ==================== 存储状态 ====================

  private updateStorageStatusCached(): void {
    const now = Date.now()

    if (this.storageInfoCache && now - this.storageInfoCacheTime < this.CACHE_DURATION) {
      this.renderStorageStatus(this.storageInfoCache)
      return
    }

    this.requestIdleCallback(
      () => {
        // 优先使用 app.getStorageInfo，否则自行计算
        const appStorageInfo = (this.app as any).getStorageInfo?.()
        if (appStorageInfo) {
          this.storageInfoCache = appStorageInfo
        } else {
          // 自行计算存储信息
          const historyStr = localStorage.getItem('ai_image_history') || '[]'
          const historySizeKB = (historyStr.length / 1024).toFixed(2)
          const historyCount = (this.app.history || []).length

          // 计算所有 localStorage 的大小
          let totalSize = 0
          for (const key in localStorage) {
            if (Object.prototype.hasOwnProperty.call(localStorage, key)) {
              totalSize += localStorage[key].length
            }
          }
          const totalSizeKB = (totalSize / 1024).toFixed(2)

          // 检查 R2 存储是否可用
          const r2Storage = getR2StorageService()
          const r2Enabled = r2Storage?.isAvailable?.() ?? false

          this.storageInfoCache = {
            historySize: historySizeKB,
            historyCount: historyCount,
            totalSize: totalSizeKB,
            estimatedLimit: 5120, // localStorage 通常限制为 5MB
            r2Enabled: r2Enabled
          }
        }
        this.storageInfoCacheTime = Date.now()
        this.renderStorageStatus(this.storageInfoCache!)
      },
      { timeout: 1000 }
    )
  }

  private renderStorageStatus(storageInfo: StorageInfo): void {
    const clearButton = this.getElement('clearHistory')
    if (!clearButton) return

    let statusElement = this.getElement('storageStatus')
    if (!statusElement) {
      statusElement = document.createElement('div')
      statusElement.id = 'storageStatus'
      statusElement.className = 'text-xs text-white opacity-70 mb-2'
      clearButton.parentElement?.insertBefore(statusElement, clearButton)
    }

    const usagePercent = ((parseFloat(storageInfo.totalSize) / storageInfo.estimatedLimit) * 100).toFixed(1)
    const statusText = storageInfo.r2Enabled
      ? this.t('history.storage.cloudModeTitle')
      : this.t('history.storage.localModeTitle')

    const migrateableCount = (this.app.history || []).filter(
      (item: HistoryItem) =>
        !item.r2Storage && !item.uploading && item.urls && item.urls.some((url) => url.startsWith('data:'))
    ).length

    statusElement.innerHTML = this.buildStorageStatusHTML(storageInfo, usagePercent, statusText, migrateableCount)
  }

  private buildStorageStatusHTML(
    storageInfo: StorageInfo,
    usagePercent: string,
    statusText: string,
    migrateableCount: number
  ): string {
    const isElectron = !!(window as any).electronAPI?.isElectron
    const usagePercentNum = parseFloat(usagePercent)

    return `
      <!-- 主状态栏 -->
      <div class="bg-gradient-to-r ${
        storageInfo.r2Enabled ? 'from-blue-600/20 to-purple-600/20' : 'from-gray-600/20 to-gray-700/20'
      } rounded-lg p-3 mb-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span class="text-lg">${storageInfo.r2Enabled ? '🔐' : '💾'}</span>
            <div>
              <span class="text-white font-medium">${statusText}</span>
              <span class="ml-3 text-xs opacity-70">
                ${this.t('history.labels.recordsCount', { count: storageInfo.historyCount })} | ${storageInfo.historySize} KB
              </span>
            </div>
          </div>
          <div class="text-right">
            <span class="text-xs ${usagePercentNum > 80 ? 'text-orange-400' : 'text-gray-300'}">
              ${this.t('history.labels.localUsage', { percent: usagePercent })}
            </span>
          </div>
        </div>
      </div>

      <!-- 功能说明卡片 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        ${
          storageInfo.r2Enabled
            ? `
            <!-- 隐私保护 -->
            <div class="bg-blue-500/10 rounded-lg p-2.5 border border-blue-400/20">
              <div class="flex items-start space-x-2">
                <i class="fas fa-shield-alt text-blue-400 mt-0.5"></i>
                <div>
                  <span class="text-blue-300 font-medium text-xs">${this.t('history.labels.privacyProtection')}</span>
                  <p class="text-blue-200 text-xs opacity-90 mt-0.5">${this.t('history.labels.privacyProtectionDesc')}</p>
                </div>
              </div>
            </div>

            <!-- 智能存储 -->
            <div class="bg-green-500/10 rounded-lg p-2.5 border border-green-400/20">
              <div class="flex items-start space-x-2">
                <i class="fas fa-cloud text-green-400 mt-0.5"></i>
                <div>
                  <span class="text-green-300 font-medium text-xs">${this.t('history.labels.smartStorage')}</span>
                  <p class="text-green-200 text-xs opacity-90 mt-0.5">${this.t('history.labels.smartStorageDesc')}</p>
                </div>
              </div>
            </div>

            <!-- 同步管理 -->
            <div class="bg-yellow-500/10 rounded-lg p-2.5 border border-yellow-400/20">
              <div class="flex items-start space-x-2">
                <i class="fas fa-sync-alt text-yellow-400 mt-0.5"></i>
                <div>
                  <span class="text-yellow-300 font-medium text-xs">${this.t('history.labels.syncManagement')}</span>
                  <p class="text-yellow-200 text-xs opacity-90 mt-0.5">${this.t('history.labels.syncManagementDesc')}</p>
                </div>
              </div>
            </div>

            <!-- 有效期限 -->
            <div class="bg-gray-500/10 rounded-lg p-2.5 border border-gray-400/20">
              <div class="flex items-start space-x-2">
                <i class="fas fa-clock text-gray-400 mt-0.5"></i>
                <div>
                  <span class="text-gray-300 font-medium text-xs">${this.t('history.labels.expirationPeriod')}</span>
                  <p class="text-gray-200 text-xs opacity-90 mt-0.5">${this.t('history.labels.expirationPeriodDesc')}</p>
                </div>
              </div>
            </div>
          `
            : `
            <!-- 本地存储警告 -->
            <div class="bg-yellow-500/10 rounded-lg p-2.5 border border-yellow-400/20 col-span-2">
              <div class="flex items-start space-x-2">
                <i class="fas fa-exclamation-triangle text-yellow-400 mt-0.5"></i>
                <div>
                  <span class="text-yellow-300 font-medium text-xs">${this.t('history.labels.localStorageMode')}</span>
                  <p class="text-yellow-200 text-xs opacity-90 mt-0.5">${this.t('history.labels.localStorageModeDesc')}</p>
                </div>
              </div>
            </div>
            ${
              usagePercentNum > 50
                ? `
              <!-- 建议配置云端存储 -->
              <div class="bg-orange-500/10 rounded-lg p-2.5 border border-orange-400/20 col-span-2">
                <div class="flex items-start space-x-2">
                  <i class="fas fa-info-circle text-orange-400 mt-0.5"></i>
                  <div>
                    <span class="text-orange-300 font-medium text-xs">${this.t('history.labels.configureCloudStorage')}</span>
                    <p class="text-orange-200 text-xs opacity-90 mt-0.5">${this.t('history.labels.configureCloudStorageDesc')}</p>
                  </div>
                </div>
              </div>
            `
                : ''
            }
          `
        }
      </div>

      ${
        migrateableCount > 0 && storageInfo.r2Enabled
          ? `
          <div class="text-center mb-2">
            <button onclick="window.historyPageTS?.migrateAllToCloud()"
                    class="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white text-xs px-4 py-2 rounded-lg transition-all shadow-lg transform hover:scale-105">
              <i class="fas fa-cloud-upload-alt mr-1.5"></i>
              ${this.t('history.labels.migrateAllToCloud', { count: migrateableCount })}
            </button>
          </div>
        `
          : ''
      }

      ${
        isElectron
          ? `
          <!-- 清理缓存按钮（仅 Electron 模式显示） -->
          <div class="text-center border-t border-gray-600/30 pt-3 mt-2">
            <button onclick="window.historyPageTS?.clearWebCache()"
                    id="clearWebCacheBtn"
                    class="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white text-xs px-4 py-2 rounded-lg transition-all shadow-lg transform hover:scale-105">
              <i class="fas fa-broom mr-1.5"></i>
              ${this.t('history.labels.clearWebCache')}
            </button>
            <p class="text-gray-400 text-xs mt-1 opacity-70">
              ${this.t('history.labels.clearWebCacheDesc')}
            </p>
          </div>
        `
          : ''
      }
    `
  }

  updateStorageStatus(): void {
    this.storageInfoCache = null
    this.updateStorageStatusCached()
  }

  // ==================== 下载操作 ====================

  async downloadMultipleImages(urls: string[], prompt: string): Promise<void> {
    // 过滤掉无效 URL
    const validUrls = filterValidImageUrls(urls)
    if (validUrls.length === 0) {
      this.showToast(this.t('history.messages.uploading') || '图片正在上传中，请稍候', 'warning')
      return
    }
    
    try {
      const promptPrefix = prompt.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 20)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      const zipFilename = `${promptPrefix}_${timestamp}.zip`

      this.showToast(this.t('history.messages.downloadStarting'), 'info')

      const api = this.getApi()
      const result = await api?.downloadImagesAsZip?.(validUrls, zipFilename, (completed: number, total: number) => {
        this.showToast(this.t('history.messages.downloading', { completed, total }), 'info')
      }, api?.model)

      this.showToast(result?.message || this.t('history.messages.downloadComplete'), 'success')
    } catch (error: any) {
      this.showToast(error.message, 'error')

      if (error.message.includes('右键图片选择')) {
        this.showDownloadHelpDialog(urls)
      }
    }
  }

  private showDownloadHelpDialog(urls: string[]): void {
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/50 z-[50000] flex items-center justify-center p-4'
    modal.innerHTML = `
      <div class="bg-white rounded-xl p-6 w-full max-w-md mx-4">
        <h3 class="text-xl font-bold mb-4 text-gray-800">
          <i class="fas fa-question-circle text-blue-500 mr-2"></i>
          ${this.t('history.downloadHelp.title')}
        </h3>
        <div class="space-y-3 text-gray-600 text-sm">
          <p><strong>${this.t('history.downloadHelp.message')}</strong></p>
          <p>${this.t('history.downloadHelp.stepsTitle')}</p>
          <ol class="list-decimal list-inside space-y-1 ml-2">
            <li>${this.t('history.downloadHelp.step1')}</li>
            <li>${this.t('history.downloadHelp.step2')}</li>
            <li>${this.t('history.downloadHelp.step3')}</li>
            <li>${this.t('history.downloadHelp.step4')}</li>
          </ol>
        </div>
        <div class="flex space-x-3 mt-6">
          <button class="view-images-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-md transition-colors">
            <i class="fas fa-eye mr-2"></i>${this.t('history.downloadHelp.viewImages')}
          </button>
          <button class="close-modal-btn bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-md transition-colors">
            ${this.t('history.downloadHelp.understood')}
          </button>
        </div>
      </div>
    `

    const viewBtn = modal.querySelector('.view-images-btn')
    viewBtn?.addEventListener('click', () => {
      this.viewImage(urls, 0)
      modal.remove()
    })

    const closeBtn = modal.querySelector('.close-modal-btn')
    closeBtn?.addEventListener('click', () => modal.remove())

    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove()
    })

    document.body.appendChild(modal)
  }

  // ==================== 网络受限操作 ====================

  showNetworkRestrictedActions(urls: string[], prompt: string): void {
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/70 z-[50000] flex items-center justify-center p-4'

    modal.innerHTML = `
      <div class="bg-white rounded-xl w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
        <div class="bg-orange-50 border-b border-orange-200 px-6 py-4 rounded-t-xl">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="bg-orange-100 rounded-full p-2">
                <i class="fas fa-exclamation-triangle text-orange-600 text-xl"></i>
              </div>
              <div>
                <h3 class="text-lg font-bold text-orange-800">${this.t('history.networkRestricted.title')}</h3>
                <p class="text-sm text-orange-600">${prompt}</p>
              </div>
            </div>
            <button class="network-actions-close-btn text-orange-400 hover:text-orange-600 transition-colors">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
        </div>

        <div class="p-6 space-y-4">
          <div class="bg-blue-50 border-l-4 border-blue-500 p-4 rounded">
            <div class="flex items-center">
              <i class="fas fa-info-circle text-blue-500 mr-2"></i>
              <span class="font-semibold text-blue-800">${this.t('history.networkRestricted.explanationTitle')}</span>
            </div>
            <p class="text-blue-700 text-sm mt-1">
              ${this.t('history.networkRestricted.description')}
              ${this.t('history.networkRestricted.instruction')}
            </p>
          </div>

          <div>
            <h4 class="font-semibold text-gray-800 mb-3">${this.t('history.networkRestricted.imageAddresses', { count: urls.length })}</h4>
            <div class="space-y-3 max-h-64 overflow-y-auto">
              ${urls
                .map(
                  (url, index) => `
                <div class="border rounded-lg p-3 bg-gray-50">
                  <div class="flex items-center justify-between mb-2">
                    <span class="text-sm font-medium text-gray-800">${this.t('history.networkRestricted.imageLabel', { index: index + 1 })}</span>
                    <div class="flex space-x-2">
                      <button class="copy-single-url-btn text-xs bg-blue-500 hover:bg-blue-600 text-white px-3 py-1 rounded" data-url="${url}">
                        <i class="fas fa-copy mr-1"></i>${this.t('history.networkRestricted.copy')}
                      </button>
                      <button class="open-single-url-btn text-xs bg-purple-500 hover:bg-purple-600 text-white px-3 py-1 rounded" data-url="${url}">
                        <i class="fas fa-external-link-alt mr-1"></i>${this.t('history.networkRestricted.open')}
                      </button>
                    </div>
                  </div>
                  <div class="text-xs font-mono bg-white p-2 rounded border break-all">${url}</div>
                </div>
              `
                )
                .join('')}
            </div>
          </div>

          <div class="bg-yellow-50 rounded-lg p-4">
            <h5 class="font-semibold text-yellow-800 mb-2">
              <i class="fas fa-lightbulb mr-2"></i>${this.t('history.networkRestricted.solutionTitle')}
            </h5>
            <ul class="text-yellow-700 text-sm space-y-1">
              <li>• ${this.t('history.networkRestricted.solutionItem1')}</li>
              <li>• ${this.t('history.networkRestricted.solutionItem2')}</li>
              <li>• ${this.t('history.networkRestricted.solutionItem3')}</li>
              <li>• ${this.t('history.networkRestricted.solutionItem4')}</li>
            </ul>
          </div>

          <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
            <button class="copy-all-network-urls-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-copy mr-2"></i>${this.t('history.networkRestricted.copyAll')}
            </button>
            <button class="retry-network-access-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-redo mr-2"></i>${this.t('history.networkRestricted.retry')}
            </button>
            <button class="network-actions-close-btn bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-times mr-2"></i>${this.t('history.networkRestricted.close')}
            </button>
          </div>
        </div>
      </div>
    `

    this.bindNetworkActionsModalEvents(modal, urls, prompt)
    document.body.appendChild(modal)
  }

  private bindNetworkActionsModalEvents(modal: HTMLElement, urls: string[], prompt: string): void {
    // Close buttons
    const closeButtons = modal.querySelectorAll('.network-actions-close-btn')
    closeButtons.forEach((btn) => {
      btn.addEventListener('click', () => modal.remove())
    })

    // Background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove()
    })

    // ESC key
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        modal.remove()
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)

    // Copy single URL
    modal.querySelectorAll('.copy-single-url-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url || ''
        navigator.clipboard
          .writeText(url)
          .then(() => this.showToast('图片地址已复制', 'success'))
          .catch(() => this.showToast('复制失败', 'error'))
      })
    })

    // Open single URL
    modal.querySelectorAll('.open-single-url-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url || ''
        window.open(url, '_blank')
      })
    })

    // Copy all URLs
    const copyAllBtn = modal.querySelector('.copy-all-network-urls-btn')
    copyAllBtn?.addEventListener('click', () => {
      const urlsText = urls.map((url, index) => `图片${index + 1}: ${url}`).join('\n\n')
      const fullText = `${prompt}\n生成时间: ${new Date().toLocaleString()}\n\n${urlsText}`
      navigator.clipboard
        .writeText(fullText)
        .then(() => this.showToast('所有图片地址已复制', 'success'))
        .catch(() => this.showToast('复制失败', 'error'))
    })

    // Retry access
    const retryBtn = modal.querySelector('.retry-network-access-btn')
    retryBtn?.addEventListener('click', async () => {
      this.showToast('正在重新检测网络访问...', 'info')

      try {
        const api = this.getApi()
        const accessibilityPromises = urls.map((url) => api?.checkUrlAccessibility?.(url))
        const results = await Promise.allSettled(accessibilityPromises)

        const accessibleUrls = results
          .map((result, index) => (result.status === 'fulfilled' ? urls[index] : null))
          .filter((url): url is string => url !== null)

        if (accessibleUrls.length > 0) {
          this.showToast(`检测到 ${accessibleUrls.length}/${urls.length} 张图片现在可以访问`, 'success')
          if (accessibleUrls.length === urls.length) {
            modal.remove()
            this.downloadMultipleImages(accessibleUrls, prompt)
          }
        } else {
          this.showToast('仍然无法访问这些图片地址', 'warning')
        }
      } catch (error) {
        this.showToast('网络检测失败', 'error')
      }
    })
  }

  // ==================== 删除和迁移 ====================

  async deleteHistoryItem(id: number): Promise<void> {
    const historyManager = getHistoryManager()
    const itemToDelete = historyManager.getById(id)

    if (!itemToDelete) {
      this.showToast(this.t('history.messages.notFound') || '记录不存在', 'error')
      return
    }

    try {
      // 删除云端图片（失败不影响本地删除）
      const r2Storage = getR2StorageService()
      if (itemToDelete.r2Storage && r2Storage?.isAvailable?.()) {
        try {
          const r2Keys: string[] = []
          itemToDelete.urls?.forEach((url: string) => {
            if (r2Storage.isR2Url?.(url)) {
              const key = r2Storage.extractR2Key?.(url)
              if (key) r2Keys.push(key)
            }
          })

          if (r2Keys.length > 0) {
            console.log(`删除云端图片: ${r2Keys.length} 个文件`)
            await r2Storage.batchDelete?.(r2Keys)
          }
        } catch (error) {
          console.error('删除云端图片失败（继续删除本地记录）:', error)
        }
      }

      // 使用 HistoryManager 删除（会自动同步到文件）
      const deleted = await historyManager.delete(id)
      
      if (deleted) {
        // 同步到 app.history
        this.app.history = historyManager.getAll()
        this.loadPanel()
        this.showToast(this.t('history.messages.deleted'), 'success')
      } else {
        this.showToast(this.t('history.messages.deleteFailed') || '删除失败', 'error')
      }
    } catch (error) {
      console.error('删除历史记录失败:', error)
      this.showToast(this.t('history.messages.deleteFailed') || '删除失败，请重试', 'error')
    }
  }

  async migrateToCloud(id: number): Promise<void> {
    const historyItem = (this.app.history || []).find((item: HistoryItem) => item.id === id)
    if (!historyItem) {
      this.showToast(this.t('history.messages.notFound'), 'error')
      return
    }

    const r2Storage = getR2StorageService()
    if (!r2Storage?.isAvailable?.()) {
      this.showToast(this.t('history.messages.cloudUnavailable'), 'error')
      return
    }

    this.showToast(this.t('history.messages.migrating'), 'info')

    try {
      const base64Urls = historyItem.urls.filter((url: string) => url.startsWith('data:'))
      if (base64Urls.length === 0) {
        this.showToast('没有需要迁移的本地图片', 'info')
        return
      }

      const r2Urls = await r2Storage.batchProcess?.(base64Urls)

      const updatedUrls = historyItem.urls.map((url: string) => {
        const index = base64Urls.indexOf(url)
        if (index !== -1 && r2Urls?.[index]) {
          return r2Urls[index]
        }
        return url
      })

      historyItem.urls = updatedUrls
      historyItem.r2Storage = true
      historyItem.uploading = false
      delete historyItem.originalUrls

      ;(this.app as any).saveHistoryWithoutBase64?.()
      this.loadPanel()
      this.showToast('已成功迁移到云端', 'success')
    } catch (error) {
      console.error('迁移到云端失败:', error)
      this.showToast('迁移失败，请重试', 'error')
    }
  }

  async migrateAllToCloud(): Promise<void> {
    const r2Storage = getR2StorageService()
    if (!r2Storage?.isAvailable?.()) {
      this.showToast('云存储服务不可用', 'error')
      return
    }

    const itemsToMigrate = (this.app.history || []).filter(
      (item: HistoryItem) =>
        !item.r2Storage && !item.uploading && item.urls && item.urls.some((url) => url.startsWith('data:'))
    )

    if (itemsToMigrate.length === 0) {
      this.showToast('没有需要迁移的历史记录', 'info')
      return
    }

    this.showToast(`开始迁移 ${itemsToMigrate.length} 条记录...`, 'info')

    let successCount = 0
    let failCount = 0

    for (const item of itemsToMigrate) {
      try {
        const base64Urls = item.urls.filter((url: string) => url.startsWith('data:'))
        const r2Urls = await r2Storage.batchProcess?.(base64Urls)

        const updatedUrls = item.urls.map((url: string) => {
          const index = base64Urls.indexOf(url)
          if (index !== -1 && r2Urls?.[index]) {
            return r2Urls[index]
          }
          return url
        })

        item.urls = updatedUrls
        item.r2Storage = true
        item.uploading = false
        delete item.originalUrls

        successCount++
      } catch (error) {
        console.error(`迁移记录 ${item.id} 失败:`, error)
        failCount++
      }
    }

    ;(this.app as any).saveHistoryWithoutBase64?.()
    this.loadPanel()

    if (successCount > 0) {
      this.showToast(
        `迁移完成：成功 ${successCount} 条${failCount > 0 ? `，失败 ${failCount} 条` : ''}`,
        failCount > 0 ? 'warning' : 'success'
      )
    } else {
      this.showToast('迁移失败，请重试', 'error')
    }
  }

  // ==================== 清空历史 ====================

  async clearHistory(): Promise<void> {
    if (!confirm('确定要清空所有历史记录吗？这将同时删除云端保存的图片。')) {
      return
    }

    const r2Storage = getR2StorageService()
    if (r2Storage?.isAvailable?.()) {
      try {
        const allR2Keys: string[] = []
        ;(this.app.history || []).forEach((item: HistoryItem) => {
          if (item.r2Storage && item.urls) {
            item.urls.forEach((url) => {
              if (r2Storage.isR2Url?.(url)) {
                const key = r2Storage.extractR2Key?.(url)
                if (key) allR2Keys.push(key)
              }
            })
          }
        })

        if (allR2Keys.length > 0) {
          this.showToast('正在清理云端图片...', 'info')
          console.log(`清理云端图片: ${allR2Keys.length} 个文件`)
          await r2Storage.batchDelete?.(allR2Keys)
        }
      } catch (error) {
        console.error('清理云端图片失败:', error)
      }
    }

    this.app.history = []
    ;(this.app as any).saveHistory?.()
    this.loadPanel()
    this.showToast('历史记录已清空，云端图片已同步删除', 'success')
  }

  // ==================== 清理缓存 ====================

  async clearWebCache(): Promise<void> {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.isElectron) {
      this.showToast('此功能仅在桌面应用中可用', 'warning')
      return
    }

    const confirmMsg = this.t('history.messages.confirmClearCache')
    if (!confirm(confirmMsg)) return

    const btn = this.getElement<HTMLButtonElement>('clearWebCacheBtn')
    if (btn) {
      btn.disabled = true
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>清理中...'
    }

    try {
      const result = await electronAPI.clearWebCache?.()

      if (result?.success) {
        this.showToast(this.t('history.messages.cacheCleared'), 'success')
        setTimeout(() => window.location.reload(), 1500)
      } else {
        throw new Error(result?.error || '清理失败')
      }
    } catch (error) {
      console.error('清理网页缓存失败:', error)
      this.showToast(this.t('history.messages.cacheClearFailed'), 'error')

      if (btn) {
        btn.disabled = false
        btn.innerHTML = `<i class="fas fa-broom mr-1.5"></i>${this.t('history.labels.clearWebCache')}`
      }
    }
  }

  // ==================== 页面生命周期 ====================

  onActivate(): void {
    console.log('历史记录页面已激活')
    // 使用较短的超时，因为骨架屏会立即显示
    this.requestIdleCallback(() => this.loadPanel(), { timeout: 50 })
  }

  onDeactivate(): void {
    console.log('历史记录页面已失活')
    // 清理加载更多 Observer
    if (this.loadMoreObserver) {
      this.loadMoreObserver.disconnect()
      this.loadMoreObserver = null
    }
    // 清理图片懒加载 Observer
    if (this.imageObserver) {
      this.imageObserver.disconnect()
      this.imageObserver = null
    }
    // 清理虚拟滚动
    if (this.virtualScroller) {
      this.virtualScroller.destroy()
      this.virtualScroller = null
    }
    // 重置分页状态
    this.currentPage = 0
    this.hasMoreItems = true
  }

  onLanguageChange(lang: string): void {
    console.log('HistoryPage: 语言切换为', lang)
    this.loadPanel()
  }
}

// Factory functions
let historyPageInstance: HistoryPage | null = null

export function createHistoryPage(app: AppInterface): HistoryPage {
  historyPageInstance = new HistoryPage(app)
  // 注册到全局对象，供 onclick 调用
  ;(window as any).historyPageTS = historyPageInstance
  return historyPageInstance
}

export function getHistoryPage(): HistoryPage | null {
  return historyPageInstance
}

export default HistoryPage
