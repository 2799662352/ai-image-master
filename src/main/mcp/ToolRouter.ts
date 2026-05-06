import type { BrowserWindow } from 'electron'
import type { AgentToolRequest, AgentToolResponse } from '../../types/agent'

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
      }, 120_000)

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
