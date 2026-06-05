// Pure logic for the Codex chat scroll state machine.
//
// State machine summary:
//   - Default per thread: followBottom = true (lock-to-bottom)
//   - User scrolls up past UNLOCK_THRESHOLD_PX → followBottom = false (free)
//   - User scrolls back into the threshold zone → followBottom = true (re-lock)
//   - sendMessage flips back to true unconditionally (handled in store, not here)
//   - Per-thread scrollTop + followBottom persists across panel toggle, thread
//     switch, AND application restart (localStorage).

export const CHAT_SCROLL_STORAGE_KEY = 'agent-chat:scroll-by-thread:v1'

// 48px matches the de-facto convention used by ChatGPT, Claude.ai, Cursor,
// VS Code Copilot Chat. Wide enough to absorb wheel inertia, narrow enough
// that a deliberate scroll-up unlocks.
export const CHAT_SCROLL_UNLOCK_THRESHOLD_PX = 48

export type ChatScrollState = {
  scrollTop: number
  followBottom: boolean
}

export type ChatScrollByThread = Record<string, ChatScrollState>

export function distanceFromBottom(input: {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}): number {
  const raw = input.scrollHeight - input.scrollTop - input.clientHeight
  return raw < 0 ? 0 : raw
}

export function computeFollowBottom(distance: number): boolean {
  return distance <= CHAT_SCROLL_UNLOCK_THRESHOLD_PX
}

function isValidState(value: unknown): value is ChatScrollState {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.scrollTop === 'number' && typeof v.followBottom === 'boolean'
}

export function loadChatScrollByThread(): ChatScrollByThread {
  try {
    const raw = globalThis.localStorage?.getItem(CHAT_SCROLL_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ChatScrollByThread = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isValidState(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function persistChatScrollByThread(map: ChatScrollByThread): void {
  try {
    globalThis.localStorage?.setItem(CHAT_SCROLL_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Storage disabled (incognito quota, sandbox, SecurityError) — drop silently.
  }
}
