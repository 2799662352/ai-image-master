import { registerAskTools } from './askTools'
import { registerAudioTools } from './audioTools'
import { registerCanvasTools } from './canvasTools'
import { registerDirectorTools } from './directorTools'
import { registerHistoryTools } from './historyTools'
import { registerImageTools } from './imageTools'
import { registerPortraitTools } from './portraitTools'
import { registerUiTools } from './uiTools'
import { registerUnderstandTools } from './understandTools'
import { registerVideoTools } from './videoTools'
import { registerVideoWorkbenchTools } from './videoWorkbenchTools'
import { extractCodexCaller, runWithToolCaller } from '../toolCaller'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

/**
 * A view of the server whose `registerTool` runs every handler with its caller
 * in scope (see {@link runWithToolCaller}).
 *
 * The SDK always passes the request context last — `(args, ctx)`, or just
 * `(ctx)` for a tool without an input schema — so the last argument is where
 * the caller lives. Everything else on the server is passed through bound to
 * the real instance, so a tool file that later registers a resource or prompt
 * keeps working.
 */
export function withToolCallerScope(server: McpServer): McpServer {
  const registerTool = (name: unknown, config: unknown, handler: unknown): unknown => {
    const scoped = typeof handler === 'function'
      ? (...args: unknown[]) =>
          runWithToolCaller(extractCodexCaller(args[args.length - 1]), () =>
            (handler as (...a: unknown[]) => unknown)(...args),
          )
      : handler
    return (server.registerTool as unknown as (...a: unknown[]) => unknown).call(
      server,
      name,
      config,
      scoped,
    )
  }
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') return registerTool
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    },
  })
}

export function registerTools(server: McpServer, router: ToolRouter): void {
  const scoped = withToolCallerScope(server)
  registerImageTools(scoped, router)
  registerVideoTools(scoped, router)
  registerVideoWorkbenchTools(scoped, router)
  registerAudioTools(scoped, router)
  registerPortraitTools(scoped, router)
  registerHistoryTools(scoped, router)
  registerUiTools(scoped, router)
  registerAskTools(scoped, router)
  registerCanvasTools(scoped, router)
  registerDirectorTools(scoped, router)
  registerUnderstandTools(scoped, router)
}
