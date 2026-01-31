// src/renderer/src/utils/network-diagnostics.ts
// 网络诊断工具 - 从 app.js 提取

export interface NetworkTestResult {
  browserOnline: boolean
  internetAccess: boolean | null
  apiReachable: boolean | null
  latency?: number
  timestamp: number
}

export interface DiagnosisReport {
  results: NetworkTestResult
  suggestions: string[]
  formattedReport: string
}

export interface NetworkDiagnosticsConfig {
  testUrls?: {
    internet?: string
    api?: string
  }
  timeout?: number
}

const DEFAULT_CONFIG: Required<NetworkDiagnosticsConfig> = {
  testUrls: {
    internet: 'https://www.google.com/favicon.ico',
    api: ''
  },
  timeout: 5000
}

/**
 * 网络诊断工具类
 */
export class NetworkDiagnostics {
  private config: Required<NetworkDiagnosticsConfig>

  constructor(config: NetworkDiagnosticsConfig = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      testUrls: { ...DEFAULT_CONFIG.testUrls, ...config.testUrls }
    }
    if (config.timeout !== undefined) {
      this.config.timeout = config.timeout
    }
  }

  /**
   * 检查浏览器在线状态
   */
  checkBrowserOnline(): boolean {
    return navigator.onLine
  }

  /**
   * 测试互联网连接
   */
  async testInternetAccess(): Promise<boolean> {
    if (!this.checkBrowserOnline()) {
      return false
    }

    const testUrl = this.config.testUrls.internet
    if (!testUrl) {
      return false
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout)

      await fetch(testUrl, {
        method: 'HEAD',
        mode: 'no-cors',
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      return true
    } catch {
      return false
    }
  }

  /**
   * 测试 API 端点可达性
   */
  async testApiReachable(apiUrl?: string): Promise<boolean> {
    const url = apiUrl || this.config.testUrls.api
    if (!url) {
      return false
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout)

      const response = await fetch(url, {
        method: 'HEAD',
        mode: 'cors',
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      return response.ok || response.status === 401 || response.status === 403
    } catch {
      return false
    }
  }

  /**
   * 执行完整的网络诊断
   */
  async runFullDiagnostics(apiUrl?: string): Promise<NetworkTestResult> {
    const startTime = Date.now()
    const results: NetworkTestResult = {
      browserOnline: this.checkBrowserOnline(),
      internetAccess: null,
      apiReachable: null,
      timestamp: Date.now()
    }

    if (results.browserOnline) {
      results.internetAccess = await this.testInternetAccess()
      
      if (results.internetAccess) {
        const apiTestStart = Date.now()
        results.apiReachable = await this.testApiReachable(apiUrl)
        results.latency = Date.now() - apiTestStart
      }
    }

    return results
  }

  /**
   * 生成诊断建议
   */
  generateSuggestions(results: NetworkTestResult): string[] {
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

    return suggestions
  }

  /**
   * 生成完整诊断报告
   */
  async generateReport(apiUrl?: string): Promise<DiagnosisReport> {
    const results = await this.runFullDiagnostics(apiUrl)
    const suggestions = this.generateSuggestions(results)
    
    const formattedReport = this.formatReport(results, suggestions, apiUrl)

    return {
      results,
      suggestions,
      formattedReport
    }
  }

  /**
   * 格式化诊断报告
   */
  formatReport(results: NetworkTestResult, suggestions: string[], apiUrl?: string): string {
    return `=== 网络诊断报告 ===
测试时间: ${new Date(results.timestamp).toLocaleString()}
浏览器: ${navigator.userAgent.split(' ').pop()}

测试结果:
- 浏览器在线状态: ${results.browserOnline ? '✅ 在线' : '❌ 离线'}
- 互联网连接: ${results.internetAccess === true ? '✅ 正常' : results.internetAccess === false ? '❌ 失败' : '⚠️ 未测试'}
- API 端点: ${results.apiReachable === true ? '✅ 正常' : results.apiReachable === false ? '❌ 失败' : '⚠️ 未测试'}
${apiUrl ? `- API 地址: ${apiUrl}` : ''}
${results.latency !== undefined ? `- API 延迟: ${results.latency}ms` : ''}

诊断建议:
${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}
`
  }
}

// 单例实例
let diagnosticsInstance: NetworkDiagnostics | null = null

/**
 * 获取 NetworkDiagnostics 单例
 */
export function getNetworkDiagnostics(config?: NetworkDiagnosticsConfig): NetworkDiagnostics {
  if (!diagnosticsInstance) {
    diagnosticsInstance = new NetworkDiagnostics(config)
  }
  return diagnosticsInstance
}

/**
 * 创建新的 NetworkDiagnostics 实例
 */
export function createNetworkDiagnostics(config?: NetworkDiagnosticsConfig): NetworkDiagnostics {
  return new NetworkDiagnostics(config)
}

/**
 * 快速检查网络状态
 */
export async function quickNetworkCheck(): Promise<boolean> {
  return navigator.onLine && await getNetworkDiagnostics().testInternetAccess()
}
