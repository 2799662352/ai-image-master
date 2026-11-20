import type { BrowserWindow } from 'electron'
import type { AgentToolRequest, AgentToolResponse } from '../../types/agent'
import {
  callerCodexThreadIds,
  currentToolCaller,
  mergeToolCaller,
  type CodexToolCaller,
  type ToolThreadResolution,
} from './toolCaller'
import { recordToolCall, type ToolCallAttribution } from './toolTelemetry'

// How long the main process waits for a renderer-handled tool (e.g.
// `generate_image`) to respond before giving up. Image generation on the
// gpt-image-2-vip channel can legitimately run for several minutes at 2K/4K
// high quality; the old 120s ceiling fired mid-generation, so the MCP tool
// surfaced a spurious "timed out" error (Codex then retried) even though the
// renderer kept going and the image actually completed + saved. We make this a
// generous ~2000s ceiling so the tool simply waits for the real result or an
// explicit error instead of inventing a timeout. It only fires if the renderer
// never answers at all (crash / closed window).
const RENDERER_TOOL_TIMEOUT_MS = 2_000_000

// `ask_user` blocks on a HUMAN decision, not on compute — users routinely walk
// away mid-pipeline and come back an hour later expecting the option card to
// still work. The old shared ~33-min ceiling killed the pending call while the
// card stayed rendered as clickable, so a late click was silently dropped here
// ("卡住了"). Give the ask a 6-hour window instead; codex's own per-server
// `tool_timeout_sec` is raised above this in codexLaunch.ts so this rejection
// (a clean, explicit error) always reaches the model before codex invents its
// own timeout. When it does fire, the turn ends and the renderer store expires
// the card (see store.ts turn-terminal expiry), so no zombie button remains.
//
// This is now only the BACKSTOP. The renderer store resolves an unanswered card
// as a `timedOut` skip after 5 idle minutes (`askUserTimeout.ts`), so the agent
// normally moves on long before this fires; the 6 hours still guards a renderer
// that never answers at all.
const ASK_USER_TOOL_TIMEOUT_MS = 21_600_000

function rendererToolTimeoutMs(toolName: string): number {
  // Aliases (askuser/catimationaskuser/…) are normalized to the canonical name
  // before reaching the router (askTools.ts delegates), so one check suffices.
  return toolName === 'ask_user' ? ASK_USER_TOOL_TIMEOUT_MS : RENDERER_TOOL_TIMEOUT_MS
}

/**
 * `threadId` is the resolved DB thread id of the chat that issued the tool
 * call (reverse-mapped from the codex thread UUID), so main-process tools
 * (e.g. `generate_video`) can route progress bubbles / persistence to the
 * requesting chat — same parallel-chat contamination fix as renderer tools.
 *
 * `undefined` means NO chat owns this call. It does not mean "use whichever
 * chat is open": a handler must then keep its output out of every chat.
 */
export type MainToolHandler = (params: Record<string, unknown>, threadId?: string) => Promise<unknown>

/**
 * Maps a tool call's caller to the chat that owns it. May answer synchronously
 * (everything held in memory) or asynchronously (a database lookup); returns
 * `undefined` when no chat owns the caller.
 */
export type ToolThreadResolver = (
  caller: CodexToolCaller,
) => ToolThreadResolution | undefined | Promise<ToolThreadResolution | undefined>

type PendingRendererTool = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === 'function'
}

function describeAttribution(
  caller: CodexToolCaller | undefined,
  resolution: ToolThreadResolution | undefined,
): ToolCallAttribution {
  if (!caller) return { kind: 'anonymous' }
  if (resolution) {
    return {
      kind: 'resolved',
      via: resolution.via,
      ...(caller.threadId ? { codexThreadId: caller.threadId } : {}),
    }
  }
  return {
    kind: 'unresolved',
    ...(caller.threadId ? { codexThreadId: caller.threadId } : {}),
    ancestorThreadIds: caller.ancestorThreadIds,
  }
}

export class ToolRouter {
  private mainHandlers = new Map<string, MainToolHandler>()
  private pending = new Map<string, PendingRendererTool>()
  /**
   * Resolves the caller of a tool call (the codex thread in its `_meta`, plus
   * that thread's ancestors) to our DB thread id, so tool UI is attributed to
   * the chat that requested it. Injected by `index.ts` once the AgentManager
   * exists.
   */
  private threadResolver: ToolThreadResolver | null = null

  constructor(private win: BrowserWindow) {}

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  setThreadResolver(resolver: ToolThreadResolver): void {
    this.threadResolver = resolver
  }

  registerMain(name: string, handler: MainToolHandler): void {
    this.mainHandlers.set(name, handler)
  }

  /**
   * `codexThreadId` is the caller's thread when a tool forwards it explicitly.
   * It is optional on purpose: tool handlers run inside a caller scope (see
   * `withToolCallerScope`), so a call that forwards nothing is still attributed.
   */
  async call(name: string, params: Record<string, unknown>, codexThreadId?: string): Promise<unknown> {
    // DIAGNOSTIC: every tool name Codex actually dispatches to our MCP server
    // arrives here verbatim. Use this to confirm whether `ask_user` ever
    // reaches us (vs. being rejected upstream as `unsupported call`) and what
    // EXACT name working tools (canvas_snapshot, generate_image) come in as.
    console.log(`[ToolRouter] incoming tool call: ${JSON.stringify(name)}`)
    // 埋点收口在这里:主处理器和渲染端委派两条路都必经此处,少一处就少一半数据。
    const startedAt = Date.now()
    const caller = mergeToolCaller(codexThreadId, currentToolCaller())
    // Resolved ONCE, here, for both the main-handler and renderer paths. Only
    // awaited when the resolver actually went async: the common in-memory hit
    // must keep the renderer request going out in the same tick as the call.
    const lookup = caller ? this.resolveThread(caller) : undefined
    const resolution = isThenable(lookup) ? await lookup : lookup
    const threadId = resolution?.threadId
    const attribution = describeAttribution(caller, resolution)
    if (caller && !threadId) {
      // The caller said which thread it is (or arrived on a pinned socket whose
      // chat was deleted), but no live chat owns it. The tool still runs — but
      // its output is not attached to any chat. It used to go to whichever chat
      // was open, which is how one conversation's images ended up in another.
      const ids = callerCodexThreadIds(caller)
      const label = ids.length > 0
        ? ids.join(' <- ')
        : caller.pinnedThreadId
          ? `pinned:${caller.pinnedThreadId}`
          : '(unknown)'
      console.warn(
        `[ToolRouter] ${name}: codex thread ${label} ` +
          'belongs to no chat; the tool runs detached and its output is shown in no chat',
      )
    }
    try {
      const mainHandler = this.mainHandlers.get(name)
      const result = mainHandler
        ? await mainHandler(params, threadId)
        : await this.callRenderer(name, params, threadId)
      recordToolCall({ name, durationMs: Date.now() - startedAt, threadId, attribution })
      return result
    } catch (error) {
      recordToolCall({ name, durationMs: Date.now() - startedAt, threadId, attribution, error })
      throw error
    }
  }

  /**
   * Attribution must never break a tool call: a resolver that throws or
   * rejects degrades to "no chat owns this", which is the safe answer.
   */
  private resolveThread(
    caller: CodexToolCaller,
  ): ToolThreadResolution | undefined | Promise<ToolThreadResolution | undefined> {
    if (!this.threadResolver) return undefined
    try {
      const result = this.threadResolver(caller)
      if (!isThenable(result)) return result
      return result.catch((error: unknown) => {
        console.warn('[ToolRouter] thread resolver rejected:', error)
        return undefined
      })
    } catch (error) {
      console.warn('[ToolRouter] thread resolver threw:', error)
      return undefined
    }
  }

  /**
   * 渲染进程重载/崩溃时由主进程接线调用：所有 pending 的渲染层工具调用
   * （generate_image kick、ask_user…）的响应永远不会回来，立即全部 reject,
   * 让 MCP 工具马上把明确的失败带回给模型，而不是干等 33 分钟/6 小时超时。
   * 返回被拒绝的调用数。
   */
  failAllPending(reason: string): number {
    let rejected = 0
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout)
      this.pending.delete(id)
      pending.reject(new Error(reason))
      rejected += 1
    }
    return rejected
  }

  handleRendererResponse(response: AgentToolResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error ?? 'Renderer tool failed'))
  }

  /**
   * `threadId` is the chat that owns the call, already resolved by `call`.
   * Absent = no chat owns it; the renderer then runs the tool detached and
   * must not put its UI into the chat the user happens to have open.
   */
  private callRenderer(
    toolName: string,
    params: Record<string, unknown>,
    threadId?: string,
  ): Promise<unknown> {
    const id = crypto.randomUUID()
    const request: AgentToolRequest = { id, toolName, params, ...(threadId ? { threadId } : {}) }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Renderer tool timed out: ${toolName}`))
      }, rendererToolTimeoutMs(toolName))

      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.win.webContents.send('agent:tool-request', request)
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
