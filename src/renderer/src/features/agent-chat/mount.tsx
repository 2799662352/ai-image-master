import { createRoot, type Root } from 'react-dom/client'
import { AgentChatPanel } from './AgentChatPanel'
import { mountAgentToolExecutor } from './AgentToolExecutor'
import { mountSeedanceTaskListener } from './SeedanceTaskListener'
import { useAgentChatStore } from './store'

let root: Root | null = null
let host: HTMLDivElement | null = null

export function mountAgentChatRuntime(): () => void {
  if (root) return () => undefined

  host = document.createElement('div')
  host.id = 'agent-chat-root'
  document.body.appendChild(host)

  root = createRoot(host)
  root.render(<AgentChatPanel />)

  const unmountToolExecutor = mountAgentToolExecutor()
  const unmountSeedanceListener = mountSeedanceTaskListener()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      useAgentChatStore.getState().toggle()
    }
  }
  window.addEventListener('keydown', onKeyDown)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    unmountSeedanceListener()
    unmountToolExecutor()
    root?.unmount()
    root = null
    host?.remove()
    host = null
  }
}
