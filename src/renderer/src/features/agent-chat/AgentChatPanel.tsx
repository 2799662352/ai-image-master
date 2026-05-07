import { useEffect } from 'react'
import { AttachmentChips } from './AttachmentChips'
import { Lightbox } from './Lightbox'
import { MentionInput } from './MentionInput'
import { MessageBubble } from './MessageBubble'
import { ResizableHandle } from './ResizableHandle'
import { useAgentChatStore } from './store'
import type { AgentStreamEvent } from '../../../../types/agent'

type AgentEventApi = {
  agent?: {
    onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
  }
}

export function AgentChatPanel() {
  const isOpen = useAgentChatStore((state) => state.isOpen)
  const messages = useAgentChatStore((state) => state.messages)
  const error = useAgentChatStore((state) => state.error)
  const applyEvent = useAgentChatStore((state) => state.applyEvent)
  const panelWidth = useAgentChatStore((state) => state.panelWidth)
  const setPanelWidth = useAgentChatStore((state) => state.setPanelWidth)

  useEffect(() => {
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    if (!agent) return undefined
    return agent.onEvent(applyEvent)
  }, [applyEvent])

  if (!isOpen) return null

  return (
    <>
      <aside
        className="fixed right-0 top-0 z-[40000] flex h-screen flex-col border-l border-cyan-400/25 bg-zinc-950/95 text-white shadow-[-24px_0_80px_rgba(34,211,238,0.16)] backdrop-blur relative"
        style={{ width: panelWidth }}
      >
      <ResizableHandle
        panelRight={typeof window !== 'undefined' ? window.innerWidth : 0}
        onResize={(width) => setPanelWidth(width)}
        onResizeEnd={() => {}}
      />
      <header className="border-b border-cyan-400/20 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[10px] uppercase tracking-[0.32em] text-cyan-300/70">local codex</p>
            <h2 className="text-sm font-semibold text-cyan-50">CATIMATION Agent</h2>
          </div>
          <button
            className="rounded-full border border-zinc-700 px-2 py-1 text-zinc-400 hover:border-cyan-300/50 hover:text-cyan-100"
            onClick={() => useAgentChatStore.getState().toggle()}
            type="button"
          >
            x
          </button>
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
      <Lightbox />
    </>
  )
}
