// Pure MCP JSON-RPC handler for the eval stub server. No I/O here — `stub.mjs`
// wires this to stdin/stdout. Kept as plain ESM (.mjs) so codex can spawn it
// with `node` directly (no tsx/build step), while still being unit-testable
// from vitest (which imports .mjs fine).

/** Echoed back to the client on initialize when it doesn't request a version. */
export const PROTOCOL_VERSION_FALLBACK = '2025-06-18'

const SERVER_INFO = { name: 'catimation-eval-stub', version: '0.0.0' }

/** A permissive default schema for tools whose scenario didn't specify one. */
function defaultInputSchema() {
  return { type: 'object', properties: {}, additionalProperties: true }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result }
}

function err(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Handle ONE JSON-RPC message.
 *
 * @param {{ jsonrpc?: string, id?: unknown, method?: string, params?: any }} request
 * @param {Array<{ name: string, description?: string, inputSchema?: object, cannedResult?: unknown, cannedError?: string }>} toolset
 * @returns {object|null} the response to write back, or `null` for
 *   notifications (no `id`) which get no reply.
 */
export function handleRpc(request, toolset) {
  const { id, method, params } = request ?? {}
  const isNotification = id === undefined || id === null

  // Notifications never get a response (initialized, cancelled, …).
  if (isNotification) return null

  switch (method) {
    case 'initialize': {
      const protocolVersion =
        (params && typeof params.protocolVersion === 'string' && params.protocolVersion) || PROTOCOL_VERSION_FALLBACK
      return ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
    }
    case 'ping':
      return ok(id, {})
    case 'tools/list':
      return ok(id, {
        tools: toolset.map((t) => ({
          name: t.name,
          description: t.description ?? `${t.name} (eval stub)`,
          inputSchema: t.inputSchema ?? defaultInputSchema(),
        })),
      })
    case 'tools/call': {
      const name = params && params.name
      const tool = toolset.find((t) => t.name === name)
      if (!tool) return err(id, -32602, `Unknown tool: ${String(name)}`)
      if (tool.cannedError) {
        return ok(id, {
          content: [{ type: 'text', text: String(tool.cannedError) }],
          isError: true,
        })
      }
      const payload = tool.cannedResult ?? {}
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        isError: false,
      })
    }
    default:
      return err(id, -32601, `Method not found: ${String(method)}`)
  }
}
