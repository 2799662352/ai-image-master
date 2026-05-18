import { Suspense, lazy } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { DirectorApp } from './DirectorApp'
import { useDirectorStore } from './stores/useDirectorStore'
import SettingsPage from '../pages-react/SettingsPage'
import HistoryPage from '../pages-react/HistoryPage'
import BatchPage from '../pages-react/BatchPage'
import StoryboardSplitPage from '../pages-react/StoryboardSplitPage'
import SmartErasePage from '../pages-react/SmartErasePage'
import { ToastContainer } from '../components/Toast'
import { GenerateTokenBridge } from './components/GenerateTokenBridge'
import { GeneratePromptHelperBar } from './components/GeneratePromptHelperBar'
import { ComparePromptHelperBar } from './components/ComparePromptHelperBar'
import { TemplateInline } from './components/TemplateInline'

const AgentWorkspacePage = lazy(() => import('../pages-react/AgentWorkspacePage'))
const MarketplacePage = lazy(() => import('../pages-react/MarketplacePage'))

let root: Root | null = null
let settingsRoot: Root | null = null
let historyRoot: Root | null = null
let batchRoot: Root | null = null
let storyboardSplitRoot: Root | null = null
let smartEraseRoot: Root | null = null
let agentWorkspaceRoot: Root | null = null
let marketplaceRoot: Root | null = null
let toastRoot: Root | null = null
let generateTokenRoot: Root | null = null
let generateTemplateRoot: Root | null = null
let generatePromptHelperRoot: Root | null = null
let comparePromptHelperRoot: Root | null = null

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

export function mountGenerateTemplateInline(): void {
  const container = document.getElementById('generate-template-mount')
  if (!container) {
    console.warn('[React] generate-template-mount not found')
    return
  }
  if (!generateTemplateRoot) {
    generateTemplateRoot = createRoot(container)
    generateTemplateRoot.render(<TemplateInline context="generate" />)
    console.log('[React] GenerateTemplateInline mounted')
  }
}

export function unmountGenerateTemplateInline(): void {
  if (generateTemplateRoot) {
    generateTemplateRoot.unmount()
    generateTemplateRoot = null
    console.log('[React] GenerateTemplateInline unmounted')
  }
}

/**
 * GeneratePromptHelperBar: 在图生图页提示词输入框下方挂载
 * [多角度] [打光] 按钮，桥接 vanilla GeneratePage 的参考图状态
 * 与 #promptInput textarea。
 */
export function mountGeneratePromptHelper(): void {
  const container = document.getElementById('generate-prompt-helper-mount')
  if (!container) {
    console.warn('[React] generate-prompt-helper-mount not found')
    return
  }
  if (!generatePromptHelperRoot) {
    generatePromptHelperRoot = createRoot(container)
    generatePromptHelperRoot.render(<GeneratePromptHelperBar />)
    console.log('[React] GeneratePromptHelperBar mounted')
  }
}

export function unmountGeneratePromptHelper(): void {
  if (generatePromptHelperRoot) {
    generatePromptHelperRoot.unmount()
    generatePromptHelperRoot = null
    console.log('[React] GeneratePromptHelperBar unmounted')
  }
}

/**
 * ComparePromptHelperBar: 在模型对比页提示词输入框下方挂载
 * [多角度] [打光] 按钮，桥接 vanilla ComparePage 的参考图状态
 * 与 #comparePrompt textarea。
 */
export function mountComparePromptHelper(): void {
  const container = document.getElementById('compare-prompt-helper-mount')
  if (!container) {
    console.warn('[React] compare-prompt-helper-mount not found')
    return
  }
  if (!comparePromptHelperRoot) {
    comparePromptHelperRoot = createRoot(container)
    comparePromptHelperRoot.render(<ComparePromptHelperBar />)
    console.log('[React] ComparePromptHelperBar mounted')
  }
}

export function unmountComparePromptHelper(): void {
  if (comparePromptHelperRoot) {
    comparePromptHelperRoot.unmount()
    comparePromptHelperRoot = null
    console.log('[React] ComparePromptHelperBar unmounted')
  }
}

export function mountStoryboardSplitReact(): void {
  const container = document.getElementById('storyboard-split-react-root')
  if (!container) {
    console.warn('[React] storyboard-split-react-root not found')
    return
  }
  if (!storyboardSplitRoot) {
    storyboardSplitRoot = createRoot(container)
    storyboardSplitRoot.render(
      <Suspense fallback={null}>
        <StoryboardSplitPage />
      </Suspense>
    )
    console.log('[React] StoryboardSplitPage mounted (first time)')
  }
  container.style.display = ''
}

export function unmountStoryboardSplitReact(): void {
  const container = document.getElementById('storyboard-split-react-root')
  if (container) {
    container.style.display = 'none'
  }
}

/**
 * SmartErasePage 同样只渲染一次，之后切 tab 只切 display 可见性。
 */
export function mountSmartEraseReact(): void {
  const container = document.getElementById('smart-erase-react-root')
  if (!container) {
    console.warn('[React] smart-erase-react-root not found')
    return
  }
  if (!smartEraseRoot) {
    smartEraseRoot = createRoot(container)
    smartEraseRoot.render(
      <Suspense fallback={null}>
        <SmartErasePage />
      </Suspense>
    )
    console.log('[React] SmartErasePage mounted (first time)')
  }
  container.style.display = ''
}

export function unmountSmartEraseReact(): void {
  const container = document.getElementById('smart-erase-react-root')
  if (container) {
    container.style.display = 'none'
  }
}

export function mountAgentWorkspaceReact(): void {
  const container = document.getElementById('agent-workspace-react-root')
  if (!container) {
    console.warn('[React] agent-workspace-react-root not found')
    return
  }
  if (!agentWorkspaceRoot) {
    agentWorkspaceRoot = createRoot(container)
    agentWorkspaceRoot.render(
      <Suspense fallback={null}>
        <AgentWorkspacePage />
      </Suspense>
    )
    console.log('[React] AgentWorkspacePage mounted (first time)')
  }
  container.style.display = ''
}

export function unmountAgentWorkspaceReact(): void {
  const container = document.getElementById('agent-workspace-react-root')
  if (container) {
    container.style.display = 'none'
  }
}

export function mountMarketplaceReact(): void {
  const container = document.getElementById('marketplace-react-root')
  if (!container) {
    console.warn('[React] marketplace-react-root not found')
    return
  }
  if (!marketplaceRoot) {
    marketplaceRoot = createRoot(container)
    marketplaceRoot.render(
      <Suspense fallback={null}>
        <MarketplacePage />
      </Suspense>
    )
    console.log('[React] MarketplacePage mounted (first time)')
  }
  container.style.display = ''
}

export function unmountMarketplaceReact(): void {
  const container = document.getElementById('marketplace-react-root')
  if (container) {
    container.style.display = 'none'
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
