import { useEffect, useRef, useState } from 'react'
import { useChatScroll } from './useChatScroll'
import { AttachmentChips } from './AttachmentChips'
import { CloseIcon, GearIcon, PanelCollapseRightIcon, PanelExpandLeftIcon } from './icons'
import { Lightbox } from './Lightbox'
import { MentionInput } from './MentionInput'
import { PetOverlay } from './pets/PetOverlay'
import { MessageBubble } from './MessageBubble'
import { ResizableHandle } from './ResizableHandle'
import { RewoundTurnsDrawer } from './RewoundTurnsDrawer'
import { ThreadCommandPalette } from './ThreadCommandPalette'
import { ThreadSidebar } from './ThreadSidebar'
import { GoalChip } from './GoalChip'
import { TokenUsageMeter } from './TokenUsageMeter'
import { CodexApprovalPrompt } from './CodexApprovalPrompt'
import { CodexPermissionsPanel } from './CodexPermissionsPanel'
import { CodexStatusPanel } from './CodexStatusPanel'
import { NoticesBanner } from './NoticesBanner'
import { defaultContextWindowForModel } from '../../../../shared/modelSettings'
import { findModel, resolveModelSelection } from './models'
import { createEventCoalescer } from './eventCoalescer'
import { useAgentChatStore } from './store'
import { useAgentWorkspaceStore } from '../agent-workspace/useAgentWorkspaceStore'
import { FileExplorerPanel } from '../file-explorer/FileExplorerPanel'
import { useFileExplorerStore } from '../file-explorer/store'
import { FileTreeIcon } from '../file-explorer/icons'
import { useTabStore } from '../../stores/useTabStore'
import { getAgentApi } from '../../utils/agentBridge'
import type {
  AgentStreamEvent,
  CodexSessionConfig,
  CodexSessionStatus,
} from '../../../../types/agent'

function isValidContextWindow(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

export function AgentChatPanel() {
  const isOpen = useAgentChatStore((state) => state.isOpen)
  const messages = useAgentChatStore((state) => state.messages)
  const threadId = useAgentChatStore((state) => state.threadId)
  const editingMessageId = useAgentChatStore((state) => state.editingMessageId)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const { onScroll: onChatScroll } = useChatScroll({
    containerRef: chatScrollRef,
    threadId,
    messages,
    isOpen,
  })
  const error = useAgentChatStore((state) => state.error)
  const applyEvent = useAgentChatStore((state) => state.applyEvent)
  const addApprovalRequest = useAgentChatStore((state) => state.addApprovalRequest)
  const applyGoalEvent = useAgentChatStore((state) => state.applyGoalEvent)
  const refreshGoal = useAgentChatStore((state) => state.refreshGoal)
  const activeGoal = useAgentChatStore((state) => (threadId ? state.goalByThread[threadId] : null))
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
  const loadModelSettingsCatalog = useAgentChatStore(
    (state) => state.loadModelSettingsCatalog,
  )
  const selectedModelId = useAgentChatStore((state) => state.selectedModelId)
  const modelSettingsCatalog = useAgentChatStore(
    (state) => state.modelSettingsCatalog,
  )
  const modelContextWindowByModel = useAgentChatStore(
    (state) => state.modelContextWindowByModel,
  )
  const activeModelContextWindow = useAgentChatStore(
    (state) => state.activeModelContextWindow,
  )
  const fxOpen = useFileExplorerStore((state) => state.fxOpen)
  const toggleFx = useFileExplorerStore((state) => state.toggleFx)
  const setFxOpen = useFileExplorerStore((state) => state.setFxOpen)
  const [codexStatus, setCodexStatus] = useState<CodexSessionStatus | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const settingsPopoverRef = useRef<HTMLDivElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const configDirty = useAgentWorkspaceStore((state) => state.configDirty)

  // The agent:event subscription is bound to the AgentChatPanel mount, NOT to
  // isOpen — otherwise hiding the panel cancels the IPC listener and every
  // Codex stream event that arrives while the panel is collapsed is lost,
  // forcing the user to F5 to recover. Mirrors the onApprovalRequest pattern
  // below.
  useEffect(() => {
    const agent = getAgentApi()
    if (!agent) return undefined
    // Coalesce high-frequency `item_delta` events to one apply per frame so a
    // fast token stream no longer triggers a zustand set()/re-render per token.
    // Structural/terminal events flush immediately (order-preserving), so the
    // authoritative final text (item_completed) is never delayed. See
    // eventCoalescer.ts + openai/codex#15759 (deltas arrive at model speed).
    const coalescer = createEventCoalescer<AgentStreamEvent>(applyEvent)
    const unsubscribe = agent.onEvent?.((event) => coalescer.push(event))
    return () => {
      unsubscribe?.()
      coalescer.dispose()
    }
  }, [applyEvent])

  useEffect(() => {
    const agent = getAgentApi()
    return agent?.onApprovalRequest?.(addApprovalRequest)
  }, [addApprovalRequest])

  // Native `/goal`: live goal status stream (thread/goal/updated|cleared).
  // Mount-bound like onEvent so updates aren't lost while the panel is hidden.
  useEffect(() => {
    const agent = getAgentApi()
    return agent?.onGoal?.(applyGoalEvent)
  }, [applyGoalEvent])

  // Refresh the active thread's goal on open / thread switch so the chip
  // reflects a goal set in a prior session (notifications only cover live
  // changes; this covers the initial read).
  useEffect(() => {
    if (!isOpen || !threadId) return
    void refreshGoal(threadId)
  }, [isOpen, threadId, refreshGoal])

  // Restore the most recent thread + thread list on first open.
  useEffect(() => {
    if (!isOpen) return
    void bootstrap()
    void loadModelSettingsCatalog()
  }, [isOpen, bootstrap, loadModelSettingsCatalog])

  useEffect(() => {
    if (!isOpen) return
    const agent = getAgentApi()
    void agent?.getSessionStatus?.().then(setCodexStatus).catch(() => undefined)
  }, [isOpen])

  // Re-read the status whenever the gear popover opens so the draft reflects
  // changes applied elsewhere (e.g. the Agent Workspace Permissions tab).
  useEffect(() => {
    if (!settingsOpen) return
    const agent = getAgentApi()
    void agent?.getSessionStatus?.().then(setCodexStatus).catch(() => undefined)
  }, [settingsOpen])

  // Light-dismiss for the settings popover: clicking anywhere outside the
  // popover (and outside its toggle button, which handles its own toggling)
  // closes it.
  useEffect(() => {
    if (!settingsOpen) return undefined
    function onMouseDown(event: MouseEvent): void {
      const target = event.target as Node
      if (settingsPopoverRef.current?.contains(target)) return
      if (settingsButtonRef.current?.contains(target)) return
      setSettingsOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [settingsOpen])

  async function applySessionConfig(
    patch: Partial<CodexSessionConfig>,
    options?: { persist?: boolean },
  ): Promise<void> {
    const agent = getAgentApi()
    if (!agent?.setSessionConfig) {
      setError('Electron session config API is unavailable')
      return
    }
    try {
      // Forward options only when present — a trailing explicit `undefined`
      // would break strict call-shape assertions and older preload builds.
      const next = options
        ? await agent.setSessionConfig(patch, options)
        : await agent.setSessionConfig(patch)
      if (next) {
        setCodexStatus(next)
      } else {
        await agent.getSessionStatus?.().then(setCodexStatus)
      }
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function resetSessionConfig(): Promise<void> {
    const agent = getAgentApi()
    if (!agent?.resetSessionConfig) {
      setError('Electron session config API is unavailable')
      return
    }
    try {
      const next = await agent.resetSessionConfig()
      if (next) {
        setCodexStatus(next)
      } else {
        await agent.getSessionStatus?.().then(setCodexStatus)
      }
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function resetMemory(): Promise<{ ok: boolean; error?: string }> {
    const agent = getAgentApi()
    if (!agent?.resetMemory) {
      return { ok: false, error: 'Electron memory reset API is unavailable' }
    }
    try {
      return await agent.resetMemory()
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function restartCodex(): Promise<void> {
    const agent = getAgentApi()
    if (!agent?.restartCodex) {
      setError('Electron agent restart API is unavailable')
      return
    }
    try {
      const result = await agent.restartCodex()
      if (!result.ok) {
        setError(result.error ?? 'Failed to restart Codex')
        return
      }
      useAgentWorkspaceStore.getState().setConfigDirty(false)
      void agent.getSessionStatus?.().then(setCodexStatus).catch(() => undefined)
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
  const canonicalModel = resolveModelSelection(selectedModelId).model
  const runtimeModel = modelSettingsCatalog?.models.find(
    (model) => model.id === canonicalModel,
  )
  const rememberedContextWindow = modelContextWindowByModel[canonicalModel]
  const runtimeDefaultContextWindow =
    runtimeModel?.capabilities.defaultContextWindow
  const fallbackContextWindow = isValidContextWindow(activeModelContextWindow)
    ? activeModelContextWindow
    : isValidContextWindow(rememberedContextWindow)
      ? rememberedContextWindow
      : isValidContextWindow(runtimeDefaultContextWindow)
        ? runtimeDefaultContextWindow
        : defaultContextWindowForModel(canonicalModel)

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
              <TokenUsageMeter
                usage={tokenUsage}
                fallbackContextWindow={fallbackContextWindow}
              />
              <button
                ref={settingsButtonRef}
                type="button"
                aria-label="Codex 设置"
                title="Codex 设置"
                aria-expanded={settingsOpen}
                onClick={() => setSettingsOpen((open) => !open)}
                className={
                  'inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-zinc-700/60 bg-zinc-900/60 transition-colors duration-200 hover:border-cyan-300/50 hover:bg-cyan-400/10 hover:text-cyan-100 ' +
                  (settingsOpen ? 'border-cyan-300/50 text-cyan-100' : 'text-zinc-400')
                }
              >
                <GearIcon className="h-4 w-4" />
              </button>
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
          <div className="mt-2 flex items-center justify-between gap-3 font-mono text-xs text-zinc-400">
            <span>
              {`Codex · ${codexStatus?.sandboxMode ?? '?'} · ${codexStatus?.approvalPolicy ?? '?'} · ${codexStatus?.webSearch ?? '?'}`}
            </span>
            <span className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  useFileExplorerStore.getState().openCanvasTab()
                  // Hook: user-initiated open → make Codex canvas-aware on the
                  // next turn (Codex's own canvas_open path does not fire this).
                  useAgentChatStore.getState().notifyCanvasOpened()
                }}
                className="cursor-pointer text-cyan-300 hover:text-cyan-100"
              >
                画布
              </button>
              <button
                type="button"
                onClick={() => {
                  useTabStore.getState().switchTab('agentWorkspace')
                  useAgentChatStore.setState({ isOpen: false })
                }}
                className="cursor-pointer text-cyan-300 hover:text-cyan-100"
              >
                Open Agent Workspace
              </button>
            </span>
          </div>
          {configDirty ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
              <span>Codex config changed - restart to apply</span>
              <button
                type="button"
                onClick={() => void restartCodex()}
                className="cursor-pointer text-amber-200 underline"
              >
                Restart Codex
              </button>
            </div>
          ) : null}
          {activeGoal ? <GoalChip goal={activeGoal} /> : null}
        </header>

        {/* Gear popover: zero-height relative wrapper keeps the overlay glued
            to the header's bottom edge no matter how many banner rows the
            header currently shows (configDirty / goal chip). */}
        {settingsOpen ? (
          <div className="relative z-30 h-0">
            <div
              ref={settingsPopoverRef}
              data-testid="codex-settings-popover"
              className="absolute right-3 top-2 max-h-[70vh] w-[min(560px,calc(100%-24px))] overflow-y-auto rounded-xl border border-cyan-400/25 bg-zinc-950/95 p-3 pt-1 shadow-[0_16px_48px_rgba(0,0,0,0.6),0_0_0_1px_rgba(34,211,238,0.08)] backdrop-blur"
            >
              <CodexPermissionsPanel
                status={codexStatus}
                onApply={applySessionConfig}
                onReset={resetSessionConfig}
                onResetMemory={resetMemory}
              />
            </div>
          </div>
        ) : null}

        <div
          ref={chatScrollRef}
          onScroll={onChatScroll}
          className="chat-scroll flex-1 overflow-y-scroll px-4 py-4"
        >
          <NoticesBanner />
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
          {messages.map((message) =>
            message.id === editingMessageId ? (
              // Inline edit mode: render the *exact same* MentionInput at
              // the message's position so the user gets every feature
              // (model picker, file refs, $/@/// triggers, drag-drop) for
              // free. The footer composer is hidden below for the duration.
              <div
                key={message.id}
                className="my-3 rounded-lg border border-cyan-400/30 bg-zinc-950/60 p-3 shadow-[0_0_0_1px_rgba(34,211,238,0.08)]"
              >
                <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.18em] text-cyan-300/80">
                  <span>Editing message</span>
                  <span className="text-zinc-500 normal-case tracking-normal">
                    Esc to cancel · ⌘/Ctrl+Enter to submit
                  </span>
                </div>
                <AttachmentChips />
                <MentionInput />
              </div>
            ) : (
              <MessageBubble key={message.id} message={message} />
            ),
          )}
          {error ? (
            <div className="mt-3 rounded-xl border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
              {error}
            </div>
          ) : null}
        </div>

        {/* Footer composer hides while inline-editing — there's only one
            MentionInput in the tree, and it's been re-parented to the
            message position above. The rewound-turns drawer renders just
            above the composer so users can find their stash without
            scrolling away from the input. */}
        {editingMessageId ? null : (
          <footer className="relative border-t border-cyan-400/20 p-3">
            {/* Codex 风格环境宠物:蹲在 composer 上方,随 agent 状态换动画 */}
            <PetOverlay />
            <RewoundTurnsDrawer />
            <AttachmentChips />
            <MentionInput />
          </footer>
        )}
      </aside>
      <FileExplorerPanel rightOffset={panelWidth + (sidebarOpen ? sidebarWidth : 0)} />
      <ThreadSidebar />
      <Lightbox />
      <ThreadCommandPalette />
    </>
  )
}
