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
