import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/server'
import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/server'
import { CATIMATION_TOOL_INPUT_SCHEMA_MAX_BYTES } from '../../config'
import { registerTools } from '../index'

/**
 * Codex compacts any MCP tool schema over `tool_input_schema_max_bytes`, and
 * its first pass deletes every parameter `description`
 * (codex-rs/tools/src/json_schema/compaction.rs). Below the 5,000-byte default,
 * `generate_image` reached the model as bare parameter names.
 *
 * Raw JSON is measured because it is never smaller than what Codex measures
 * after normalizing, so passing here means Codex leaves the schema alone.
 */
async function listToolSchemas(): Promise<Array<{ name: string; inputSchema?: unknown }>> {
  const server = new McpServer({ name: 'catimation', version: '1.0.0' })
  registerTools(server, {} as never)
  const replies = new Map<unknown, JSONRPCMessage>()
  const transport: Transport = {
    async start() {},
    async close() {},
    async send(message: JSONRPCMessage) {
      if ('id' in message) replies.set(message.id, message)
    },
  }
  await server.connect(transport)
  const request = async (id: number, method: string, params: Record<string, unknown>) => {
    transport.onmessage?.({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage)
    await expect.poll(() => replies.has(id)).toBe(true)
    return replies.get(id) as unknown as {
      result: { tools: Array<{ name: string; inputSchema?: unknown }> }
    }
  }
  await request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'schema-budget', version: '1' },
  })
  transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage)
  return (await request(2, 'tools/list', {})).result.tools
}

describe('catimation tool schemas fit the Codex schema budget', () => {
  it('no tool is large enough for Codex to strip its parameter descriptions', async () => {
    const tools = await listToolSchemas()
    expect(tools.length).toBeGreaterThan(0)

    const oversized = tools
      .map((tool) => ({
        name: tool.name,
        bytes: Buffer.byteLength(JSON.stringify(tool.inputSchema ?? {}), 'utf8'),
      }))
      .filter((tool) => tool.bytes > CATIMATION_TOOL_INPUT_SCHEMA_MAX_BYTES)

    expect(oversized).toEqual([])
  })
})
