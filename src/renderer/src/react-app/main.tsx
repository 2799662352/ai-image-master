import { createRoot, Root } from 'react-dom/client'
import { DirectorApp } from './DirectorApp'

let root: Root | null = null

export function mountDirectorReact(): void {
  const container = document.getElementById('director-react-root')
  if (!container) {
    console.warn('[React] director-react-root not found')
    return
  }
  if (!root) {
    root = createRoot(container)
  }
  root.render(<DirectorApp />)
  console.log('[React] DirectorApp mounted')
}

export function unmountDirectorReact(): void {
  if (root) {
    root.unmount()
    root = null
    console.log('[React] DirectorApp unmounted')
  }
}
