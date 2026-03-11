import { createRoot, type Root } from 'react-dom/client'
import { StoryboardAnalysisApp } from './StoryboardAnalysisApp'
import { useStoryboardStore } from './stores/useStoryboardStore'

let root: Root | null = null
let mountedContainer: HTMLElement | null = null

interface MountStoryboardReactOptions {
  reset?: boolean
}

export function mountStoryboardReact(
  container: HTMLElement,
  options: MountStoryboardReactOptions = {},
): void {
  if (options.reset !== false) {
    useStoryboardStore.getState().resetProgress()
  }
  if (root && mountedContainer !== container) {
    root.unmount()
    root = null
  }
  if (!root) {
    root = createRoot(container)
    mountedContainer = container
  }
  root.render(<StoryboardAnalysisApp />)
  console.log('[React] StoryboardAnalysisApp mounted')
}

export function unmountStoryboardReact(): void {
  if (root) {
    root.unmount()
    root = null
    mountedContainer = null
    console.log('[React] StoryboardAnalysisApp unmounted')
  }
}

export { useStoryboardStore }
