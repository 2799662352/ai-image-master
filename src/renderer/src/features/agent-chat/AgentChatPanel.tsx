import { useEffect, useState } from 'react'
import { AttachmentChips } from './AttachmentChips'
import { CloseIcon, PanelCollapseRightIcon, PanelExpandLeftIcon } from './icons'
import { Lightbox } from './Lightbox'
import { MentionInput } from './MentionInput'
import { MessageBubble } from './MessageBubble'
import { ResizableHandle } from './ResizableHandle'
import { ThreadCommandPalette } from './ThreadCommandPalette'
import { ThreadSidebar } from './ThreadSidebar'
import { TokenUsageMeter } from './TokenUsageMeter'
import { CodexApprovalPrompt } from './CodexApprovalPrompt'
import { CodexMcpPanel } from './CodexMcpPanel'
import { CodexPermissionsPanel } from './CodexPermissionsPanel'
import { CodexSkillsPanel } from './CodexSkillsPanel'
import { CodexStatusPanel } from './CodexStatusPanel'
import { findModel } from './models'
import { useAgentChatStore } from './store'
import { FileExplorerPanel } from '../file-explorer/FileExplorerPanel'
import { useFileExplorerStore } from '../file-explorer/store'
import { FileTreeIcon } from '../file-explorer/icons'
import type {
  AgentStreamEvent,
  CodexApprovalRequest,
  CodexSessionConfig,
  CodexSessionStatus,
} from '../../../../types/agent'

type AgentEventApi = {
  agent?: {
    onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
    onApprovalRequest?: (handler: (request: CodexApprovalRequest) => void) => () => void
    getSessionStatus?: () => Promise<CodexSessionStatus>
    setSessionConfig?: (patch: Partial<CodexSessionConfig>) => Promise<CodexSessionStatus>
  }
}

export function AgentChatPanel() {
  const isOpen = useAgentChatStore((state) => state.isOpen)
  const messages = useAgentChatStore((state) => state.messages)
  const error = useAgentChatStore((state) => state.error)
  const applyEvent = useAgentChatStore((state) => state.applyEvent)
  const addApprovalRequest = useAgentChatStore((state) => state.addApprovalRequest)
  const pendingApprovals = useAgentChatStore((state) => state.pendingApprovals)
  const respondToApproval = useAgentChatStore((state) => state.respondToApproval)
  const setError = useAgentChatStore((state) => state.setError)
  const panelWidth = useAgentChatStore((state) => state.panelWidth)
  const setPanelWidth = useAgentChatStore((state) => state.setPanelWidth)
  const tokenUsage = useAgentChatStore((state) => state.tokenUsage)
  const sidebarOpen = useAgentChatStore((state) => state.sidebarOpen)
  const sidebarWidth = useAgentChatStore((state) => state.sidebarWidth)
  const toggleSidebar = useAgentChatStore((state) => state.toggleSidebar)
  const bootstrap = useAgentChatStore((state) => state.bootstrap)
  const selectedModelId = useAgentChatStore((state) => state.selectedModelId)
  const fxOpen = useFileExplorerStore((state) => state.fxOpen)
  const toggleFx = useFileExplorerStore((state) => state.toggleFx)
  const setFxOpen = useFileExplorerStore((state) => state.setFxOpen)
  const [codexStatus, setCodexStatus] = useState<CodexSessionStatus | undefined>(undefined)

  useEffect(() => {
    if (!isOpen) return undefined
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    if (!agent) return undefined
    return agent.onEvent(applyEvent)
  }, [applyEvent, isOpen])

  useEffect(() => {
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    return agent?.onApprovalRequest?.(addApprovalRequest)
  }, [addApprovalRequest])

  // Restore the most recent thread + thread list on first open.
  useEffect(() => {
    if (!isOpen) return
    void bootstrap()
  }, [isOpen, bootstrap])

  useEffect(() => {
    if (!isOpen) return
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    void agent?.getSessionStatus?.().then(setCodexStatus).catch(() => undefined)
  }, [isOpen])

  async function applySessionConfig(patch: Partial<CodexSessionConfig>): Promise<void> {
    const agent = (window as Window & { electronAPI?: AgentEventApi }).electronAPI?.agent
    if (!agent?.setSessionConfig) {
      setError('Electron agent permissions API is unavailable')
      return
    }
    try {
      const nextStatus = await agent.setSessionConfig(patch)
      setCodexStatus(nextStatus)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Cmd/Ctrl+B → toggle sidebar (only when panel is open, otherwise we'd be
  // stealing a global shortcut from the rest of the app for no reason).
  useEffect(() => {
    if (!isOpen) return undefined
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'i') {
        e.preventDefault()
        toggleFx()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [isOpen, toggleFx, toggleSidebar])

  useEffect(() => {
    if (!isOpen && fxOpen) setFxOpen(false)
  }, [isOpen, fxOpen, setFxOpen])

  // Sidebar lives inside the panel: when the panel is collapsed the entire
  // right-edge stack disappears, and when the sidebar is collapsed the chat
  // panel slides flush against the right edge (no 24px rail residue).
  const panelRightOffset = sidebarOpen ? sidebarWidth : 0

  if (!isOpen) {
    return (
      <>
        <Lightbox />
        <ThreadCommandPalette />
      </>
    )
  }

  return (
    <>
      <aside
        data-testid="agent-chat-panel"
        // NOTE: do NOT add `relative` here. Tailwind's `.relative` is defined
        // after `.fixed` in the generated stylesheet, so when both classes
        // appear together `position: relative` wins the cascade — the panel
        // then leaves viewport-pinned mode, flows to the document tail, and
        // ends up rendered at the bottom of the page (regression "又跑下面去了").
        className="fixed top-0 z-[40000] flex h-screen flex-col border-l border-cyan-400/25 bg-zinc-950/95 text-white shadow-[-24px_0_80px_rgba(34,211,238,0.16)] backdrop-blur transition-[right] duration-200 ease-out"
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
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.32em] text-cyan-300/70">local codex</p>
              <h2 className="truncate text-sm font-semibold text-cyan-50">CATIMATION Agent</h2>
            </div>
            <div className="flex items-center gap-1.5">
              <CodexStatusPanel
                status={
                  codexStatus
                    ? {
                        ...codexStatus,
                        // Display the renderer-selected model so the panel
                        // matches what ModelPicker is actually sending. The
                        // main-process default is just a fallback for the
                        // label format.
                        model: findModel(selectedModelId)?.label ?? selectedModelId,
                      }
                    : undefined
                }
              />
              <TokenUsageMeter usage={tokenUsage} />
              <button
                type="button"
                aria-label={fxOpen ? 'Hide files' : 'Show files'}
                title={`${fxOpen ? 'Hide' : 'Show'} files (Ctrl/Cmd+Shift+I)`}
                onClick={() => toggleFx()}
                className={
                  'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 transition-colors duration-200 hover:border-cyan-300/50 hover:bg-cyan-400/10 hover:text-cyan-100 ' +
                  (fxOpen ? 'text-cyan-100' : 'text-zinc-400')
                }
              >
                <FileTreeIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                aria-label={sidebarOpen ? 'Hide thread sidebar' : 'Show thread sidebar'}
                title={sidebarOpen ? 'Hide threads (Ctrl/Cmd+B)' : 'Show threads (Ctrl/Cmd+B)'}
                onClick={() => toggleSidebar()}
                className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 text-zinc-400 transition-colors duration-200 hover:border-cyan-300/50 hover:bg-cyan-400/10 hover:text-cyan-100"
              >
                {sidebarOpen ? (
                  <PanelCollapseRightIcon className="h-4 w-4" />
                ) : (
                  <PanelExpandLeftIcon className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                aria-label="Close agent chat"
                title="Close (Esc)"
                onClick={() => useAgentChatStore.getState().toggle()}
                className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 text-zinc-400 transition-colors duration-200 hover:border-red-400/50 hover:bg-red-500/10 hover:text-red-200"
              >
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
          <CodexPermissionsPanel status={codexStatus} onApply={applySessionConfig} />
          <div className="mt-3 grid gap-3 xl:grid-cols-2">
            <CodexMcpPanel />
            <CodexSkillsPanel />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {pendingApprovals.length > 0 ? (
            <div className="mb-3 space-y-3">
              {pendingApprovals.map((request) => (
                <CodexApprovalPrompt
                  key={request.id}
                  request={request}
                  onRespond={(response) => respondToApproval(response)}
                />
              ))}
            </div>
          ) : null}
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
      <FileExplorerPanel rightOffset={panelWidth + (sidebarOpen ? sidebarWidth : 0)} />
      <ThreadSidebar />
      <Lightbox />
      <ThreadCommandPalette />
    </>
  )
}
