import type { BrowserWindow } from 'electron'
import type { AgentToolRequest, AgentToolResponse } from '../../types/agent'

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
 */
export type MainToolHandler = (params: Record<string, unknown>, threadId?: string) => Promise<unknown>

type PendingRendererTool = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class ToolRouter {
  private mainHandlers = new Map<string, MainToolHandler>()
  private pending = new Map<string, PendingRendererTool>()
  /**
   * Resolves a Codex thread UUID (from a tool call's `_meta`) to our DB thread
   * id, so renderer tools can be attributed to the chat that requested them.
   * Injected by `index.ts` once the AgentManager exists.
   */
  private threadIdResolver: ((codexThreadId: string) => string | undefined) | null = null

  constructor(private win: BrowserWindow) {}

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  setThreadIdResolver(resolver: (codexThreadId: string) => string | undefined): void {
    this.threadIdResolver = resolver
  }

  registerMain(name: string, handler: MainToolHandler): void {
    this.mainHandlers.set(name, handler)
  }

  async call(name: string, params: Record<string, unknown>, codexThreadId?: string): Promise<unknown> {
    // DIAGNOSTIC: every tool name Codex actually dispatches to our MCP server
    // arrives here verbatim. Use this to confirm whether `ask_user` ever
    // reaches us (vs. being rejected upstream as `unsupported call`) and what
    // EXACT name working tools (canvas_snapshot, generate_image) come in as.
    console.log(`[ToolRouter] incoming tool call: ${JSON.stringify(name)}`)
    const mainHandler = this.mainHandlers.get(name)
    if (mainHandler) {
      const threadId = codexThreadId ? (this.threadIdResolver?.(codexThreadId) ?? undefined) : undefined
      return mainHandler(params, threadId)
    }
    return this.callRenderer(name, params, codexThreadId)
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

  private callRenderer(
    toolName: string,
    params: Record<string, unknown>,
    codexThreadId?: string,
  ): Promise<unknown> {
    const id = crypto.randomUUID()
    // Reverse-map the codex thread UUID to our DB thread id so the renderer
    // routes the tool's UI (e.g. a generated image bubble) to the requesting
    // chat. Undefined when there's no resolver or no mapping yet — the renderer
    // falls back to its active-thread capture.
    const threadId = codexThreadId ? (this.threadIdResolver?.(codexThreadId) ?? undefined) : undefined
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
