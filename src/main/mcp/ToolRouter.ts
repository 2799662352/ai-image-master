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

export type MainToolHandler = (params: Record<string, unknown>) => Promise<unknown>

type PendingRendererTool = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: NodeJS.Timeout
}

export class ToolRouter {
  private mainHandlers = new Map<string, MainToolHandler>()
  private pending = new Map<string, PendingRendererTool>()

  constructor(private win: BrowserWindow) {}

  setWindow(win: BrowserWindow): void {
    this.win = win
  }

  registerMain(name: string, handler: MainToolHandler): void {
    this.mainHandlers.set(name, handler)
  }

  async call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const mainHandler = this.mainHandlers.get(name)
    if (mainHandler) return mainHandler(params)
    return this.callRenderer(name, params)
  }

  handleRendererResponse(response: AgentToolResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pending.delete(response.id)
    response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error ?? 'Renderer tool failed'))
  }

  private callRenderer(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID()
    const request: AgentToolRequest = { id, toolName, params }

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
