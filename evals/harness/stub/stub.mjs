// Stdio MCP stub server — the process codex spawns for eval scenarios.
//
// It speaks newline-delimited JSON-RPC on stdin/stdout (identical framing to
// the real catimation stdio bridge) and answers with CANNED responses so the
// agent-decision loop runs fully headless. The toolset (names, schemas, canned
// results) comes from the environment so each scenario configures its own:
//
//   STUB_MCP_CONFIG     inline JSON: a `{ "tools": [...] }` object OR a bare
//                       array of tool defs.
//   STUB_MCP_TOOLS_FILE path to a JSON file with the same shape (takes
//                       precedence over STUB_MCP_CONFIG when both are set).
//
// Each tool def: { name, description?, inputSchema?, cannedResult?, cannedError? }
//
// IMPORTANT: protocol bytes go to STDOUT only; all diagnostics go to STDERR
// (writing logs to stdout would corrupt the JSON-RPC stream).

import { readFileSync } from 'node:fs'
import { handleRpc } from './stubRpc.mjs'

function log(...parts) {
  process.stderr.write(`[stub-mcp] ${parts.join(' ')}\n`)
}

function loadToolset() {
  const file = process.env.STUB_MCP_TOOLS_FILE
  const inline = process.env.STUB_MCP_CONFIG
  let raw = ''
  try {
    if (file) raw = readFileSync(file, 'utf8')
    else if (inline) raw = inline
    else return []
    const parsed = JSON.parse(raw)
    const tools = Array.isArray(parsed) ? parsed : parsed.tools
    if (!Array.isArray(tools)) {
      log('config did not contain a tools array; exposing no tools')
      return []
    }
    return tools
  } catch (e) {
    log('failed to parse toolset config:', e instanceof Error ? e.message : String(e))
    return []
  }
}

const toolset = loadToolset()
log(`ready with ${toolset.length} tool(s): ${toolset.map((t) => t.name).join(', ') || '<none>'}`)

let buffer = ''
process.stdin.setEncoding('utf8')

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineAt = buffer.indexOf('\n')
  while (newlineAt >= 0) {
    const line = buffer.slice(0, newlineAt).trim()
    buffer = buffer.slice(newlineAt + 1)
    if (line.length > 0) dispatch(line)
    newlineAt = buffer.indexOf('\n')
  }
})

process.stdin.on('end', () => process.exit(0))

function dispatch(line) {
  let request
  try {
    request = JSON.parse(line)
  } catch (e) {
    log('dropping non-JSON line:', e instanceof Error ? e.message : String(e))
    return
  }
  let response
  try {
    response = handleRpc(request, toolset)
  } catch (e) {
    log('handler threw:', e instanceof Error ? e.message : String(e))
    response =
      request && request.id != null
        ? { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'internal stub error' } }
        : null
  }
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
}
