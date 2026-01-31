// src/renderer/src/pages/HistoryPage.ts
/**
 * 历史记录页面模块 (TypeScript)
 * @description 管理生成历史记录的显示和操作
 */

import { BasePage, type AppInterface } from './BasePage'

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

export class HistoryPage extends BasePage {
  private storageInfoCache: StorageInfo | null = null
  private storageInfoCacheTime: number = 0
  private readonly CACHE_DURATION: number = 5000
  private readonly CHUNK_SIZE: number = 10
  private historyItemsMap: Map<number, HistoryItem> = new Map()

  constructor(app: AppInterface) {
    super(app)
    this.init()
  }

  init(): void {
    this.bindEvents()
    this.bindDelegatedEvents()
    this.isInitialized = true
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
      const button = target.closest('button[data-action]') as HTMLButtonElement | null
      if (!button) return

      const action = button.dataset.action
      const itemId = parseInt(button.dataset.itemId || '0', 10)
      const item = this.historyItemsMap.get(itemId)

      if (!item) {
        console.warn('历史记录项未找到:', itemId)
        return
      }

      switch (action) {
        case 'view':
          this.viewImage(item.urls, 0)
          break
        case 'network-restricted':
          this.showNetworkRestrictedActions(item.urls, item.prompt)
          break
        case 'download-single':
          this.downloadImage(item.urls[0])
          break
        case 'download-multiple':
          this.downloadMultipleImages(item.urls, item.prompt)
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
    const imageViewer = (window as any).imageViewerTS
    if (imageViewer?.view) {
      imageViewer.view(urls, index)
    } else if ((this.app as any).viewImage) {
      ;(this.app as any).viewImage(urls, index)
    }
  }

  private downloadImage(url: string): void {
    if ((this.app as any).downloadImage) {
      ;(this.app as any).downloadImage(url)
    } else {
      // Fallback: open in new tab
      window.open(url, '_blank')
    }
  }

  // ==================== 面板加载 ====================

  loadPanel(): void {
    const historyList = this.getElement('historyList')
    const history = this.app.history || []

    // 清空历史项目映射
    this.historyItemsMap.clear()

    // 构建历史项目映射
    history.forEach((item: HistoryItem) => {
      this.historyItemsMap.set(item.id, item)
    })

    // 更新存储状态
    this.updateStorageStatusCached()

    if (history.length === 0) {
      const emptyText = this.t('history.labels.empty')
      if (historyList) {
        historyList.innerHTML = `
          <div class="text-center text-white opacity-50 py-8">
            <i class="fas fa-history text-4xl mb-4"></i>
            <p>${emptyText}</p>
          </div>
        `
      }
      return
    }

    // 清空列表
    if (historyList) {
      historyList.innerHTML = ''
      this.renderHistoryChunked(history, historyList, 0)
    }
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
    const hasPlaceholder = item.urls && item.urls.some((url) => url.startsWith('pending:'))

    historyCard.className = `bg-white bg-opacity-5 rounded-lg p-4 flex items-center space-x-4 ${
      isNetworkRestricted ? 'border border-orange-500 border-opacity-30' : ''
    } ${isComparison ? 'border border-purple-500 border-opacity-30' : ''}`

    const typeIconMap: Record<string, string> = {
      generate: 'fa-magic',
      edit: 'fa-edit',
      batch: 'fa-layer-group',
      compare: 'fa-balance-scale',
      network_restricted: 'fa-exclamation-triangle'
    }
    const typeIcon = typeIconMap[item.type] || 'fa-image'

    const date = new Date(item.timestamp).toLocaleString('zh-CN')
    const imageCountText = item.urls.length > 1 ? ` (${item.urls.length}张)` : ''

    // 存储状态标识
    const storageBadge = isUploading || hasPlaceholder
      ? `<span class="inline-flex items-center text-xs bg-yellow-500 bg-opacity-20 text-yellow-200 px-2 py-0.5 rounded-full whitespace-nowrap ml-1">
          <i class="fas fa-cloud-upload-alt fa-spin mr-1"></i>${this.t('history.storage.uploading')}
        </span>`
      : isCloudStored
      ? `<span class="inline-flex items-center text-xs bg-green-500 bg-opacity-20 text-green-200 px-2 py-0.5 rounded-full whitespace-nowrap ml-1">
          <i class="fas fa-cloud-check mr-1"></i>${this.t('history.storage.cloud')}
        </span>`
      : `<span class="inline-flex items-center text-xs bg-gray-500 bg-opacity-20 text-gray-300 px-2 py-0.5 rounded-full whitespace-nowrap ml-1">
          <i class="fas fa-hdd mr-1"></i>${this.t('history.storage.local')}
        </span>`

    // 特殊项目标识
    let specialBadge = ''
    if (isNetworkRestricted) {
      specialBadge = `<span class="inline-flex items-center text-xs bg-orange-500 bg-opacity-20 text-orange-200 px-2.5 py-1 rounded-full whitespace-nowrap">
        <i class="fas fa-wifi mr-1"></i>${this.t('history.types.networkRestricted')}
      </span>`
    } else if (isComparison && item.comparison?.winnerModelName) {
      specialBadge = `<span class="inline-flex items-center text-xs bg-purple-500 bg-opacity-20 text-purple-200 px-2.5 py-1 rounded-full whitespace-nowrap">
        <i class="fas fa-trophy mr-1"></i>${this.t('history.types.winner', { model: item.comparison.winnerModelName })}
      </span>`
    } else if (isComparison) {
      specialBadge = `<span class="inline-flex items-center text-xs bg-gray-500 bg-opacity-20 text-gray-300 px-2.5 py-1 rounded-full whitespace-nowrap">
        <i class="fas fa-balance-scale mr-1"></i>${this.t('history.types.pending')}
      </span>`
    }

    // 对比详情
    const comparisonDetails =
      isComparison && item.comparison
        ? `<div class="text-xs text-white opacity-70 mt-1">
            <span>${item.comparison.leftModelName} vs ${item.comparison.rightModelName}</span>
            ${item.referenceImages && item.referenceImages.length > 0 ? ` | ${item.referenceImages.length}张参考图` : ''}
          </div>`
        : ''

    historyCard.innerHTML = `
      <div class="flex-shrink-0">
        <i class="fas ${typeIcon} text-2xl ${
          isNetworkRestricted ? 'text-orange-400' : isComparison ? 'text-purple-400' : 'text-white opacity-70'
        }"></i>
      </div>
      <div class="flex-1">
        <div class="flex items-start flex-wrap gap-2">
          <h4 class="text-white font-medium ${isComparison ? 'mr-auto' : ''}">${item.prompt}${imageCountText}</h4>
          ${storageBadge}
          ${specialBadge}
        </div>
        <p class="text-white opacity-50 text-sm">${date}</p>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          ${item.model ? `<span class="text-white opacity-70"><i class="fas fa-robot mr-1"></i>模型: ${item.model}</span>` : ''}
          ${item.ratio && item.ratio !== '网络受限' ? `<span class="text-white opacity-70"><i class="fas fa-expand mr-1"></i>尺寸: ${item.ratio}</span>` : ''}
        </div>
        ${isNetworkRestricted ? '<p class="text-orange-300 text-xs mt-1">✓ 生成成功，但图片可能需要特殊网络环境访问</p>' : ''}
        ${comparisonDetails}
      </div>
      <div class="flex space-x-2">
        ${
          item.urls.length > 0 && !hasPlaceholder
            ? `
            <button data-action="view" data-item-id="${item.id}" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="查看图片">
              <i class="fas fa-eye"></i>
            </button>
            ${
              isNetworkRestricted
                ? `<button data-action="network-restricted" data-item-id="${item.id}" class="bg-orange-500 bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all" title="网络受限选项">
                    <i class="fas fa-link"></i>
                  </button>`
                : item.urls.length === 1
                ? `<button data-action="download-single" data-item-id="${item.id}" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="下载图片">
                    <i class="fas fa-download"></i>
                  </button>`
                : `<button data-action="download-multiple" data-item-id="${item.id}" class="bg-white bg-opacity-20 hover:bg-opacity-30 text-white p-2 rounded-lg transition-all" title="批量下载">
                    <i class="fas fa-file-archive"></i>
                  </button>`
            }`
            : hasPlaceholder
            ? `<button disabled class="bg-gray-500 bg-opacity-20 text-gray-400 p-2 rounded-lg cursor-not-allowed" title="图片上传中，请稍候">
                <i class="fas fa-hourglass-half"></i>
              </button>`
            : ''
        }
        ${
          !isCloudStored && !hasPlaceholder && item.urls.some((url) => url.startsWith('data:'))
            ? `<button data-action="migrate" data-item-id="${item.id}" class="bg-blue-500 bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all" title="迁移到云端">
                <i class="fas fa-cloud-upload-alt"></i>
              </button>`
            : ''
        }
        <button data-action="delete" data-item-id="${item.id}" class="bg-red-500 bg-opacity-50 hover:bg-opacity-70 text-white p-2 rounded-lg transition-all" title="删除记录">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    `

    return historyCard
  }

  // ==================== 图片预加载 ====================

  private scheduleImagePreload(history: HistoryItem[]): void {
    const allUrls = history.flatMap((item) => item.urls || [])
    if (allUrls.length > 0) {
      this.requestIdleCallback(
        () => {
          this.getApi()?.preloadImages?.(allUrls)
        },
        { timeout: 3000 }
      )
    }
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
        this.storageInfoCache = (this.app as any).getStorageInfo?.() || {
          totalSize: '0',
          historySize: '0',
          historyCount: 0,
          estimatedLimit: 5000000,
          r2Enabled: false
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

    return `
      <div class="bg-gradient-to-r ${
        storageInfo.r2Enabled ? 'from-blue-600 to-purple-600' : 'from-gray-600 to-gray-700'
      } bg-opacity-20 rounded-lg p-3 mb-3">
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
            <span class="text-xs ${parseFloat(usagePercent) > 80 ? 'text-orange-400' : 'text-gray-300'}">
              ${this.t('history.labels.localUsage', { percent: usagePercent })}
            </span>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-2 mb-3">
        ${
          storageInfo.r2Enabled
            ? `
            <div class="bg-blue-500 bg-opacity-10 rounded-lg p-2 border border-blue-400 border-opacity-20">
              <span class="text-blue-300 text-xs"><i class="fas fa-shield-alt mr-1"></i>${this.t('history.labels.privacyProtection')}</span>
            </div>
            <div class="bg-green-500 bg-opacity-10 rounded-lg p-2 border border-green-400 border-opacity-20">
              <span class="text-green-300 text-xs"><i class="fas fa-cloud mr-1"></i>${this.t('history.labels.smartStorage')}</span>
            </div>
          `
            : `
            <div class="bg-yellow-500 bg-opacity-10 rounded-lg p-2 border border-yellow-400 border-opacity-20 col-span-2">
              <span class="text-yellow-300 text-xs"><i class="fas fa-exclamation-triangle mr-1"></i>${this.t('history.labels.localStorageMode')}</span>
            </div>
          `
        }
      </div>

      ${
        migrateableCount > 0 && storageInfo.r2Enabled
          ? `
          <div class="text-center mb-2">
            <button onclick="window.historyPageTS?.migrateAllToCloud()"
                    class="bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 text-white text-xs px-4 py-2 rounded-lg transition-all">
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
          <div class="text-center border-t border-gray-600 border-opacity-30 pt-3 mt-2">
            <button onclick="window.historyPageTS?.clearWebCache()"
                    id="clearWebCacheBtn"
                    class="bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white text-xs px-4 py-2 rounded-lg transition-all">
              <i class="fas fa-broom mr-1.5"></i>
              ${this.t('history.labels.clearWebCache')}
            </button>
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
    try {
      const promptPrefix = prompt.replace(/[^\w\u4e00-\u9fa5]/g, '').substring(0, 20)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19)
      const zipFilename = `${promptPrefix}_${timestamp}.zip`

      this.showToast(this.t('history.messages.downloadStarting'), 'info')

      const api = this.getApi()
      const result = await api?.downloadImagesAsZip?.(urls, zipFilename, (completed: number, total: number) => {
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
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 z-[50000] flex items-center justify-center p-4'
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
    modal.className = 'fixed inset-0 bg-black bg-opacity-70 z-[50000] flex items-center justify-center p-4'

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
    const itemToDelete = (this.app.history || []).find((item: HistoryItem) => item.id === id)

    if (itemToDelete) {
      const r2Storage = (window as any).r2Storage
      if (itemToDelete.r2Storage && r2Storage?.isAvailable?.()) {
        try {
          const r2Keys: string[] = []
          itemToDelete.urls.forEach((url: string) => {
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
          console.error('删除云端图片失败:', error)
        }
      }
    }

    this.app.history = (this.app.history || []).filter((item: HistoryItem) => item.id !== id)
    ;(this.app as any).saveHistory?.()
    this.loadPanel()
    this.showToast(this.t('history.messages.deleted'), 'success')
  }

  async migrateToCloud(id: number): Promise<void> {
    const historyItem = (this.app.history || []).find((item: HistoryItem) => item.id === id)
    if (!historyItem) {
      this.showToast(this.t('history.messages.notFound'), 'error')
      return
    }

    const r2Storage = (window as any).r2Storage
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
    const r2Storage = (window as any).r2Storage
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

    const r2Storage = (window as any).r2Storage
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
    this.requestIdleCallback(() => this.loadPanel(), { timeout: 500 })
  }

  onDeactivate(): void {
    console.log('历史记录页面已失活')
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
  return historyPageInstance
}

export function getHistoryPage(): HistoryPage | null {
  return historyPageInstance
}

export default HistoryPage
