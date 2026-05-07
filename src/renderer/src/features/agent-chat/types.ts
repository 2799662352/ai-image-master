import type { AgentToolEvent } from '../../../../types/agent'

// Alias kept for legacy imports; new code uses Message from agent-timeline.
export type { Message as AgentChatMessage } from '../../../../types/agent-timeline'

// Removed in Task 14 once ToolCallCard.tsx is gone.
export type AgentChatToolEvent = AgentToolEvent
