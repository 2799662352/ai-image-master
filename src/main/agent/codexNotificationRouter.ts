import type { AgentStreamEvent } from '../../types/agent'
import { parseChange } from '../../shared/diffUtils'

export class CodexNotificationRouter {
  private readonly streamedDeltaItemIds = new Set<string>()

  route(method: string, params: Record<string, any>): AgentStreamEvent | null {
    switch (method) {
      case 'item/started': {
        const item = params.item as { type?: string; id?: string; command?: string; cwd?: string } | undefined
        if (!item?.type || !item?.id) return null
        switch (item.type) {
          case 'agentMessage':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'text',
              payload: {},
            }
          case 'reasoning':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              payload: {},
            }
          case 'commandExecution':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'shell',
              payload: {
                ...(item.command != null ? { command: item.command } : {}),
                ...(item.cwd != null ? { cwd: item.cwd } : {}),
              },
            }
          case 'fileChange':
            return {
              type: 'item_started',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              payload: {},
            }
          default:
            return null
        }
      }

      case 'item/agentMessage/delta': {
        const itemId = params.itemId as string | undefined
        if (typeof itemId === 'string' && itemId.length > 0) {
          this.streamedDeltaItemIds.add(itemId)
        }
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: itemId ?? '',
          itemType: 'text',
          patch: { kind: 'appendText', field: 'content', text: params.delta ?? '' },
        }
      }

      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: params.itemId ?? '',
          itemType: 'reasoning',
          patch: { kind: 'appendText', field: 'content', text: params.delta ?? '' },
        }

      case 'item/commandExecution/output': {
        const field = params.stream === 'stderr' ? 'stderr' : 'stdout'
        return {
          type: 'item_delta',
          threadId: params.threadId,
          itemId: params.itemId ?? '',
          itemType: 'shell',
          patch: { kind: 'appendText', field, text: params.data ?? '' },
        }
      }

      case 'item/completed': {
        const item = params.item as Record<string, any> | undefined
        if (!item?.type || !item?.id) return null

        switch (item.type) {
          case 'agentMessage': {
            if (this.streamedDeltaItemIds.has(item.id)) return null
            if (typeof item.text !== 'string' || item.text.length === 0) return null
            return {
              type: 'item_delta',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'text',
              patch: { kind: 'appendText', field: 'content', text: item.text },
            }
          }
          case 'commandExecution':
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'shell',
              final: { exitCode: item.exitCode },
            }
          case 'fileChange': {
            const rawChanges = Array.isArray(item.changes) ? item.changes : []
            const changes = rawChanges.map(parseChange)
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'fileEdit',
              final: { changes },
            }
          }
          case 'reasoning':
            return {
              type: 'item_completed',
              threadId: params.threadId,
              itemId: item.id,
              itemType: 'reasoning',
              final: {},
            }
          default:
            return null
        }
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
          error: params.error?.message ?? 'codex error',
        }

      default:
        return null
    }
  }
}
