import { createRoot, Root } from 'react-dom/client'
import { DirectorApp } from './DirectorApp'
import { useDirectorStore } from './stores/useDirectorStore'

let root: Root | null = null

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
