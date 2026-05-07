import type { TimelineItem } from './agent-timeline'

export type AgentRole = 'user' | 'assistant' | 'system' | 'tool'
export type AgentToolStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'
export type AgentArtifactType = 'image' | 'file' | 'link'

export interface AgentAttachmentInput {
  name: string
  mime: string
  size: number
  path?: string
  buffer?: ArrayBuffer
}

export interface AgentSendMessagePayload {
  threadId?: string
  content: string
  attachments: AgentAttachmentInput[]
  currentPage?: string
  /**
   * Caller-selected model id (e.g. `gpt-4.1`, `o4-mini`). When omitted the
   * main process falls back to its default. Forwarded to Codex's `turn/start`
   * via `AgentManager.sendMessage`.
   */
  model?: string
}

export interface AgentCancelPayload {
  threadId: string
}

export interface AgentThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export interface AgentArtifact {
  id: string
  type: AgentArtifactType
  uri: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AgentToolEvent {
  id: string
  name: string
  status: AgentToolStatus
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}

export type ItemDeltaPatch =
  | { kind: 'appendText'; field: 'content' | 'stdout' | 'stderr'; text: string }
  | { kind: 'mergeFields'; fields: Record<string, unknown> }

export interface AgentTokenUsageDelta {
  /** Per-turn input tokens. */
  inputTokens: number
  /** Per-turn output tokens. */
  outputTokens: number
  /** Per-turn reasoning tokens (subset of output). */
  reasoningTokens?: number
  /** Per-turn cached input tokens. */
  cachedInputTokens?: number
}

export interface AgentTokenUsage {
  /** Cumulative input tokens consumed in this thread. */
  inputTokens: number
  /** Cumulative output tokens emitted in this thread. */
  outputTokens: number
  /** Cumulative reasoning tokens (subset of output for reasoning-capable models). */
  reasoningTokens?: number
  /** Cached input tokens for this turn (provider-side prompt caching). */
  cachedInputTokens?: number
  /** Hard context window for the active model, in tokens. Optional because some gateways omit it. */
  contextWindow?: number
  /**
   * Tokens currently considered "in the prompt" — used to drive the context
   * usage meter and signal when Codex will compact. Falls back to
   * `inputTokens + outputTokens` if the gateway doesn't report it explicitly.
   */
  contextUsage?: number
  /**
   * Per-turn delta from Codex's `tokenUsage.last` slice. Cumulative fields
   * above describe the whole thread; `last` describes only the most-recent
   * turn so the popover can render "Last turn: +1.3K / +234". Omitted when
   * the gateway didn't send a `last` slice or when the slice carried only
   * zeroes (treated as "no signal" — we never fabricate per-turn data).
   */
  last?: AgentTokenUsageDelta
}

export interface AgentStreamEventBase {
  threadId: string
  turnId?: string
}

export type AgentStreamEvent =
  | (AgentStreamEventBase & { type: 'thread_created' })
  | (AgentStreamEventBase & { type: 'item_started'; itemId: string; itemType: TimelineItem['type']; payload: Record<string, unknown> })
  | (AgentStreamEventBase & { type: 'item_delta'; itemId: string; itemType: TimelineItem['type']; patch: ItemDeltaPatch })
  | (AgentStreamEventBase & { type: 'item_completed'; itemId: string; itemType: TimelineItem['type']; final: Record<string, unknown> })
  | (AgentStreamEventBase & { type: 'turn_completed' })
  | (AgentStreamEventBase & { type: 'token_usage_updated'; usage: AgentTokenUsage })
  | (AgentStreamEventBase & { type: 'error'; error: string })
  | (AgentStreamEventBase & { type: 'cancelled' })

export interface AgentToolRequest {
  id: string
  toolName: string
  params: Record<string, unknown>
}

export interface AgentToolResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * Shape returned by the renderer-facing agent IPC calls that don't have a
 * domain-specific payload (`agent:set-api-key`, `agent:test-connection`).
 * Kept narrow on purpose — main and preload both import this so their
 * signatures stay in lock-step.
 */
export interface AgentApiResult {
  ok: boolean
  error?: string
}
