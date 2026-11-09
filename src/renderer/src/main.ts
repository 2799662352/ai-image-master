// src/renderer/src/main.ts - 渲染进程入口
// 这是 electron-vite 的渲染进程入口文件

// ========================================
// V16.1 - 资源本地化: CDN -> npm 包
// V18 - 延迟加载优化: 大型库按需加载
// ========================================

import { Buffer } from 'buffer'
if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as any).Buffer = Buffer
}

// 导入 Tailwind CSS (已通过 PostCSS 处理)
import './styles/index.css'

// 导入 Choices.js 及其样式 (需要早期加载 - 用于下拉框)
import 'choices.js/public/assets/styles/choices.min.css'
import Choices from 'choices.js'

// V18: JSZip 和 imageCompression 改为延迟加载
// 使用 getJSZip() 和 getImageCompression() 按需加载
import { getJSZip, getImageCompression, preloadLibraries } from './utils'

// 将 Choices 暴露到 window 以兼容现有 JS 代码 (过渡期)
declare global {
  interface Window {
    Choices: typeof Choices
    // V18: 延迟加载函数替代直接实例
    getJSZip: typeof getJSZip
    getImageCompression: typeof getImageCompression
    // 保留类型声明供向后兼容检查
    JSZip?: any
    imageCompression?: any
  }
}

// 过渡期: 暴露到 window 供 js/ 目录下的旧代码使用
window.Choices = Choices
// V18: 暴露延迟加载函数而非实例
window.getJSZip = getJSZip
window.getImageCompression = getImageCompression

console.log('📦 [V18] 资源优化: Choices.js 同步加载, JSZip/imageCompression 延迟加载')

// 导入 ServiceBridge
import { initServiceBridge, isServiceBridgeReady } from './services/ServiceBridge'

// V16.4 - 导入 AppBootstrap (替代 app.js)
import { getAppBootstrap, initAppBootstrapGlobal } from './core/AppBootstrap'

// 启动开场动画(每天首次启动播完整版,Esc 可跳过;同时负责应用就绪后的揭幕)
import { initStartupScreen } from './features/startup-screen'
import { mountAgentChatRuntime } from './features/agent-chat'

console.log('🚀 CATIMATION-Cyberpunk Master 渲染进程启动')

// 检查 Electron API 是否可用
if (window.electronAPI) {
  console.log('✅ Electron API 可用')
} else {
  console.log('⚠️ 非 Electron 环境或 preload 未加载')
}

/**
 * 初始化应用服务
 * ServiceBridge 需要在 app.js 之前初始化，以便 app.js 能使用 TS 服务
 */
async function initializeServices(): Promise<void> {
  try {
    console.log('[main.ts] 开始初始化服务桥接...')
    
    await initServiceBridge({
      useTypescriptServices: true,
      exposeUtilFunctions: true,
      onReady: () => {
        console.log('[main.ts] ✅ ServiceBridge 初始化完成，等待 app.js 初始化...')
        
        // 触发自定义事件通知 app.js 可以开始初始化
        window.dispatchEvent(new CustomEvent('serviceBridgeReady'))
      }
    })
  } catch (error) {
    console.error('[main.ts] ServiceBridge 初始化失败:', error)
    // 发出错误事件
    window.dispatchEvent(new CustomEvent('serviceBridgeError', { detail: error }))
  }
}

// 在 DOM 加载完成后初始化服务
document.addEventListener('DOMContentLoaded', async () => {
  console.log('📄 DOM 加载完成')
  
  // 启动开场动画 + 揭幕。必须最先挂上:它要监听后面 bootstrap 发出的 appReady。
  // 失败只记日志,不能挡住应用启动(揭幕有 15 秒兜底)。
  try {
    initStartupScreen()
  } catch (error) {
    console.warn('[main.ts] 启动开场初始化失败,直接进入应用:', error)
  }
  
  // 初始化 TypeScript 服务
  await initializeServices()
  
  // 检查服务状态
  if (isServiceBridgeReady()) {
    console.log('[main.ts] ✅ 所有 TypeScript 服务已就绪')
    console.log('[main.ts] 📦 window.appServices 命名空间可用')
    
    // V16.4: 初始化 AppBootstrap 并启动应用
    // 注意: 在 electron-vite SPA 模式下，需要调用 bootstrap() 来渲染 UI
    try {
      const appBootstrap = initAppBootstrapGlobal()
      await appBootstrap.bootstrap()
      mountAgentChatRuntime()
      console.log('[main.ts] ✅ AppBootstrap 启动完成')
      
      // 隐藏加载容器，显示应用
      const loadingContainer = document.getElementById('loadingContainer')
      if (loadingContainer) {
        loadingContainer.style.display = 'none'
      }
    } catch (error) {
      console.error('[main.ts] AppBootstrap 启动失败:', error)
    }
    
    // V18: 空闲时预加载大型库
    preloadLibraries()
    console.log('[main.ts] 📦 V18 延迟库预加载已调度')
  }
})

// 导出类型供其他模块使用
export { initServiceBridge, isServiceBridgeReady }
