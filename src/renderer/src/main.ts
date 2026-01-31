// src/renderer/src/main.ts - 渲染进程入口
// 这是 electron-vite 的渲染进程入口文件

// ========================================
// V16.1 - 资源本地化: CDN -> npm 包
// V18 - 延迟加载优化: 大型库按需加载
// ========================================

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

// V16.1.2 - 导入 IntroVideoController (替代 index.html 内联脚本)
import { initIntroVideo } from './features/intro-video'

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
  
  // V16.1.2 - 初始化 Cyberpunk Intro 视频控制器
  // 注意: 当使用 electron-vite 单入口时，此控制器会自动启动
  // 如果使用根目录 index.html，内联脚本仍然会工作（过渡期）
  try {
    initIntroVideo()
    console.log('[main.ts] 🎬 IntroVideoController 已初始化')
  } catch (error) {
    console.warn('[main.ts] IntroVideoController 初始化跳过 (可能不在 intro 页面):', error)
  }
  
  // 初始化 TypeScript 服务
  await initializeServices()
  
  // 检查服务状态
  if (isServiceBridgeReady()) {
    console.log('[main.ts] ✅ 所有 TypeScript 服务已就绪')
    console.log('[main.ts] 📦 window.appServices 命名空间可用')
    
    // V18: 空闲时预加载大型库
    preloadLibraries()
    console.log('[main.ts] 📦 V18 延迟库预加载已调度')
  }
})

// 导出类型供其他模块使用
export { initServiceBridge, isServiceBridgeReady }
