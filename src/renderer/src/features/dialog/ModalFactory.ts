// src/renderer/src/features/dialog/ModalFactory.ts
// 模态框工厂 - 集中管理模态框创建

export interface ModalAction {
  label: string
  icon?: string
  className?: string
  onClick: () => void
}

export interface ModalConfig {
  type: 'error' | 'warning' | 'info' | 'network-restricted' | 'success'
  title: string
  subtitle?: string
  content?: string
  actions?: ModalAction[]
  onClose?: () => void
}

export interface NetworkRestrictedConfig {
  inaccessibleUrls: string[]
  allUrls: string[]
  content: string
  suggestions: string[]
  showToast: (message: string, type: 'success' | 'error' | 'info') => void
  onSaveToHistory?: (urls: string[], prompt: string, type: string) => void
  markUrlAsAccessible?: (url: string) => void
  currentPrompt?: string
}

export class ModalFactory {
  private activeModals: Set<HTMLElement> = new Set()

  /**
   * 创建并显示基础模态框
   */
  create(config: ModalConfig): HTMLElement {
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/70 z-[60000] flex items-center justify-center p-4'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')

    const bgColors = {
      'error': 'bg-red-50 border-red-200',
      'warning': 'bg-yellow-50 border-yellow-200',
      'info': 'bg-blue-50 border-blue-200',
      'success': 'bg-green-50 border-green-200',
      'network-restricted': 'bg-orange-50 border-orange-200'
    }

    const iconColors = {
      'error': 'text-red-600',
      'warning': 'text-yellow-600',
      'info': 'text-blue-600',
      'success': 'text-green-600',
      'network-restricted': 'text-orange-600'
    }

    const icons = {
      'error': 'fa-exclamation-triangle',
      'warning': 'fa-exclamation-circle',
      'info': 'fa-info-circle',
      'success': 'fa-check-circle',
      'network-restricted': 'fa-exclamation-triangle'
    }

    modal.innerHTML = `
      <div class="bg-white rounded-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div class="${bgColors[config.type]} border-b px-6 py-4 rounded-t-xl">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="bg-white/50 rounded-full p-2">
                <i class="fas ${icons[config.type]} ${iconColors[config.type]} text-xl"></i>
              </div>
              <div>
                <h3 class="text-lg font-bold text-gray-800">${config.title}</h3>
                ${config.subtitle ? `<p class="text-sm text-gray-600">${config.subtitle}</p>` : ''}
              </div>
            </div>
            <button class="modal-close-btn text-gray-400 hover:text-gray-600 transition-colors" title="关闭">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
        </div>
        <div class="p-6">
          ${config.content || ''}
          ${config.actions && config.actions.length > 0 ? `
            <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200 mt-6">
              ${config.actions.map(action => `
                <button class="modal-action-btn ${action.className || 'bg-gray-500 hover:bg-gray-600'} text-white py-2 px-4 rounded-lg transition-colors flex-1" data-action="${action.label}">
                  ${action.icon ? `<i class="fas ${action.icon} mr-2"></i>` : ''}${action.label}
                </button>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `

    this.bindModalEvents(modal, config)
    document.body.appendChild(modal)
    this.activeModals.add(modal)

    return modal
  }

  /**
   * 创建网络受限提示对话框
   */
  createNetworkRestrictedModal(config: NetworkRestrictedConfig): HTMLElement {
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/70 z-[60000] flex items-center justify-center p-4'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')

    const { inaccessibleUrls, allUrls, content, suggestions } = config
    const accessibleUrls = allUrls.filter(url => !inaccessibleUrls.includes(url))

    modal.innerHTML = `
      <div class="bg-white rounded-xl w-full max-w-3xl mx-4 max-h-[90vh] overflow-y-auto">
        <!-- 标题部分 -->
        <div class="bg-orange-50 border-b border-orange-200 px-6 py-4 rounded-t-xl">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="bg-orange-100 rounded-full p-2">
                <i class="fas fa-exclamation-triangle text-orange-600 text-xl"></i>
              </div>
              <div>
                <h3 class="text-lg font-bold text-orange-800">图片生成成功，但网络访问受限</h3>
                <p class="text-sm text-orange-600">API已成功生成图片，但部分图片可能因网络环境无法正常显示</p>
              </div>
            </div>
            <button class="network-close-btn text-orange-400 hover:text-orange-600 transition-colors" title="关闭">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
        </div>

        <!-- 内容部分 -->
        <div class="p-6 space-y-6">
          <!-- 状态说明 -->
          <div class="bg-green-50 border-l-4 border-green-500 p-4 rounded">
            <div class="flex items-center">
              <i class="fas fa-check-circle text-green-500 mr-2"></i>
              <span class="font-semibold text-green-800">生成状态：成功</span>
            </div>
            <p class="text-green-700 text-sm mt-1">API已成功处理您的请求并生成了图片，问题可能出现在网络访问环节。</p>
          </div>

          <!-- 图片地址列表 -->
          <div>
            <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
              <i class="fas fa-link text-blue-500 mr-2"></i>
              生成的图片地址 (${allUrls.length}张)
            </h4>
            <div class="space-y-3">
              ${allUrls.map((url, index) => {
                const isAccessible = !inaccessibleUrls.includes(url)
                return `
                  <div class="border rounded-lg p-3 ${isAccessible ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}">
                    <div class="flex items-center justify-between mb-2">
                      <div class="flex items-center space-x-2">
                        <span class="text-sm font-medium">图片 ${index + 1}</span>
                        <span class="text-xs px-2 py-1 rounded-full ${isAccessible ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
                          ${isAccessible ? '可访问' : '网络受限'}
                        </span>
                      </div>
                      <div class="flex space-x-2">
                        <button class="copy-url-btn text-xs bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded" data-url="${url}">
                          <i class="fas fa-copy mr-1"></i>复制地址
                        </button>
                        <button class="open-url-btn text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded" data-url="${url}">
                          <i class="fas fa-external-link-alt mr-1"></i>新窗口打开
                        </button>
                        ${!isAccessible ? `
                          <button class="mark-accessible-btn text-xs bg-green-500 hover:bg-green-600 text-white px-2 py-1 rounded" data-url="${url}">
                            <i class="fas fa-check mr-1"></i>标记可访问
                          </button>
                        ` : ''}
                      </div>
                    </div>
                    <div class="text-xs font-mono bg-gray-100 p-2 rounded break-all">
                      ${url}
                    </div>
                  </div>
                `
              }).join('')}
            </div>
          </div>

          <!-- 解决方案 -->
          <div>
            <h4 class="font-semibold text-gray-800 mb-3 flex items-center">
              <i class="fas fa-lightbulb text-yellow-500 mr-2"></i>
              解决方案
            </h4>
            <div class="bg-blue-50 rounded-lg p-4">
              <ul class="space-y-2">
                ${suggestions.map(suggestion => `
                  <li class="flex items-start space-x-2">
                    <i class="fas fa-arrow-right text-blue-600 mt-1 text-sm"></i>
                    <span class="text-gray-700">${suggestion}</span>
                  </li>
                `).join('')}
              </ul>
            </div>
          </div>

          <!-- 技术信息 -->
          <div>
            <div class="flex items-center justify-between mb-2">
              <h4 class="font-semibold text-gray-800 flex items-center">
                <i class="fas fa-info-circle text-gray-500 mr-2"></i>
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
                  <div class="bg-black rounded p-3 mt-2 overflow-x-auto">
                    <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap">${content}</pre>
                  </div>
                </div>
                <div>
                  <span class="font-medium text-gray-800">网络检测结果:</span>
                  <div class="mt-1 text-xs">
                    <div class="text-green-700">✓ 可访问URL: ${accessibleUrls.length}个</div>
                    <div class="text-red-700">✗ 受限URL: ${inaccessibleUrls.length}个</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 操作按钮 -->
          <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
            <button class="copy-all-urls-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-copy mr-2"></i>复制所有地址
            </button>
            <button class="save-to-history-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-history mr-2"></i>保存到历史记录
            </button>
            <button class="network-close-btn-footer bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-times mr-2"></i>关闭
            </button>
          </div>
        </div>
      </div>
    `

    this.bindNetworkRestrictedModalEvents(modal, config)
    document.body.appendChild(modal)
    this.activeModals.add(modal)

    return modal
  }

  /**
   * 绑定基础模态框事件
   */
  private bindModalEvents(modal: HTMLElement, config: ModalConfig): void {
    // 关闭按钮
    const closeBtn = modal.querySelector('.modal-close-btn')
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        this.closeModal(modal)
        config.onClose?.()
      })
    }

    // 背景点击关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModal(modal)
        config.onClose?.()
      }
    })

    // ESC键关闭
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal(modal)
        config.onClose?.()
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)

    // 操作按钮
    if (config.actions) {
      modal.querySelectorAll('.modal-action-btn').forEach((btn, index) => {
        btn.addEventListener('click', () => {
          config.actions![index]?.onClick()
        })
      })
    }
  }

  /**
   * 绑定网络受限模态框事件
   */
  private bindNetworkRestrictedModalEvents(modal: HTMLElement, config: NetworkRestrictedConfig): void {
    const { inaccessibleUrls, allUrls, content, suggestions, showToast } = config

    // 关闭按钮
    const closeButtons = modal.querySelectorAll('.network-close-btn, .network-close-btn-footer')
    closeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(modal))
    })

    // 背景点击关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal(modal)
    })

    // ESC键关闭
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal(modal)
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)

    // 复制单个URL
    modal.querySelectorAll('.copy-url-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url
        if (url) {
          navigator.clipboard.writeText(url).then(() => {
            showToast('图片地址已复制', 'success')
          }).catch(() => {
            showToast('复制失败', 'error')
          })
        }
      })
    })

    // 新窗口打开URL
    modal.querySelectorAll('.open-url-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url
        if (url) {
          window.open(url, '_blank')
        }
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

    // 标记为可访问按钮
    modal.querySelectorAll('.mark-accessible-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = (btn as HTMLElement).dataset.url
        if (!url) return

        // 调用标记回调
        config.markUrlAsAccessible?.(url)

        // 移动URL到可访问列表
        const index = inaccessibleUrls.indexOf(url)
        if (index > -1) {
          inaccessibleUrls.splice(index, 1)
          showToast('已标记为可访问，将记住此设置', 'success')
          
          // 如果没有受限URL了，关闭弹窗
          if (inaccessibleUrls.length === 0) {
            this.closeModal(modal)
            showToast('所有图片都已标记为可访问！', 'success')
          } else {
            // 重新渲染模态框
            this.closeModal(modal)
            this.createNetworkRestrictedModal(config)
          }
        }
      })
    })

    // 保存到历史记录
    const saveBtn = modal.querySelector('.save-to-history-btn')
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const prompt = config.currentPrompt || '未知提示词'
        const historyType = inaccessibleUrls.length > 0 ? 'network_restricted' : 'generate'
        
        config.onSaveToHistory?.(allUrls, prompt, historyType)
        showToast('已保存到历史记录', 'success')
      })
    }
  }

  /**
   * 关闭模态框
   */
  closeModal(modal: HTMLElement): void {
    modal.remove()
    this.activeModals.delete(modal)
  }

  /**
   * 关闭所有模态框
   */
  closeAll(): void {
    this.activeModals.forEach(modal => {
      modal.remove()
    })
    this.activeModals.clear()
  }

  /**
   * 清理资源
   */
  destroy(): void {
    this.closeAll()
  }
}

// 单例实例
let modalFactoryInstance: ModalFactory | null = null

/**
 * 获取 ModalFactory 单例
 */
export function getModalFactory(): ModalFactory {
  if (!modalFactoryInstance) {
    modalFactoryInstance = new ModalFactory()
  }
  return modalFactoryInstance
}

/**
 * 创建新的 ModalFactory 实例
 */
export function createModalFactory(): ModalFactory {
  return new ModalFactory()
}
