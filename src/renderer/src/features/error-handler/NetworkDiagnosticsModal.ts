/**
 * NetworkDiagnosticsModal - 网络诊断模态框
 * 
 * 专门处理网络受限图片的诊断和显示。
 * 从 app.js showNetworkRestrictedDialog 提取。
 */

export interface NetworkRestrictedInfo {
  /** 无法访问的 URL 列表 */
  inaccessibleUrls: string[]
  /** 所有 URL 列表 */
  allUrls: string[]
  /** API 原始响应内容 */
  content: string
  /** 解决方案建议 */
  suggestions: string[]
}

export interface NetworkDiagnosticsConfig {
  /** 显示 toast 回调 */
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void
  /** 添加到历史记录回调 */
  addToHistory?: (type: string, prompt: string, urls: string[], ratio?: string | null) => void
  /** 标记 URL 为可访问回调 */
  markUrlAsAccessible?: (url: string) => void
  /** 获取当前 Tab */
  getCurrentTab?: () => string
  /** 获取当前提示词 */
  getPrompt?: () => string
}

/**
 * NetworkDiagnosticsModal 类
 */
export class NetworkDiagnosticsModal {
  private config: NetworkDiagnosticsConfig
  private activeModal: HTMLElement | null = null
  
  constructor(config: NetworkDiagnosticsConfig = {}) {
    this.config = config
  }
  
  /**
   * 初始化事件监听
   */
  init(): void {
    // 监听网络受限图片事件
    window.addEventListener('networkRestrictedImages', ((e: CustomEvent<NetworkRestrictedInfo>) => {
      this.show(e.detail)
    }) as EventListener)
  }
  
  /**
   * 显示网络受限诊断对话框
   */
  show(info: NetworkRestrictedInfo): void {
    // 关闭已存在的模态框
    this.hide()
    
    const { inaccessibleUrls, allUrls, content, suggestions } = info
    const accessibleUrls = allUrls.filter(url => !inaccessibleUrls.includes(url))
    
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/70 z-[60000] flex items-center justify-center p-4'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-labelledby', 'network-restricted-title')
    
    modal.innerHTML = this.generateModalHTML(info, accessibleUrls)
    
    // 绑定事件
    this.bindEvents(modal, info)
    
    document.body.appendChild(modal)
    this.activeModal = modal
    
    // 焦点管理
    setTimeout(() => {
      const closeBtn = modal.querySelector('.network-close-btn') as HTMLElement
      closeBtn?.focus()
    }, 100)
  }
  
  /**
   * 隐藏模态框
   */
  hide(): void {
    if (this.activeModal) {
      this.activeModal.remove()
      this.activeModal = null
    }
  }
  
  /**
   * 生成模态框 HTML
   */
  private generateModalHTML(info: NetworkRestrictedInfo, accessibleUrls: string[]): string {
    const { inaccessibleUrls, allUrls, content, suggestions } = info
    
    return `
      <div class="bg-white rounded-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <!-- 标题部分 -->
        <div class="bg-orange-50 border-b border-orange-200 px-6 py-4 rounded-t-xl">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="bg-orange-100 rounded-full p-2">
                <i class="fas fa-exclamation-triangle text-orange-600 text-xl" aria-hidden="true"></i>
              </div>
              <div>
                <h3 id="network-restricted-title" class="text-lg font-bold text-orange-800">图片生成成功，但网络访问受限</h3>
                <p class="text-sm text-orange-600">API已成功生成图片，但部分图片可能因网络环境无法正常显示</p>
              </div>
            </div>
            <button 
              class="network-close-btn text-orange-400 hover:text-orange-600 transition-colors" 
              title="关闭"
              aria-label="关闭对话框"
            >
              <i class="fas fa-times text-xl" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <!-- 内容部分 -->
        <div class="p-6 space-y-6">
          <!-- 状态说明 -->
          <div class="bg-green-50 border-l-4 border-green-500 p-4 rounded" role="status">
            <div class="flex items-center">
              <i class="fas fa-check-circle text-green-500 mr-2" aria-hidden="true"></i>
              <span class="font-semibold text-green-800">生成状态：成功</span>
            </div>
            <p class="text-green-700 text-sm mt-1">API已成功处理您的请求并生成了图片，问题可能出现在网络访问环节。</p>
          </div>

          <!-- 图片地址列表 -->
          <div>
            <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
              <i class="fas fa-link text-blue-500 mr-2" aria-hidden="true"></i>
              生成的图片地址 (${allUrls.length}张)
            </h4>
            <div class="space-y-3" role="list">
              ${allUrls.map((url, index) => this.generateUrlItemHTML(url, index, inaccessibleUrls)).join('')}
            </div>
          </div>

          <!-- 解决方案 -->
          ${this.generateSuggestionsHTML(suggestions)}

          <!-- 技术信息 -->
          ${this.generateTechnicalInfoHTML(content, accessibleUrls, inaccessibleUrls)}

          <!-- 操作按钮 -->
          <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
            <button class="copy-all-urls-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-copy mr-2" aria-hidden="true"></i>复制所有地址
            </button>
            <button class="save-to-history-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-save mr-2" aria-hidden="true"></i>保存到历史记录
            </button>
            <button class="network-close-btn-footer bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-times mr-2" aria-hidden="true"></i>关闭
            </button>
          </div>
        </div>
      </div>
    `
  }
  
  /**
   * 生成单个 URL 项 HTML
   */
  private generateUrlItemHTML(url: string, index: number, inaccessibleUrls: string[]): string {
    const isAccessible = !inaccessibleUrls.includes(url)
    
    return `
      <div class="border rounded-lg p-3 ${isAccessible ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}" role="listitem">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center space-x-2">
            <span class="text-sm font-medium">图片 ${index + 1}</span>
            <span class="text-xs px-2 py-1 rounded-full ${isAccessible ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
              ${isAccessible ? '可访问' : '网络受限'}
            </span>
          </div>
          <div class="flex space-x-2">
            <button class="copy-url-btn text-xs bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded" data-url="${this.escapeHtml(url)}">
              <i class="fas fa-copy mr-1" aria-hidden="true"></i>复制地址
            </button>
            <button class="open-url-btn text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded" data-url="${this.escapeHtml(url)}">
              <i class="fas fa-external-link-alt mr-1" aria-hidden="true"></i>新窗口打开
            </button>
            ${!isAccessible ? `
              <button class="mark-accessible-btn text-xs bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded" data-url="${this.escapeHtml(url)}">
                <i class="fas fa-check mr-1" aria-hidden="true"></i>标记可访问
              </button>
            ` : ''}
          </div>
        </div>
        <div class="text-xs font-mono bg-gray-100 p-2 rounded break-all select-all">
          ${this.escapeHtml(url)}
        </div>
      </div>
    `
  }
  
  /**
   * 生成解决方案 HTML
   */
  private generateSuggestionsHTML(suggestions: string[]): string {
    if (!suggestions || suggestions.length === 0) return ''
    
    return `
      <div>
        <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
          <i class="fas fa-lightbulb text-yellow-500 mr-2" aria-hidden="true"></i>
          解决方案
        </h4>
        <div class="bg-blue-50 rounded-lg p-4">
          <ul class="space-y-2">
            ${suggestions.map(suggestion => `
              <li class="flex items-start space-x-2">
                <i class="fas fa-arrow-right text-blue-600 mt-1 text-sm" aria-hidden="true"></i>
                <span class="text-gray-700">${this.escapeHtml(suggestion)}</span>
              </li>
            `).join('')}
          </ul>
        </div>
      </div>
    `
  }
  
  /**
   * 生成技术信息 HTML
   */
  private generateTechnicalInfoHTML(content: string, accessibleUrls: string[], inaccessibleUrls: string[]): string {
    return `
      <div>
        <div class="flex items-center justify-between mb-2">
          <h4 class="font-semibold text-gray-800 flex items-center">
            <i class="fas fa-info-circle text-gray-500 mr-2" aria-hidden="true"></i>
            技术详情
          </h4>
          <button class="toggle-technical-info text-xs text-blue-600 hover:text-blue-800 underline">
            展开/收起
          </button>
        </div>
        <div class="technical-info-content hidden bg-gray-100 rounded-lg p-4">
          <div class="space-y-3 text-sm">
            <div>
              <span class="font-medium text-gray-800">完整API响应内容:</span>
              <div class="bg-black rounded p-3 mt-2 overflow-x-auto max-h-48 overflow-y-auto">
                <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap">${this.escapeHtml(content)}</pre>
              </div>
            </div>
            <div>
              <span class="font-medium text-gray-800">网络检测结果:</span>
              <div class="mt-1 text-xs">
                <div class="text-green-700"><i class="fas fa-check mr-1" aria-hidden="true"></i>可访问URL: ${accessibleUrls.length}个</div>
                <div class="text-red-700"><i class="fas fa-times mr-1" aria-hidden="true"></i>受限URL: ${inaccessibleUrls.length}个</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `
  }
  
  /**
   * 绑定模态框事件
   */
  private bindEvents(modal: HTMLElement, info: NetworkRestrictedInfo): void {
    const showToast = this.config.showToast || ((msg: string) => console.log(msg))
    const { inaccessibleUrls, allUrls } = info
    
    // 关闭按钮
    modal.querySelectorAll('.network-close-btn, .network-close-btn-footer').forEach(btn => {
      btn.addEventListener('click', () => this.hide())
    })
    
    // 点击背景关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.hide()
      }
    })
    
    // ESC 键关闭
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.hide()
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)
    
    // 复制单个 URL
    modal.querySelectorAll('.copy-url-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url || ''
        navigator.clipboard.writeText(url).then(() => {
          showToast('图片地址已复制', 'success')
        }).catch(() => {
          showToast('复制失败', 'error')
        })
      })
    })
    
    // 新窗口打开 URL
    modal.querySelectorAll('.open-url-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url || ''
        window.open(url, '_blank')
      })
    })
    
    // 复制所有地址
    const copyAllBtn = modal.querySelector('.copy-all-urls-btn')
    if (copyAllBtn) {
      copyAllBtn.addEventListener('click', () => {
        const urlsText = allUrls.map((url, index) => `图片${index + 1}: ${url}`).join('\n\n')
        navigator.clipboard.writeText(urlsText).then(() => {
          showToast('所有图片地址已复制', 'success')
        }).catch(() => {
          showToast('复制失败', 'error')
        })
      })
    }
    
    // 技术详情展开/收起
    const toggleBtn = modal.querySelector('.toggle-technical-info')
    const techContent = modal.querySelector('.technical-info-content')
    if (toggleBtn && techContent) {
      toggleBtn.addEventListener('click', () => {
        techContent.classList.toggle('hidden')
      })
    }
    
    // 标记为可访问
    modal.querySelectorAll('.mark-accessible-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url || ''
        
        // 调用标记回调
        this.config.markUrlAsAccessible?.(url)
        
        // 从不可访问列表移除
        const index = inaccessibleUrls.indexOf(url)
        if (index > -1) {
          inaccessibleUrls.splice(index, 1)
          showToast('已标记为可访问，将记住此设置', 'success')
          
          // 如果没有受限 URL 了，关闭弹窗
          if (inaccessibleUrls.length === 0) {
            this.hide()
            showToast('所有图片都已标记为可访问！', 'success')
          } else {
            // 重新渲染
            this.hide()
            this.show({ ...info, inaccessibleUrls })
          }
        }
      })
    })
    
    // 保存到历史记录
    const saveBtn = modal.querySelector('.save-to-history-btn')
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const currentTab = this.config.getCurrentTab?.() || 'generate'
        let prompt = this.config.getPrompt?.() || '未知提示词'
        
        if (currentTab === 'batch') {
          prompt = '批量生成'
        }
        
        const historyType = inaccessibleUrls.length > 0 ? 'network_restricted' : 'generate'
        const historyRatio = inaccessibleUrls.length > 0 ? '网络受限' : null
        
        this.config.addToHistory?.(historyType, prompt, allUrls, historyRatio)
        showToast('已保存到历史记录', 'success')
        this.hide()
      })
    }
  }
  
  /**
   * HTML 转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
  
  /**
   * 销毁
   */
  destroy(): void {
    this.hide()
  }
}

// 单例实例
let networkDiagnosticsModalInstance: NetworkDiagnosticsModal | null = null

/**
 * 获取 NetworkDiagnosticsModal 单例
 */
export function getNetworkDiagnosticsModal(config?: NetworkDiagnosticsConfig): NetworkDiagnosticsModal {
  if (!networkDiagnosticsModalInstance) {
    networkDiagnosticsModalInstance = new NetworkDiagnosticsModal(config)
  }
  return networkDiagnosticsModalInstance
}

/**
 * 创建新的 NetworkDiagnosticsModal 实例 (仅用于测试)
 */
export function createNetworkDiagnosticsModal(config?: NetworkDiagnosticsConfig): NetworkDiagnosticsModal {
  networkDiagnosticsModalInstance = new NetworkDiagnosticsModal(config)
  return networkDiagnosticsModalInstance
}
