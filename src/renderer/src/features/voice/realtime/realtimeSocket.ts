// src/renderer/src/features/voice/realtime/realtimeSocket.ts
/**
 * 千问实时接口的一条连接(识别、合成各开各的)。
 *
 * 真正的 WebSocket 在主进程(见 `src/main/voice/realtimeRelay.ts`),这里只把 IPC
 * 包成「发事件 / 收事件 / 关闭」。主进程在 `realtimeOpen` 返回前就可能推来首批
 * 事件,所以没人认领的 id 先缓存,认领时补发。
 */

import type { VoiceApi, VoiceRealtimeMessage, VoiceRealtimeModel } from '../../../../../types/voice'

export interface RealtimeEvent {
  type: string
  [key: string]: unknown
}

export interface RealtimeClose {
  code: number
  reason: string
}

export interface RealtimeHandlers {
  onEvent: (event: RealtimeEvent) => void
  onClose?: (close: RealtimeClose) => void
}

export interface RealtimeConnection {
  send: (event: RealtimeEvent) => void
  close: () => void
}

export type OpenRealtime = (model: VoiceRealtimeModel, handlers: RealtimeHandlers) => Promise<RealtimeConnection>

/** 未认领 id 最多缓存多少个;认领不了的通常是渲染层已放弃的连接。 */
const UNCLAIMED_LIMIT = 16

function parseEvent(data: string): RealtimeEvent | null {
  try {
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as RealtimeEvent).type === 'string') {
      return parsed as RealtimeEvent
    }
  } catch {
    // 上游只发 JSON;解析不了的直接丢。
  }
  return null
}

function newEventId(): string {
  return `event_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`
}

export function createRealtimeOpener(api: VoiceApi): OpenRealtime {
  const handlers = new Map<string, RealtimeHandlers>()
  const unclaimed = new Map<string, VoiceRealtimeMessage[]>()
  let unsubscribe: (() => void) | null = null

  function deliver(target: RealtimeHandlers, message: VoiceRealtimeMessage): void {
    if (message.kind === 'closed') {
      handlers.delete(message.id)
      target.onClose?.({ code: message.code, reason: message.reason })
      return
    }
    const event = parseEvent(message.data)
    if (event) target.onEvent(event)
  }

  function route(message: VoiceRealtimeMessage): void {
    const target = handlers.get(message.id)
    if (target) {
      deliver(target, message)
      return
    }
    const queue = unclaimed.get(message.id) ?? []
    queue.push(message)
    unclaimed.set(message.id, queue)
    while (unclaimed.size > UNCLAIMED_LIMIT) unclaimed.delete(unclaimed.keys().next().value!)
  }

  return async (model, connectionHandlers) => {
    unsubscribe ??= api.onRealtimeMessage(route)
    const result = await api.realtimeOpen(model)
    if (!result.ok) throw new Error(result.error)
    const { id } = result
    handlers.set(id, connectionHandlers)
    const backlog = unclaimed.get(id) ?? []
    unclaimed.delete(id)
    for (const message of backlog) {
      const target = handlers.get(id)
      if (target) deliver(target, message)
    }
    return {
      send: (event) => api.realtimeSend(id, JSON.stringify({ event_id: newEventId(), ...event })),
      close: () => {
        // 关闭确认仍会从主进程回来,由它触发 onClose。
        api.realtimeClose(id)
      },
    }
  }
}

let desktopOpener: OpenRealtime | null = null

/** 桌面客户端的实时连接;浏览器预览里没有主进程,直接报错。 */
export const openDesktopRealtime: OpenRealtime = (model, handlers) => {
  const api = window.electronAPI?.voice
  if (!api?.realtimeOpen) return Promise.reject(new Error('实时语音只在桌面客户端里可用'))
  desktopOpener ??= createRealtimeOpener(api)
  return desktopOpener(model, handlers)
}
