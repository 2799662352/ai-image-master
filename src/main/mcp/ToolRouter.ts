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
    const mainHandler = this.mainHandlers.get(name)
    if (mainHandler) {
      const threadId = codexThreadId ? (this.threadIdResolver?.(codexThreadId) ?? undefined) : undefined
      return mainHandler(params, threadId)
    }
    return this.callRenderer(name, params, codexThreadId)
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
      }, RENDERER_TOOL_TIMEOUT_MS)

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
