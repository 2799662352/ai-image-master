#!/usr/bin/env node
/**
 * Cinematography KB MCP Server (stdio, zero-dependency)
 *
 * First-party Catimation MCP that wraps the Alibaba Bailian (Model Studio)
 * knowledge-base retrieval endpoint for the "运镜与结构化描述库":
 *   - 245 camera-motion primitives / 17 skill classes (CameraBench-Pro)
 *   - CHAI 5-dimension structured video captioning spec
 *   - professional caption examples (camera/motion/scene/spatial/subject)
 *   - critique-correction pairs
 *
 * Transport: JSON-RPC 2.0 over stdio (same convention as apiyi-mcp / the
 * catimation bridge). Pure Node built-ins only (node:https / node:readline) so
 * it runs under system `node` OR Electron-as-Node (ELECTRON_RUN_AS_NODE=1) with
 * no node_modules to vendor.
 *
 * Auth: DASHSCOPE_API_KEY is read from the environment. The app injects it at
 * codex spawn (from 设置 → 运镜知识库) via
 * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` — never persisted to
 * config.toml. An external `codex` CLI user can instead hand-add the key to the
 * `mcp_servers.cinematography_kb.env` block in their `~/.codex/config.toml`.
 */

'use strict'

const https = require('node:https')
const readline = require('node:readline')

const ENDPOINT_HOST = 'ws-zz37st8xsu4cfpof.cn-beijing.maas.aliyuncs.com'
const ENDPOINT_PATH = '/api/v1/indices/knowledge/search'
const AGENT_ID = 'aid-2065266de36042b3aad2505c1ee12dd8'
const API_KEY_ENV = 'DASHSCOPE_API_KEY'
const TIMEOUT_MS = 60000

function send(response) {
  process.stdout.write(JSON.stringify(response) + '\n')
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Best-effort extraction of retrieved chunks. DashScope nests results under
 * data.nodes; each node carries a pre-formatted `text` plus `metadata`. Falls
 * back to pretty JSON when the shape is unexpected.
 */
function extractChunks(payload) {
  if (!isObject(payload)) return null
  const container = isObject(payload.data)
    ? payload.data
    : isObject(payload.output)
      ? payload.output
      : payload
  let nodes = null
  if (isObject(container)) {
    nodes = container.nodes || container.results || container.chunks
  } else if (Array.isArray(container)) {
    nodes = container
  }
  if (!Array.isArray(nodes)) return null

  const chunks = []
  nodes.forEach((item, idx) => {
    if (!isObject(item)) {
      chunks.push(String(item))
      return
    }
    const node = isObject(item.node) ? item.node : item
    const text = node.text || node.content || node.chunk_text
    const meta = isObject(node.metadata)
      ? node.metadata
      : isObject(item.metadata)
        ? item.metadata
        : {}
    const score = item.score != null ? item.score : item.relevance_score
    const title = meta.doc_name || meta.title || meta.file_name || ''
    let header = `[${idx + 1}]`
    if (score != null) {
      const num = Number(score)
      header += Number.isFinite(num) ? ` score=${num.toFixed(3)}` : ` score=${score}`
    }
    if (title) header += ` · ${title}`
    chunks.push(`${header}\n${text || JSON.stringify(node)}`)
  })
  return chunks
}

function searchKb(query, topK) {
  return new Promise((resolve) => {
    const apiKey = (process.env[API_KEY_ENV] || '').trim()
    if (!apiKey) {
      resolve({ success: false, error: `Environment variable ${API_KEY_ENV} is not set.` })
      return
    }
    const bodyObj = { query, agent_id: AGENT_ID }
    if (topK) {
      bodyObj.dense_similarity_top_k = Number(topK)
      bodyObj.rerank_top_n = Number(topK)
    }
    const body = Buffer.from(JSON.stringify(bodyObj), 'utf8')
    const req = https.request(
      {
        host: ENDPOINT_HOST,
        path: ENDPOINT_PATH,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const parts = []
        res.on('data', (d) => parts.push(d))
        res.on('end', () => {
          const raw = Buffer.concat(parts).toString('utf8')
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            resolve({ success: false, error: `HTTP ${res.statusCode}`, detail: raw.slice(0, 1000) })
            return
          }
          let payload
          try {
            payload = JSON.parse(raw)
          } catch {
            resolve({ success: true, text: raw.slice(0, 6000) })
            return
          }
          const chunks = extractChunks(payload)
          if (chunks && chunks.length) {
            resolve({ success: true, text: chunks.join('\n\n') })
          } else {
            resolve({ success: true, text: JSON.stringify(payload, null, 2).slice(0, 6000) })
          }
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ success: false, error: `Request timed out after ${TIMEOUT_MS}ms` })
    })
    req.on('error', (err) => {
      resolve({ success: false, error: `Network error: ${err.message}` })
    })
    req.write(body)
    req.end()
  })
}

const TOOLS = [
  {
    name: 'search_cinematography_kb',
    description:
      'Search the cinematography knowledge base (运镜与结构化描述库): 245 camera-motion ' +
      'primitives / 17 skill classes, CHAI 5-dimension structured video captioning spec, ' +
      'professional caption examples (camera/motion/scene/spatial/subject), and ' +
      'critique-correction pairs. Use for questions about camera movement terminology ' +
      '(dolly in/out, pan, tilt, truck, pedestal, arc, crane, whip pan, rack focus...), ' +
      'how to write structured shot descriptions, or good vs bad caption examples.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: "Natural-language query, e.g. '相机向前推进的运镜术语 dolly in 怎么描述'.",
        },
        top_k: {
          type: 'integer',
          description: 'Optional number of chunks to retrieve (default endpoint setting).',
        },
      },
      required: ['query'],
    },
  },
]

async function handleRequest(request) {
  const { method, id } = request
  const params = request.params || {}

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cinematography-kb-mcp', version: '1.0.0' },
    })
  } else if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS })
  } else if (method === 'tools/call') {
    const toolName = params.name
    const args = params.arguments || {}
    if (toolName === 'search_cinematography_kb') {
      const query = args.query || ''
      if (!query) {
        sendResult(id, { content: [{ type: 'text', text: "Error: 'query' is required." }], isError: true })
        return
      }
      const result = await searchKb(query, args.top_k)
      if (result.success) {
        sendResult(id, { content: [{ type: 'text', text: result.text || '(empty)' }] })
      } else {
        let msg = result.error || 'unknown error'
        if (result.detail) msg += `\n${result.detail}`
        sendResult(id, { content: [{ type: 'text', text: msg }], isError: true })
      }
    } else {
      sendError(id, -32601, `Unknown tool: ${toolName}`)
    }
  } else if (method === 'notifications/initialized') {
    /* no-op */
  } else if (method === 'ping') {
    sendResult(id, {})
  } else if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`)
  }
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let request
    try {
      request = JSON.parse(trimmed)
    } catch {
      return
    }
    Promise.resolve(handleRequest(request)).catch((err) => {
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`)
    })
  })
}

main()
