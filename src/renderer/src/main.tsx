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
