import type { AgentToolEvent } from '../../../../types/agent'

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

export type AgentChatToolEvent = AgentToolEvent
