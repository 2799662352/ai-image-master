import { useEffect } from 'react'
import { AttachmentChips } from './AttachmentChips'
import { Lightbox } from './Lightbox'
import { MentionInput } from './MentionInput'
import { MessageBubble } from './MessageBubble'
import { ResizableHandle } from './ResizableHandle'
import { ThreadCommandPalette } from './ThreadCommandPalette'
import { ThreadSidebar } from './ThreadSidebar'
import { TokenUsageMeter } from './TokenUsageMeter'
import { useAgentChatStore } from './store'
import type { AgentStreamEvent } from '../../../../types/agent'

type AgentEventApi = {
  agent?: {
    onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
  }
}

const SIDEBAR_RAIL_WIDTH = 24

export function AgentChatPanel() {
  const isOpen = useAgentChatStore((state) => state.isOpen)
  const messages = useAgentChatStore((state) => state.messages)
  const error = useAgentChatStore((state) => state.error)
  const applyEvent = useAgentChatStore((state) => state.applyEvent)
  const panelWidth = useAgentChatStore((state) => state.panelWidth)
  const setPanelWidth = useAgentChatStore((state) => state.setPanelWidth)
  const tokenUsage = useAgentChatStore((state) => state.tokenUsage)
  const sidebarOpen = useAgentChatStore((state) => state.sidebarOpen)
  const sidebarWidth = useAgentChatStore((state) => state.sidebarWidth)
  const toggleSidebar = useAgentChatStore((state) => state.toggleSidebar)
  const bootstrap = useAgentChatStore((state) => state.bootstrap)

  useEffect(() => {
    if (!isOpen) return undefined
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    if (!agent) return undefined
    return agent.onEvent(applyEvent)
  }, [applyEvent, isOpen])

  // Restore the most recent thread + thread list on first open.
  useEffect(() => {
    if (!isOpen) return
    void bootstrap()
  }, [isOpen, bootstrap])

  // Cmd/Ctrl+B → toggle sidebar.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggleSidebar])

  const panelRightOffset = sidebarOpen ? sidebarWidth : SIDEBAR_RAIL_WIDTH

  return (
    <>
      {isOpen ? (
        <aside
          data-testid="agent-chat-panel"
          // NOTE: do NOT add `relative` here. Tailwind's `.relative` is defined
          // after `.fixed` in the generated stylesheet, so when both classes
          // appear together `position: relative` wins the cascade — the panel
          // then leaves viewport-pinned mode, flows to the document tail, and
          // ends up rendered at the bottom of the page (regression "又跑下面去了").
          className="fixed top-0 z-[40000] flex h-screen flex-col border-l border-cyan-400/25 bg-zinc-950/95 text-white shadow-[-24px_0_80px_rgba(34,211,238,0.16)] backdrop-blur"
          style={{ width: panelWidth, right: panelRightOffset }}
        >
          <ResizableHandle
            panelRight={
              typeof window !== 'undefined' ? window.innerWidth - panelRightOffset : 0
            }
            onResize={(width) => setPanelWidth(width)}
            onResizeEnd={() => {}}
          />
          <header className="border-b border-cyan-400/20 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] uppercase tracking-[0.32em] text-cyan-300/70">local codex</p>
                <h2 className="text-sm font-semibold text-cyan-50">CATIMATION Agent</h2>
              </div>
              <div className="flex items-center gap-2">
                <TokenUsageMeter usage={tokenUsage} />
                <button
                  type="button"
                  aria-label={sidebarOpen ? 'Hide thread sidebar' : 'Show thread sidebar'}
                  title={sidebarOpen ? 'Hide threads (Cmd/Ctrl+B)' : 'Show threads (Cmd/Ctrl+B)'}
                  onClick={() => toggleSidebar()}
                  className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100"
                >
                  {sidebarOpen ? '⇥' : '⇤'}
                </button>
                <button
                  className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100"
                  onClick={() => useAgentChatStore.getState().toggle()}
                  type="button"
                >
                  x
                </button>
              </div>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4 text-sm text-zinc-300">
                Tell the agent what to create or inspect. It can call CATIMATION tools and use local Codex
                capabilities.
              </div>
            ) : null}
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
            {error ? (
              <div className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
                {error}
              </div>
            ) : null}
          </div>

          <footer className="border-t border-cyan-400/20 p-3">
            <AttachmentChips />
            <MentionInput />
          </footer>
        </aside>
      ) : null}
      <ThreadSidebar />
      <Lightbox />
      <ThreadCommandPalette />
    </>
  )
}
