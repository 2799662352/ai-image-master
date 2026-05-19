import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Buffer } from 'buffer'
import App from './App'
import './styles/index.css'

if (typeof globalThis.Buffer === 'undefined') {
  ;(globalThis as any).Buffer = Buffer
}

import { getJSZip, getImageCompression, preloadLibraries } from './utils'
import { initServiceBridge, isServiceBridgeReady } from './services/ServiceBridge'

declare global {
  interface Window {
    getJSZip: typeof getJSZip
    getImageCompression: typeof getImageCompression
    electronAPI?: any
    JSZip?: any
    imageCompression?: any
  }
}

window.getJSZip = getJSZip
window.getImageCompression = getImageCompression

// ─── 全局错误兜底 ──────────────────────────────────────────────────────
//
// 渲染进程的 unhandledrejection / error 默认会被打到 DevTools console,
// 但 Electron 在某些情况下(尤其是 native 端崩溃或 OOM 边缘场景)会因
// 未处理的 error event 把整个渲染进程 kill 掉, 用户感知就是"页面白屏 +
// 应用被自动关闭"。即便不到 kill 的程度, 把它们集中接管能让我们看清
// 哪些异步链路在悄悄抛错。
//
// 用 capture-phase 注册, 保证早于任何 React error boundary 拿到事件,
// preventDefault 阻止默认行为(写到 DevTools 之外的额外副作用)。
window.addEventListener(
  'unhandledrejection',
  (event) => {
    const reason: unknown = event.reason
    const msg =
      reason instanceof Error
        ? `${reason.message}\n${reason.stack}`
        : String(reason)
    console.error('[renderer] unhandledrejection (吞掉):', msg)
    event.preventDefault()
  },
  true,
)
window.addEventListener(
  'error',
  (event) => {
    // 资源加载错误 (img/script/link) 也会触发 'error', 但它们 event.error
    // 通常是 null, 只有 event.target 是失败的元素。这里只关心脚本错误。
    if (!event.error) return
    console.error(
      '[renderer] uncaught error (吞掉):',
      event.message,
      event.filename,
      event.lineno,
      event.colno,
      event.error?.stack || event.error,
    )
    // 不 preventDefault: DevTools 还是要能看到红色提示, 方便调试。
  },
  true,
)

async function boot() {
  try {
    await initServiceBridge({
      useTypescriptServices: true,
      exposeUtilFunctions: true,
      onReady: () => window.dispatchEvent(new CustomEvent('serviceBridgeReady')),
    })
  } catch (e) {
    console.error('[main.tsx] ServiceBridge init failed:', e)
  }

  const container = document.getElementById('root')
  if (!container) throw new Error('Root element #root not found')

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  const loader = document.getElementById('loadingContainer')
  if (loader) loader.style.display = 'none'

  if (isServiceBridgeReady()) preloadLibraries()
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot)
} else {
  boot()
}
