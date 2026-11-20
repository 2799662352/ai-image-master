import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Who is calling this MCP tool — the codex thread, plus the threads it descends
 * from.
 *
 * Why lineage and not just one id: the app can only map a codex thread to a
 * chat when it minted that thread itself. A sub-agent's thread is minted by
 * codex, so its own id means nothing to us — but codex also stamps the call
 * with the thread it was spawned from, and THAT one is ours.
 *
 * Shapes measured against the bundled codex 0.169.0
 * (`scripts/smoke-mcp-thread-meta.ts`), `_meta` of the `tools/call` request:
 *
 * | caller               | `threadId` | `sessionId` | turn `parent_thread_id` | turn `forked_from_thread_id` |
 * |----------------------|------------|-------------|-------------------------|------------------------------|
 * | plain thread         | itself     | itself      | —                       | —                            |
 * | `thread/fork` result | the fork   | the fork    | —                       | the source                   |
 * | sub-agent (V1 / V2)  | the child  | the parent  | the parent              | (V2) the parent              |
 *
 * `forked_from_thread_id` is deliberately NOT lineage. A fork is its own
 * conversation: when the app forks (model rebind, edit-and-resend) it re-points
 * the chat at the fork, and a fork the app did not make belongs to no chat of
 * ours. Following it would deliver one conversation's output to another.
 */
export interface CodexToolCaller {
  /** The codex thread that issued the call. Absent when `_meta` names only a session. */
  threadId?: string
  /**
   * Threads the caller descends from, nearest first, never containing
   * {@link threadId}. Empty for an ordinary conversation thread.
   */
  ancestorThreadIds: readonly string[]
}

/** How a caller was matched to a chat. Recorded so the next log can say which path fired. */
export type ToolThreadVia =
  /** The caller is the chat's current codex thread. */
  | 'live'
  /** The caller is a sub-agent the chat was seen spawning. */
  | 'subagent'
  /** The caller was the chat's codex thread until a fork / reset replaced it. */
  | 'retired'
  /** The caller itself is unknown; one of its ancestors is a chat's thread. */
  | 'ancestor'
  /** Not in memory; the chat's persisted codex thread id matched. */
  | 'persisted'

export interface ToolThreadResolution {
  /** DB thread id of the chat that owns the call. */
  threadId: string
  via: ToolThreadVia
}

const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/**
 * Read the caller out of an MCP tool handler's `ctx`. Returns `undefined` when
 * `_meta` carries no thread information at all (a non-codex MCP client), and
 * ignores anything that is not a non-empty string — a malformed `_meta`
 * degrades to "unknown caller", never to a junk id.
 */
export function extractCodexCaller(ctx: unknown): CodexToolCaller | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: unknown } } | null | undefined)?.mcpReq?._meta as
    | {
        threadId?: unknown
        sessionId?: unknown
        ['x-codex-turn-metadata']?: {
          thread_id?: unknown
          session_id?: unknown
          parent_thread_id?: unknown
        } | null
      }
    | null
    | undefined
  if (!meta || typeof meta !== 'object') return undefined

  const turn = meta['x-codex-turn-metadata']
  const threadId = nonEmpty(meta.threadId) ?? nonEmpty(turn?.thread_id)
  const ancestorThreadIds = uniqueExcept(
    [nonEmpty(turn?.parent_thread_id), nonEmpty(meta.sessionId), nonEmpty(turn?.session_id)],
    threadId,
  )
  if (!threadId && ancestorThreadIds.length === 0) return undefined
  return { ...(threadId ? { threadId } : {}), ancestorThreadIds }
}

function uniqueExcept(ids: Array<string | undefined>, except: string | undefined): string[] {
  const out: string[] = []
  for (const id of ids) {
    if (id && id !== except && !out.includes(id)) out.push(id)
  }
  return out
}

const callerStorage = new AsyncLocalStorage<CodexToolCaller | undefined>()

/**
 * Run a tool handler with its caller in scope, so every `ToolRouter.call` made
 * while handling it — directly or from a helper three layers down — knows who
 * asked, without each of ~60 call sites having to remember to pass it along.
 * (Forgetting was not hypothetical: the canvas-export and director tools never
 * forwarded the caller, so their "requesting thread first" rule in the
 * renderer had never once applied.)
 */
export function runWithToolCaller<T>(caller: CodexToolCaller | undefined, fn: () => T): T {
  return callerStorage.run(caller, fn)
}

/** The caller of the tool handler we are currently inside, if any. */
export function currentToolCaller(): CodexToolCaller | undefined {
  return callerStorage.getStore()
}

/**
 * Combine an explicitly forwarded thread id (the older convention, still used
 * by most tools) with the ambient caller. The explicit id wins as the caller's
 * own thread; the lineage always comes from the ambient scope.
 */
export function mergeToolCaller(
  explicitThreadId: string | undefined,
  ambient: CodexToolCaller | undefined,
): CodexToolCaller | undefined {
  const threadId = nonEmpty(explicitThreadId) ?? ambient?.threadId
  const ancestorThreadIds = uniqueExcept(
    [
      // An explicit id that differs from the ambient thread (the session-id
      // fallback of `extractCodexThreadId`) must not lose the real thread.
      ambient?.threadId,
      ...(ambient?.ancestorThreadIds ?? []),
    ],
    threadId,
  )
  if (!threadId && ancestorThreadIds.length === 0) return undefined
  return { ...(threadId ? { threadId } : {}), ancestorThreadIds }
}

/** Every codex thread id a caller names, own thread first. */
export function callerCodexThreadIds(caller: CodexToolCaller): string[] {
  return uniqueExcept([caller.threadId, ...caller.ancestorThreadIds], undefined)
}
