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

export interface AgentStreamEvent {
  type:
    | 'thread_created'
    | 'message_delta'
    | 'reasoning_delta'
    | 'tool_call_start'
    | 'tool_call_end'
    | 'artifact_created'
    | 'turn_completed'
    | 'error'
    | 'cancelled'
  threadId: string
  turnId?: string
  delta?: string
  tool?: AgentToolEvent
  artifact?: AgentArtifact
  error?: string
}

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
