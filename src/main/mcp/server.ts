import { createMcpExpressApp } from '@modelcontextprotocol/express'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server'
import type { BrowserWindow } from 'electron'
import { randomBytes, randomUUID } from 'node:crypto'
import { CATIMATION_MCP_HOST, CATIMATION_MCP_PORT, CATIMATION_MCP_TOKEN_HEADER } from './config'
import { ToolRouter } from './ToolRouter'
import { registerTools } from './tools'

export interface McpRuntime {
  port: number
  token: string
  router: ToolRouter
}

export async function startCatimationMcpServer(
  win: BrowserWindow,
  port = CATIMATION_MCP_PORT
): Promise<McpRuntime> {
  const token = randomBytes(32).toString('hex')
  const router = new ToolRouter(win)
  const server = new McpServer({ name: 'catimation', version: '1.0.0' })
  registerTools(server, router)

  const app = createMcpExpressApp({ host: CATIMATION_MCP_HOST })
  app.use((req, res, next) => {
    if (req.headers[CATIMATION_MCP_TOKEN_HEADER] !== token) {
      res.status(401).send('unauthorized')
      return
    }
    next()
  })

  const transports = new Map<string, NodeStreamableHTTPServerTransport>()
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body)
      return
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, transport),
      })
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId)
      }
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({ error: 'Invalid request' })
  })

  app.listen(port, CATIMATION_MCP_HOST)
  return { port, token, router }
}
