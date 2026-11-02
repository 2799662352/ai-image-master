/**
 * Which Codex thread made this MCP tool call?
 *
 * Codex stamps every `tools/call` with the thread it came from, in the request
 * `_meta`:
 *   - `threadId`                       the conversation id (what AgentManager maps back to a DB thread)
 *   - `x-codex-turn-metadata`          `{ session_id, thread_id, turn_id, … }`
 *       `thread_id`  the concrete thread
 *       `session_id` shared by a thread and its descendant (sub-agent) threads
 *
 * Prefer the concrete id; fall back to the session id only when nothing more
 * specific is there. Anything that is not a non-empty string is ignored, so a
 * malformed `_meta` degrades to "unknown" rather than forwarding junk.
 *
 * Tools that render UI MUST forward this to `ToolRouter.call(name, params,
 * codexThreadId)`: without it the renderer can only guess, and its guess is
 * "whichever chat the user is looking at" — which is how a background thread's
 * question ended up on the foreground thread.
 */
export function extractCodexThreadId(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: unknown } } | null | undefined)?.mcpReq?._meta as
    | {
        threadId?: unknown
        ['x-codex-turn-metadata']?: { thread_id?: unknown; session_id?: unknown } | null
      }
    | null
    | undefined
  if (!meta || typeof meta !== 'object') return undefined

  const nonEmpty = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined

  const turn = meta['x-codex-turn-metadata']
  return nonEmpty(meta.threadId) ?? nonEmpty(turn?.thread_id) ?? nonEmpty(turn?.session_id)
}
