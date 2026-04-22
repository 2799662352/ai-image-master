// src/renderer/src/features/error-handler/ErrorHandler.ts
// 错误处理器 - 从 app.js 提取

export interface ErrorInfo {
  title: string
  message: string
  details?: string[]
  technicalDetails?: string[]
  rawResponse?: string
  candidateStructure?: string
  parsedErrorData?: {
    error?: {
      code?: string
      message?: string
      type?: string
    }
    status_code?: number
  }
  rejectionType?: string
  apiTextResponse?: string
  errorData?: {
    isNetworkError?: boolean
    diagnosis?: any
  }
}

export interface NetworkTestResults {
  browserOnline: boolean
  internetAccess: boolean | null
  apiReachable: boolean | null
  timestamp: number
}

export interface ErrorHandlerConfig {
  showToast?: (message: string, type: 'success' | 'error' | 'info' | 'warning') => void
  onRetry?: (errorInfo: ErrorInfo) => void
  apiInstance?: any
}

const REJECTION_TYPE_NAMES: Record<string, string> = {
  'watermark_removal': '去水印请求',
  'faceswap': '换脸请求',
  'nsfw': 'NSFW内容',
  'finish_reason': 'API 拒绝（finishReason）',
  'api_text_response': 'API 返回说明',
  'zero_candidates_token': '谷歌内容审核拒绝（candidatesTokenCount: 0）',
  'knowledge_cutoff': '知识库限制',
  'general_rejection': '内容被拒绝'
}

export class ErrorHandler {
  private config: ErrorHandlerConfig
  private activeModals: Set<HTMLElement> = new Set()

  constructor(config: ErrorHandlerConfig = {}) {
    this.config = config
  }

  /**
   * 获取拒绝类型的友好名称
   */
  getRejectionTypeName(rejectionType: string): string {
    return REJECTION_TYPE_NAMES[rejectionType] || rejectionType
  }

  /**
   * 显示详细错误信息模态框
   */
  showDetailedError(error: any, context: string = ''): void {
    const api = this.config.apiInstance || (window as any).aiImageAPI
    const errorInfo: ErrorInfo = api?.formatDetailedError?.(error) || this.formatBasicError(error)
    
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/70 z-[60000] flex items-center justify-center p-4'
    
    modal.innerHTML = this.generateErrorModalHTML(errorInfo, context)

    // 绑定事件
    this.bindErrorModalEvents(modal, errorInfo, error)
    
    // 添加到页面
    document.body.appendChild(modal)
    this.activeModals.add(modal)
    
    // 自动聚焦到模态框（可访问性）
    setTimeout(() => {
      modal.focus()
    }, 100)
  }

  /**
   * 生成基础错误信息
   */
  private formatBasicError(error: any): ErrorInfo {
    return {
      title: '发生错误',
      message: error?.message || String(error) || '未知错误',
      details: ['请稍后重试或联系技术支持']
    }
  }

  /**
   * 生成错误模态框HTML
   */
  private generateErrorModalHTML(errorInfo: ErrorInfo, context: string): string {
    return `
      <div class="bg-white rounded-xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <!-- 错误标题 -->
        <div class="bg-red-50 border-b border-red-200 px-6 py-4 rounded-t-xl">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="bg-red-100 rounded-full p-2">
                <i class="fas fa-exclamation-triangle text-red-600 text-xl"></i>
              </div>
              <div>
                <h3 class="text-lg font-bold text-red-800">${errorInfo.title}</h3>
                ${context ? `<p class="text-sm text-red-600">${context}</p>` : ''}
              </div>
            </div>
            <button class="error-close-btn text-red-400 hover:text-red-600 transition-colors" title="关闭" aria-label="关闭错误详情">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
        </div>

        <!-- 错误内容 -->
        <div class="p-6 space-y-6">
          <!-- 主要错误信息 -->
          <div>
            <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
              <i class="fas fa-info-circle text-blue-500 mr-2"></i>
              错误描述
            </h4>
            <div class="bg-gray-50 rounded-lg p-4">
              <p class="text-gray-700">${errorInfo.message}</p>
              
              ${errorInfo.rawResponse ? `
              <!-- 快速响应预览 -->
              <div class="mt-4 border-t border-gray-300 pt-4">
                <div class="flex items-center justify-between mb-2">
                  <h5 class="font-medium text-gray-800 text-sm">
                    <i class="fas fa-file-alt text-orange-500 mr-1"></i>
                    API响应内容预览
                  </h5>
                  <span class="text-xs text-gray-500">完整内容请查看下方技术详情</span>
                </div>
                <div class="bg-gray-800 rounded p-3 overflow-x-auto max-h-32 overflow-y-auto">
                  <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap">${errorInfo.rawResponse.substring(0, 500)}${errorInfo.rawResponse.length > 500 ? '\n\n... (内容已截断，完整内容请查看技术详情) ...' : ''}</pre>
                </div>
              </div>
              ` : ''}
            </div>
          </div>

          ${errorInfo.details && errorInfo.details.length > 0 ? `
          <!-- 解决建议 -->
          <div>
            <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
              <i class="fas fa-lightbulb text-yellow-500 mr-2"></i>
              排查建议
            </h4>
            <div class="bg-yellow-50 rounded-lg p-4">
              <ul class="space-y-2">
                ${errorInfo.details.map(detail => `
                  <li class="flex items-start space-x-2">
                    <i class="fas fa-arrow-right text-yellow-600 mt-1 text-sm"></i>
                    <span class="text-gray-700">${detail}</span>
                  </li>
                `).join('')}
              </ul>
            </div>
          </div>
          ` : ''}

          ${errorInfo.rejectionType ? `
          <!-- Nano Banana Pro 常见问题提示 -->
          <div>
            <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
              <i class="fas fa-info-circle text-orange-500 mr-2"></i>
              Nano Banana Pro 常见问题
            </h4>
            <div class="bg-orange-50 border border-orange-200 rounded-lg p-4">
              <div class="space-y-3">
                <div class="flex items-start space-x-2">
                  <i class="fas fa-exclamation-circle text-orange-600 mt-1"></i>
                  <div>
                    <p class="text-gray-800 font-medium">检测到错误类型: ${this.getRejectionTypeName(errorInfo.rejectionType)}</p>
                    ${errorInfo.apiTextResponse ? `
                    <p class="text-sm text-gray-600 mt-1">
                      <span class="font-medium">API 原始响应:</span> 
                      <span class="font-mono text-xs">"${errorInfo.apiTextResponse.substring(0, 100)}${errorInfo.apiTextResponse.length > 100 ? '...' : ''}"</span>
                    </p>
                    ` : ''}
                  </div>
                </div>
                <div class="border-t border-orange-200 pt-3">
                  <a href="#" class="view-faq-link text-blue-600 hover:text-blue-800 underline text-sm font-medium flex items-center">
                    <i class="fas fa-book-open mr-1"></i>
                    查看 Nano Banana Pro 完整常见问题说明
                  </a>
                </div>
              </div>
            </div>
          </div>
          ` : ''}

          ${this.generateTechnicalDetailsHTML(errorInfo)}

          <!-- 操作按钮 -->
          <div class="flex flex-col sm:flex-row gap-3 pt-4 border-t border-gray-200">
            ${errorInfo.errorData?.isNetworkError && errorInfo.errorData?.diagnosis ? `
            <!-- 网络错误专用按钮 -->
            <button class="retry-request-btn flex-1 bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-redo mr-2"></i>立即重试
            </button>
            <button class="test-connection-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-network-wired mr-2"></i>测试连接
            </button>
            ` : `
            <button class="copy-error-btn flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-copy mr-2"></i>复制错误信息
            </button>
            `}
            <button class="error-close-btn-footer bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-times mr-2"></i>关闭
            </button>
          </div>
        </div>
      </div>
    `
  }

  /**
   * 生成技术详情HTML
   */
  private generateTechnicalDetailsHTML(errorInfo: ErrorInfo): string {
    if (!errorInfo.technicalDetails || errorInfo.technicalDetails.length === 0) {
      return ''
    }

    return `
      <!-- 技术详情 -->
      <div>
        <h4 class="font-semibold text-gray-800 mb-2 flex items-center">
          <i class="fas fa-code text-gray-500 mr-2"></i>
          技术详情
          <button class="toggle-tech-details ml-2 text-xs text-blue-600 hover:text-blue-800 underline">
            展开/收起
          </button>
        </h4>
        <div class="tech-details-content ${errorInfo.rawResponse ? '' : 'hidden'} bg-gray-100 rounded-lg p-4 overflow-x-auto">
          <div class="space-y-4 text-sm">
            <!-- 基本技术信息 -->
            <div class="space-y-2 font-mono">
              ${errorInfo.technicalDetails.map(detail => `
                <div class="text-gray-600">${detail}</div>
              `).join('')}
            </div>
            
            ${errorInfo.candidateStructure ? `
            <!-- Candidate 结构（重点展示）-->
            <div class="border-t border-gray-300 pt-4">
              <div class="flex items-center justify-between mb-2">
                <h5 class="font-semibold text-gray-800 text-sm">
                  <i class="fas fa-exclamation-triangle text-red-500 mr-1"></i>
                  API 返回的 Candidate 结构
                </h5>
                <button class="copy-candidate-structure text-xs text-blue-600 hover:text-blue-800 underline">
                  复制 Candidate 结构
                </button>
              </div>
              <div class="bg-red-900 rounded p-3 overflow-x-auto">
                <pre class="text-yellow-300 text-xs font-mono whitespace-pre-wrap candidate-structure-content">${errorInfo.candidateStructure}</pre>
              </div>
              <p class="text-xs text-gray-600 mt-2">
                <i class="fas fa-info-circle mr-1"></i>
                此结构包含 API 拒绝的具体原因（finishReason）及相关信息
              </p>
            </div>
            ` : ''}
            
            ${errorInfo.rawResponse ? `
            <!-- 完整原始响应 -->
            <div class="border-t border-gray-300 pt-4">
              <div class="flex items-center justify-between mb-2">
                <h5 class="font-semibold text-gray-800 text-sm">
                  <i class="fas fa-file-code text-orange-500 mr-1"></i>
                  完整接口响应 (原始JSON)
                </h5>
                <button class="copy-raw-response text-xs text-blue-600 hover:text-blue-800 underline">
                  复制原始响应
                </button>
              </div>
              <div class="bg-black rounded p-3 overflow-x-auto">
                <pre class="text-green-400 text-xs font-mono whitespace-pre-wrap raw-response-content">${errorInfo.rawResponse}</pre>
              </div>
            </div>
            ` : ''}
            
            ${errorInfo.parsedErrorData ? `
            <!-- 解析后的错误数据 -->
            <div class="border-t border-gray-300 pt-4">
              <h5 class="font-semibold text-gray-800 text-sm mb-2">
                <i class="fas fa-search text-blue-500 mr-1"></i>
                解析后的错误信息
              </h5>
              <div class="bg-blue-50 rounded p-3">
                <div class="space-y-1 text-xs">
                  ${errorInfo.parsedErrorData.error?.code ? `
                    <div><span class="font-medium text-blue-800">错误代码:</span> <span class="font-mono text-red-600">${errorInfo.parsedErrorData.error.code}</span></div>
                  ` : ''}
                  ${errorInfo.parsedErrorData.status_code ? `
                    <div><span class="font-medium text-blue-800">状态码:</span> <span class="font-mono text-red-600">${errorInfo.parsedErrorData.status_code}</span></div>
                  ` : ''}
                  ${errorInfo.parsedErrorData.error?.message ? `
                    <div><span class="font-medium text-blue-800">错误消息:</span> <span class="text-gray-700">${errorInfo.parsedErrorData.error.message}</span></div>
                  ` : ''}
                  ${errorInfo.parsedErrorData.error?.type ? `
                    <div><span class="font-medium text-blue-800">错误类型:</span> <span class="font-mono text-gray-600">${errorInfo.parsedErrorData.error.type}</span></div>
                  ` : ''}
                </div>
              </div>
            </div>
            ` : ''}
          </div>
        </div>
      </div>
    `
  }

  /**
   * 绑定错误模态框事件
   */
  private bindErrorModalEvents(modal: HTMLElement, errorInfo: ErrorInfo, originalError: any): void {
    const showToast = this.config.showToast || ((msg: string) => console.log(msg))

    // 关闭按钮事件
    const closeButtons = modal.querySelectorAll('.error-close-btn, .error-close-btn-footer')
    closeButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        this.closeModal(modal)
      })
    })

    // 点击背景关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeModal(modal)
      }
    })

    // ESC键关闭
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closeModal(modal)
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)

    // 技术详情展开/收起
    const toggleBtn = modal.querySelector('.toggle-tech-details')
    const techContent = modal.querySelector('.tech-details-content')
    if (toggleBtn && techContent) {
      toggleBtn.addEventListener('click', () => {
        techContent.classList.toggle('hidden')
      })
    }

    // 复制错误信息
    const copyBtn = modal.querySelector('.copy-error-btn')
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const errorText = this.formatErrorForCopy(errorInfo)
        navigator.clipboard.writeText(errorText).then(() => {
          showToast('错误信息已复制到剪贴板', 'success')
        }).catch(() => {
          showToast('复制失败，请手动复制', 'error')
        })
      })
    }

    // 复制原始响应
    const copyRawBtn = modal.querySelector('.copy-raw-response')
    if (copyRawBtn) {
      copyRawBtn.addEventListener('click', () => {
        const rawResponse = errorInfo.rawResponse || 'N/A'
        navigator.clipboard.writeText(rawResponse).then(() => {
          showToast('原始JSON响应已复制到剪贴板', 'success')
        }).catch(() => {
          showToast('复制失败，请手动复制', 'error')
        })
      })
    }

    // 复制 Candidate 结构
    const copyCandidateBtn = modal.querySelector('.copy-candidate-structure')
    if (copyCandidateBtn) {
      copyCandidateBtn.addEventListener('click', () => {
        const candidateStructure = errorInfo.candidateStructure || 'N/A'
        navigator.clipboard.writeText(candidateStructure).then(() => {
          showToast('Candidate 结构已复制到剪贴板', 'success')
        }).catch(() => {
          showToast('复制失败，请手动复制', 'error')
        })
      })
    }

    // 查看常见问题链接
    const faqLink = modal.querySelector('.view-faq-link')
    if (faqLink) {
      faqLink.addEventListener('click', (e) => {
        e.preventDefault()
        this.showNanoBananaFAQ()
      })
    }

    // 立即重试按钮
    const retryBtn = modal.querySelector('.retry-request-btn') as HTMLButtonElement | null
    if (retryBtn) {
      retryBtn.addEventListener('click', async () => {
        if (!navigator.onLine) {
          showToast('设备离线，请先连接网络', 'error')
          return
        }
        
        retryBtn.disabled = true
        const originalHTML = retryBtn.innerHTML
        retryBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>重试中...'
        
        try {
          showToast('正在重试...', 'info')
          this.closeModal(modal)
          
          // 触发重试事件
          window.dispatchEvent(new CustomEvent('retryFailedRequest', {
            detail: {
              error: originalError,
              errorInfo: errorInfo
            }
          }))
          
          this.config.onRetry?.(errorInfo)
        } catch (e) {
          console.error('重试失败:', e)
          retryBtn.disabled = false
          retryBtn.innerHTML = originalHTML
          showToast('重试失败，请稍后再试', 'error')
        }
      })
    }

    // 测试连接按钮
    const testBtn = modal.querySelector('.test-connection-btn') as HTMLButtonElement | null
    if (testBtn) {
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true
        const originalHTML = testBtn.innerHTML
        testBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>测试中...'
        
        try {
          const api = this.config.apiInstance || (window as any).aiImageAPI
          const results = await api?.testNetworkConnection?.()
          testBtn.disabled = false
          testBtn.innerHTML = originalHTML
          
          if (results) {
            this.showNetworkTestResults(results)
          }
        } catch (e) {
          testBtn.disabled = false
          testBtn.innerHTML = originalHTML
          showToast('测试失败', 'error')
        }
      })
    }
  }

  /**
   * 显示网络测试结果
   */
  showNetworkTestResults(results: NetworkTestResults): void {
    const showToast = this.config.showToast || ((msg: string) => console.log(msg))
    
    const modal = document.createElement('div')
    modal.className = 'fixed inset-0 bg-black/70 z-[60000] flex items-center justify-center p-4'
    
    const getStatusIcon = (status: boolean | null): string => {
      if (status === true) return '<i class="fas fa-check-circle text-green-500"></i>'
      if (status === false) return '<i class="fas fa-times-circle text-red-500"></i>'
      return '<i class="fas fa-question-circle text-gray-400"></i>'
    }
    
    const getStatusText = (status: boolean | null): string => {
      if (status === true) return '<span class="text-green-600 font-medium">正常</span>'
      if (status === false) return '<span class="text-red-600 font-medium">失败</span>'
      return '<span class="text-gray-500">未测试</span>'
    }
    
    // 生成诊断建议
    const suggestions: string[] = []
    if (!results.browserOnline) {
      suggestions.push('设备处于离线状态，请检查网络连接')
    } else if (!results.internetAccess) {
      suggestions.push('无法访问互联网，请检查网络连接或防火墙设置')
    } else if (!results.apiReachable) {
      suggestions.push('API 服务器可能暂时不可用')
      suggestions.push('建议稍后重试或联系技术支持')
      suggestions.push('或检查防火墙是否阻止了 API 域名')
    } else {
      suggestions.push('网络连接正常，可以尝试重试请求')
    }
    
    const api = this.config.apiInstance || (window as any).aiImageAPI
    
    modal.innerHTML = `
      <div class="bg-white rounded-xl w-full max-w-md mx-4">
        <div class="bg-blue-50 border-b border-blue-200 px-6 py-4 rounded-t-xl">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <div class="bg-blue-100 rounded-full p-2">
                <i class="fas fa-network-wired text-blue-600 text-xl"></i>
              </div>
              <h3 class="text-lg font-bold text-blue-800">网络诊断结果</h3>
            </div>
            <button class="test-close-btn text-blue-400 hover:text-blue-600 transition-colors">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
        </div>
        
        <div class="p-6">
          <!-- 测试结果 -->
          <div class="space-y-3 mb-6">
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <span class="text-gray-700 font-medium">浏览器在线状态</span>
              <div class="flex items-center space-x-2">
                ${getStatusIcon(results.browserOnline)}
                ${getStatusText(results.browserOnline)}
              </div>
            </div>
            
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <span class="text-gray-700 font-medium">互联网连接</span>
              <div class="flex items-center space-x-2">
                ${getStatusIcon(results.internetAccess)}
                ${getStatusText(results.internetAccess)}
              </div>
            </div>
            
            <div class="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
              <span class="text-gray-700 font-medium">API 端点</span>
              <div class="flex items-center space-x-2">
                ${getStatusIcon(results.apiReachable)}
                ${getStatusText(results.apiReachable)}
              </div>
            </div>
          </div>
          
          <!-- 诊断建议 -->
          ${suggestions.length > 0 ? `
          <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-4">
            <h4 class="font-semibold text-yellow-800 mb-2 flex items-center">
              <i class="fas fa-lightbulb mr-2"></i>诊断建议
            </h4>
            <ul class="space-y-1">
              ${suggestions.map(s => `
                <li class="flex items-start space-x-2 text-sm text-gray-700">
                  <i class="fas fa-arrow-right text-yellow-600 mt-1 text-xs"></i>
                  <span>${s}</span>
                </li>
              `).join('')}
            </ul>
          </div>
          ` : ''}
          
          <!-- 操作按钮 -->
          <div class="flex gap-3">
            <button class="copy-test-results flex-1 bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-copy mr-2"></i>复制诊断报告
            </button>
            <button class="test-close-btn bg-gray-500 hover:bg-gray-600 text-white py-2 px-4 rounded-lg transition-colors">
              <i class="fas fa-times mr-2"></i>关闭
            </button>
          </div>
        </div>
      </div>
    `
    
    // 绑定事件
    const closeButtons = modal.querySelectorAll('.test-close-btn')
    closeButtons.forEach(btn => {
      btn.addEventListener('click', () => this.closeModal(modal))
    })
    
    const copyBtn = modal.querySelector('.copy-test-results')
    if (copyBtn) {
      copyBtn.addEventListener('click', () => {
        const report = `=== 网络诊断报告 ===
测试时间: ${new Date(results.timestamp).toLocaleString()}
浏览器: ${navigator.userAgent.split(' ').pop()}

测试结果:
- 浏览器在线状态: ${results.browserOnline ? '✅ 在线' : '❌ 离线'}
- 互联网连接: ${results.internetAccess === true ? '✅ 正常' : results.internetAccess === false ? '❌ 失败' : '⚠️ 未测试'}
- API 端点: ${results.apiReachable === true ? '✅ 正常' : results.apiReachable === false ? '❌ 失败' : '⚠️ 未测试'}
- API 地址: ${api?.baseURL || 'N/A'}

诊断建议:
${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`
        navigator.clipboard.writeText(report).then(() => {
          showToast('诊断报告已复制', 'success')
        }).catch(() => {
          showToast('复制失败', 'error')
        })
      })
    }
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) this.closeModal(modal)
    })
    
    document.body.appendChild(modal)
    this.activeModals.add(modal)
  }

  /**
   * 显示 Nano Banana Pro 常见问题
   */
  showNanoBananaFAQ(): void {
    const app = (window as any).app
    if (app?.switchTab) {
      app.switchTab('settings')
    }
    
    // 稍后滚动到 FAQ 区域
    setTimeout(() => {
      const faqSection = document.getElementById('nano-banana-faq-section')
      if (faqSection) {
        faqSection.scrollIntoView({ behavior: 'smooth', block: 'start' })
        // 高亮显示
        faqSection.classList.add('highlight-flash')
        setTimeout(() => {
          faqSection.classList.remove('highlight-flash')
        }, 2000)
      } else {
        this.config.showToast?.('常见问题文档正在完善中，请稍后查看', 'info')
      }
    }, 300)
  }

  /**
   * 格式化错误信息用于复制
   */
  formatErrorForCopy(errorInfo: ErrorInfo): string {
    let text = `=== AI图片生成错误详情 ===\n\n`
    text += `错误类型: ${errorInfo.title}\n`
    text += `错误描述: ${errorInfo.message}\n\n`
    
    if (errorInfo.details && errorInfo.details.length > 0) {
      text += `排查建议:\n`
      errorInfo.details.forEach((detail, index) => {
        text += `${index + 1}. ${detail}\n`
      })
      text += `\n`
    }
    
    if (errorInfo.technicalDetails && errorInfo.technicalDetails.length > 0) {
      text += `技术详情:\n`
      errorInfo.technicalDetails.forEach(detail => {
        text += `- ${detail}\n`
      })
      text += `\n`
    }
    
    // 添加解析后的错误信息
    if (errorInfo.parsedErrorData) {
      text += `解析后的错误信息:\n`
      if (errorInfo.parsedErrorData.error?.code) {
        text += `- 错误代码: ${errorInfo.parsedErrorData.error.code}\n`
      }
      if (errorInfo.parsedErrorData.status_code) {
        text += `- 状态码: ${errorInfo.parsedErrorData.status_code}\n`
      }
      if (errorInfo.parsedErrorData.error?.message) {
        text += `- 错误消息: ${errorInfo.parsedErrorData.error.message}\n`
      }
      if (errorInfo.parsedErrorData.error?.type) {
        text += `- 错误类型: ${errorInfo.parsedErrorData.error.type}\n`
      }
      text += `\n`
    }
    
    // 添加 Candidate 结构（如果有）
    if (errorInfo.candidateStructure) {
      text += `API 返回的 Candidate 结构:\n`
      text += `${errorInfo.candidateStructure}\n\n`
    }
    
    // 添加完整的原始JSON响应
    if (errorInfo.rawResponse) {
      text += `完整接口响应 (原始JSON):\n`
      text += `${errorInfo.rawResponse}\n\n`
    }
    
    text += `生成时间: ${new Date().toLocaleString()}`
    return text
  }

  /**
   * 关闭模态框
   */
  private closeModal(modal: HTMLElement): void {
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
let errorHandlerInstance: ErrorHandler | null = null

/**
 * 获取 ErrorHandler 单例
 */
export function getErrorHandler(config?: ErrorHandlerConfig): ErrorHandler {
  if (!errorHandlerInstance) {
    errorHandlerInstance = new ErrorHandler(config)
  }
  return errorHandlerInstance
}

/**
 * 创建新的 ErrorHandler 实例
 */
export function createErrorHandler(config?: ErrorHandlerConfig): ErrorHandler {
  return new ErrorHandler(config)
}
