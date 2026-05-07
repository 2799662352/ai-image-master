import type { AgentStreamEvent } from '../../types/agent'

/**
 * Codex `app-server` emits a long list of notifications during a turn (see
 * {@link https://github.com/openai/codex generated `ServerNotification` union}).
 * Most are bookkeeping/observability and don't map onto our renderer event
 * stream, so we silently drop them. The ones that DO matter are translated
 * here.
 *
 * One subtlety: when the model produces text, Codex usually sends a stream of
 * `item/agentMessage/delta` chunks AND a final `item/completed` carrying the
 * same `agentMessage` item with the full `text`. We must NOT emit a
 * `message_delta` from both — that doubles the message in the renderer.
 *
 * Strategy: track each `itemId` that produced a streaming delta. On
 * `item/completed` for an `agentMessage`:
 *   - If we already streamed deltas for that itemId → drop (renderer already
 *     has the full text accumulated).
 *   - Otherwise → emit a single `message_delta` with the full `text` as a
 *     fallback for non-streaming providers.
 *
 * Pure functions / per-instance state make this trivial to test without
 * spinning up a WebSocket.
 */
export class CodexNotificationRouter {
  private readonly streamedDeltaItemIds = new Set<string>()

  route(method: string, params: Record<string, any>): AgentStreamEvent | null {
    switch (method) {
      case 'item/agentMessage/delta': {
        if (typeof params.itemId === 'string' && params.itemId.length > 0) {
          this.streamedDeltaItemIds.add(params.itemId)
        }
        return {
          type: 'message_delta',
          threadId: params.threadId,
          turnId: params.turnId,
          delta: params.delta ?? '',
        }
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return {
          type: 'reasoning_delta',
          threadId: params.threadId,
          turnId: params.turnId,
          delta: params.delta ?? '',
        }

      case 'turn/completed':
        return {
          type: 'turn_completed',
          threadId: params.threadId,
          turnId: params.turn?.id,
        }

      case 'error':
        return {
          type: 'error',
          threadId: params.threadId,
          turnId: params.turnId,
          error: params.error?.message ?? 'codex error',
        }

      case 'item/completed': {
        const item = params.item as { type?: string; id?: string; text?: string } | undefined
        if (!item || item.type !== 'agentMessage') return null
        if (typeof item.id === 'string' && this.streamedDeltaItemIds.has(item.id)) {
          // Already streamed — renderer has accumulated the same text.
          return null
        }
        if (typeof item.text !== 'string' || item.text.length === 0) return null
        return {
          type: 'message_delta',
          threadId: params.threadId,
          turnId: params.turnId,
          delta: item.text,
        }
      }

      default:
        return null
    }
  }
}
