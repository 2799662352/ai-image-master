import { Suspense } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { DirectorApp } from './DirectorApp'
import { useDirectorStore } from './stores/useDirectorStore'
import SettingsPage from '../pages-react/SettingsPage'
import HistoryPage from '../pages-react/HistoryPage'
import BatchPage from '../pages-react/BatchPage'
import { ToastContainer } from '../components/Toast'
import { GenerateTokenBridge } from './components/GenerateTokenBridge'

let root: Root | null = null
let settingsRoot: Root | null = null
let historyRoot: Root | null = null
let batchRoot: Root | null = null
let toastRoot: Root | null = null
let generateTokenRoot: Root | null = null

export function mountDirectorReact(): void {
  const container = document.getElementById('director-react-root')
  if (!container) {
    console.warn('[React] director-react-root not found')
    return
  }

  try {
    const pm = (window as any).pageStateManager
    const saved = pm?.getState?.('director')
    if (saved) {
      const store = useDirectorStore.getState()
      if (saved.currentLayout) store.setLayout(saved.currentLayout)
      if (saved.currentTemplate !== undefined) store.setTemplate(saved.currentTemplate)
      if (saved.currentMode) store.setMode(saved.currentMode)
      if (saved.currentRatio) store.setRatio(saved.currentRatio)
      if (saved.currentResolution) store.setResolution(saved.currentResolution)
      if (saved.sceneDescription !== undefined) store.setSceneDescription(saved.sceneDescription)
      if (saved.multiSceneText !== undefined) store.setMultiSceneText(saved.multiSceneText)
      if (saved.visionModel) store.setVisionModel(saved.visionModel)
      if (saved.imageCount) store.setImageCount(saved.imageCount)
      if (saved.skipVerify !== undefined) store.setSkipVerify(saved.skipVerify)
    }
  } catch (e) {
    console.warn('[React] Failed to restore director state:', e)
  }

  if (!root) {
    root = createRoot(container)
  }
  root.render(<DirectorApp />)
  console.log('[React] DirectorApp mounted')
}

export function unmountDirectorReact(): void {
  try {
    const state = useDirectorStore.getState()
    const pm = (window as any).pageStateManager
    pm?.saveState?.('director', {
      currentLayout: state.currentLayout,
      currentTemplate: state.currentTemplate,
      currentMode: state.currentMode,
      currentRatio: state.currentRatio,
      currentResolution: state.currentResolution,
      sceneDescription: state.sceneDescription,
      multiSceneText: state.multiSceneText,
      visionModel: state.visionModel,
      imageCount: state.imageCount,
      skipVerify: state.skipVerify,
    })
  } catch (e) {
    console.warn('[React] Failed to save director state:', e)
  }

  if (root) {
    root.unmount()
    root = null
    console.log('[React] DirectorApp unmounted')
  }
}

export function mountSettingsReact(): void {
  const container = document.getElementById('settings-react-root')
  if (!container) {
    console.warn('[React] settings-react-root not found')
    return
  }
  if (!settingsRoot) {
    settingsRoot = createRoot(container)
  }
  settingsRoot.render(<SettingsPage />)
  console.log('[React] SettingsPage mounted')
}

export function unmountSettingsReact(): void {
  if (settingsRoot) {
    settingsRoot.unmount()
    settingsRoot = null
    console.log('[React] SettingsPage unmounted')
  }
}

/**
 * HistoryPage 只渲染一次,之后切 tab 只切 display 可见性。
 */
export function mountHistoryReact(): void {
  const container = document.getElementById('history-react-root')
  if (!container) {
    console.warn('[React] history-react-root not found')
    return
  }
  if (!historyRoot) {
    historyRoot = createRoot(container)
    historyRoot.render(
      <Suspense fallback={null}>
        <HistoryPage />
      </Suspense>
    )
    console.log('[React] HistoryPage mounted (first time)')
  }
  container.style.display = ''
}

export function unmountHistoryReact(): void {
  const container = document.getElementById('history-react-root')
  if (container) {
    container.style.display = 'none'
  }
}

/**
 * BatchPage 只渲染一次,之后切 tab 只切 display 可见性,
 * 避免每次 unmount→mount 重建整棵 React tree 导致卡顿。
 */
export function mountBatchReact(): void {
  const container = document.getElementById('batch-react-root')
  if (!container) {
    console.warn('[React] batch-react-root not found')
    return
  }
  // 首次:创建 root + render;后续:只改可见性
  if (!batchRoot) {
    batchRoot = createRoot(container)
    batchRoot.render(
      <Suspense fallback={null}>
        <BatchPage />
      </Suspense>
    )
    console.log('[React] BatchPage (donor-punk) mounted (first time)')
  }
  container.style.display = ''
}

export function unmountBatchReact(): void {
  const container = document.getElementById('batch-react-root')
  if (container) {
    container.style.display = 'none'
  }
}

/**
 * GenerateTokenBridge: mounts once, renders TokenAutocomplete + MentionChips
 * that bridge the native #promptInput textarea on the Generate page.
 */
export function mountGenerateTokenBridge(): void {
  const container = document.getElementById('generate-token-mount')
  if (!container) {
    console.warn('[React] generate-token-mount not found')
    return
  }
  if (!generateTokenRoot) {
    generateTokenRoot = createRoot(container)
    generateTokenRoot.render(<GenerateTokenBridge />)
    console.log('[React] GenerateTokenBridge mounted')
  }
}

export function unmountGenerateTokenBridge(): void {
  if (generateTokenRoot) {
    generateTokenRoot.unmount()
    generateTokenRoot = null
    console.log('[React] GenerateTokenBridge unmounted')
  }
}

export function mountGlobalToast(): void {
  const container = document.getElementById('global-toast-root')
  if (!container) {
    console.warn('[React] global-toast-root not found')
    return
  }
  if (!toastRoot) {
    toastRoot = createRoot(container)
  }
  toastRoot.render(<ToastContainer />)
  console.log('[React] Global ToastContainer mounted')
}
