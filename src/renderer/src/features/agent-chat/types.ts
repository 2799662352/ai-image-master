import type { AgentToolEvent } from '../../../../types/agent'

// AgentChatMessage was the legacy flat message type. It is now an alias of the
// timeline-aware Message so existing imports keep compiling until Task 14
// finishes the cleanup pass. New code should import Message from
// `src/types/agent-timeline.ts` directly.
export type { Message as AgentChatMessage } from '../../../../types/agent-timeline'

// ToolCallCard.tsx still imports this until Task 14 deletes it. Keep the
// re-export in place — do not remove.
export type AgentChatToolEvent = AgentToolEvent
