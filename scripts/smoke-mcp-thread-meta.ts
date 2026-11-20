// Offline measurement: what does the BUNDLED codex binary put in an MCP
// `tools/call` request's `_meta` — for a plain thread, a forked thread, a
// thread that was superseded while its turn was still running, a sub-agent and
// a nested sub-agent — and what does `thread/started` say about lineage?
//
// Why it exists: `ToolRouter` decides which conversation a tool's UI belongs to
// from those ids. Everything we knew about them came from reading upstream
// source; this script replaces that with what the shipped binary really sends,
// and is the thing to re-run when the bundled Codex version is bumped.
//
// Safety: no network, no real key, no user data. A scripted local Responses
// endpoint plays the model, a local streamable-HTTP MCP server records every
// `tools/call`, and CODEX_HOME is a fresh temporary directory removed at exit.
//
// Usage:
//   pnpm exec tsx scripts/smoke-mcp-thread-meta.ts [--v2] [--out <dir>]
// Worktree/CI: CODEX_RESOURCE_ROOT=<absolute-resources-path> pnpm exec tsx ...

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { appendProviderArgs, buildCodexLaunchArgs } from '../src/main/agent/codexLaunch'
import { resolveCodexBinary } from '../src/main/agent/paths'
import { pickFreePort } from '../src/main/agent/ports'

const SMOKE_TIMEOUT_MS = 240_000
const TURN_TIMEOUT_MS = 45_000
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const V2 = process.argv.includes('--v2')
const PROBE_TOOL = 'probe_echo'

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type Json = Record<string, unknown>

// ── scripted model ──────────────────────────────────────────────────────────

interface ModelRequest {
  at: number
  path: string
  headers: Record<string, string>
  promptCacheKey?: string
  directive?: string
  action: string
  inputTypes: string[]
  toolNames: string[]
}

/** Flat `namespace/name` list of everything the request offered the model. */
function toolNames(tools: unknown, namespace?: string): string[] {
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return []
    const record = tool as Json
    const own = typeof record.name === 'string' ? record.name : String(record.type)
    if (Array.isArray(record.tools)) return toolNames(record.tools, own)
    return [namespace ? `${namespace}/${own}` : own]
  })
}

const modelRequests: ModelRequest[] = []
let firstTools: unknown
let callSeq = 0

function sse(type: string, data: Json): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

/** Finds a tool by (suffix of) name anywhere in the request's `tools`, with its namespace if nested. */
function findTool(tools: unknown, name: string): { name: string; namespace?: string; tool: Json } | undefined {
  const visit = (node: unknown, namespace?: string): { name: string; namespace?: string; tool: Json } | undefined => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = visit(child, namespace)
        if (hit) return hit
      }
      return undefined
    }
    if (!node || typeof node !== 'object') return undefined
    const record = node as Json
    const own = typeof record.name === 'string' ? record.name : undefined
    if (own && (own === name || own.endsWith(`__${name}`)) && record.type !== 'namespace') {
      return { name: own, ...(namespace ? { namespace } : {}), tool: record }
    }
    if (Array.isArray(record.tools)) return visit(record.tools, own ?? namespace)
    return undefined
  }
  return visit(tools)
}

/** `PROBE_SPAWN{inner}` → inner; `PROBE_TOOL[tag]` / `PROBE_SLOW_TOOL[tag]` → tag. */
function parseDirective(text: string): { kind: 'spawn'; inner: string } | { kind: 'tool'; tag: string; slow: boolean } | undefined {
  const spawnAt = text.indexOf('PROBE_SPAWN{')
  const toolMatch = /PROBE_(SLOW_)?TOOL\[([^\]]+)\]/u.exec(text)
  if (spawnAt >= 0 && (!toolMatch || spawnAt < toolMatch.index)) {
    const open = spawnAt + 'PROBE_SPAWN{'.length
    const close = text.lastIndexOf('}')
    if (close > open) return { kind: 'spawn', inner: text.slice(open, close) }
  }
  if (toolMatch) return { kind: 'tool', tag: toolMatch[2], slow: Boolean(toolMatch[1]) }
  return undefined
}

function writeMessage(res: http.ServerResponse, text: string): void {
  const id = `msg_${++callSeq}`
  const message = { type: 'message', id, role: 'assistant' }
  res.write(sse('response.created', { response: { id: `resp_${callSeq}` } }))
  res.write(sse('response.output_item.added', { output_index: 0, item: { ...message, content: [] } }))
  res.write(sse('response.output_text.delta', { item_id: id, output_index: 0, content_index: 0, delta: text }))
  res.write(sse('response.output_item.done', {
    output_index: 0,
    item: { ...message, content: [{ type: 'output_text', text, annotations: [] }] },
  }))
  writeCompleted(res)
}

function writeFunctionCall(res: http.ServerResponse, target: { name: string; namespace?: string }, args: Json): void {
  const seq = ++callSeq
  const item = {
    type: 'function_call',
    id: `fc_${seq}`,
    call_id: `call_${seq}`,
    name: target.name,
    ...(target.namespace ? { namespace: target.namespace } : {}),
    arguments: JSON.stringify(args),
    status: 'completed',
  }
  res.write(sse('response.created', { response: { id: `resp_${seq}` } }))
  res.write(sse('response.output_item.added', { output_index: 0, item: { ...item, arguments: '' } }))
  res.write(sse('response.output_item.done', { output_index: 0, item }))
  writeCompleted(res)
}

/**
 * Multi-agent V1 keeps `spawn_agent` behind `tool_search` (deferred tools), so
 * the scripted model has to discover it the way a real one does.
 */
function writeToolSearch(res: http.ServerResponse, query: string): void {
  const seq = ++callSeq
  const item = {
    type: 'tool_search_call',
    id: `ts_${seq}`,
    call_id: `call_${seq}`,
    execution: 'client',
    status: 'completed',
    arguments: { query, limit: 8 },
  }
  res.write(sse('response.created', { response: { id: `resp_${seq}` } }))
  res.write(sse('response.output_item.added', { output_index: 0, item }))
  res.write(sse('response.output_item.done', { output_index: 0, item }))
  writeCompleted(res)
}

function writeCompleted(res: http.ServerResponse): void {
  res.write(sse('response.completed', {
    response: {
      id: `resp_${callSeq}`,
      usage: {
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 5,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 15,
      },
    },
  }))
  res.end()
}

function spawnArgs(tool: Json, message: string): Json {
  const properties = ((tool.parameters as Json | undefined)?.properties ?? {}) as Json
  const args: Json = {}
  // Fill whichever of the known task-carrying fields this generation declares.
  if ('message' in properties) args.message = message
  if ('prompt' in properties) args.prompt = message
  if ('task' in properties) args.task = message
  if ('task_name' in properties) args.task_name = `probe_${callSeq + 1}`
  if (Object.keys(args).length === 0) args.message = message
  return args
}

function startMockModel(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        let body: Json = {}
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Json } catch { /* GET probes */ }
        if (req.method !== 'POST' || !(req.url ?? '').endsWith('/responses')) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'not served by the probe mock' } }))
          return
        }
        if (firstTools === undefined && Array.isArray(body.tools) && body.tools.length > 0) firstTools = body.tools
        const input = Array.isArray(body.input) ? (body.input as Json[]) : []
        let directiveAt = -1
        let directive: ReturnType<typeof parseDirective>
        input.forEach((item, index) => {
          if (String(item.type ?? '').includes('function_call')) return
          const parsed = parseDirective(JSON.stringify(item))
          if (parsed) { directive = parsed; directiveAt = index }
        })
        // A directive is spent once a real tool call follows it in the
        // transcript; a `tool_search` round-trip in between does not count.
        const followed = directiveAt >= 0 ? input.slice(directiveAt + 1) : []
        const handled = followed.some((item) => ['function_call', 'custom_tool_call'].includes(String(item.type ?? '')))
        const searched = followed.some((item) => String(item.type ?? '').startsWith('tool_search'))
        const offered = [body.tools, ...input.filter((item) => item.type === 'tool_search_output').map((item) => item.tools)]
        const record: ModelRequest = {
          at: Date.now(),
          path: req.url ?? '',
          headers: Object.fromEntries(
            Object.entries(req.headers)
              .filter(([key]) => !['authorization', 'content-length', 'host', 'accept', 'content-type', 'connection'].includes(key))
              .map(([key, value]) => [key, String(value)]),
          ),
          ...(typeof body.prompt_cache_key === 'string' ? { promptCacheKey: body.prompt_cache_key } : {}),
          ...(directive ? { directive: JSON.stringify(directive) } : {}),
          action: 'message',
          inputTypes: input.map((item) => `${String(item.type)}${item.role ? `:${String(item.role)}` : ''}`),
          toolNames: toolNames(body.tools),
        }
        modelRequests.push(record)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        if (!directive || handled) { writeMessage(res, 'done'); return }
        const current = directive
        if (current.kind === 'spawn') {
          const tool = findTool(offered, 'spawn_agent')
          const canSearch = Array.isArray(body.tools)
            && (body.tools as Json[]).some((entry) => entry.type === 'tool_search')
          if (!tool && !searched && canSearch) {
            record.action = 'tool_search spawn_agent'
            writeToolSearch(res, 'spawn_agent spawn a sub-agent')
            return
          }
          if (!tool) { record.action = 'spawn-unavailable'; writeMessage(res, 'spawn_agent unavailable'); return }
          record.action = `call ${tool.namespace ? `${tool.namespace}/` : ''}${tool.name}`
          writeFunctionCall(res, tool, spawnArgs(tool.tool, current.inner))
          return
        }
        const tool = findTool(body.tools, PROBE_TOOL)
        if (!tool) { record.action = 'probe-tool-unavailable'; writeMessage(res, 'probe tool unavailable'); return }
        record.action = `call ${tool.namespace ? `${tool.namespace}/` : ''}${tool.name}${current.slow ? ' (slow)' : ''}`
        const fire = (): void => writeFunctionCall(res, tool, { tag: current.tag })
        if (current.slow) setTimeout(fire, 4_000)
        else fire()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => server.close() })
    })
  })
}

// ── recording MCP server (streamable HTTP, JSON responses) ──────────────────

interface McpCall { at: number; tag: string; meta: unknown; headers: Record<string, string> }
const mcpCalls: McpCall[] = []
/** Every JSON-RPC method the MCP mock received, in order — proves the handshake happened. */
const mcpMethods: string[] = []

function startMockMcp(): Promise<{ port: number; close: () => void }> {
  const answer = (message: Json): Json | undefined => {
    const id = message.id
    const method = String(message.method ?? '')
    const params = (message.params ?? {}) as Json
    if (id === undefined || id === null) return undefined
    const ok = (result: Json): Json => ({ jsonrpc: '2.0', id, result })
    if (method === 'initialize') {
      return ok({
        protocolVersion: params.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'probe', version: '0.0.0' },
      })
    }
    if (method === 'ping') return ok({})
    if (method === 'tools/list') {
      return ok({
        tools: [{
          name: PROBE_TOOL,
          description: 'Echo a tag back. Used by the thread-meta probe.',
          inputSchema: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] },
        }],
      })
    }
    if (method === 'tools/call') {
      const tag = String(((params.arguments ?? {}) as Json).tag ?? '')
      return ok({ content: [{ type: 'text', text: `echo:${tag}` }] })
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') { mcpMethods.push(`HTTP ${req.method}`); res.writeHead(405).end(); return }
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        let parsed: unknown
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { res.writeHead(400).end(); return }
        const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Json[]
        for (const message of messages) {
          mcpMethods.push(String(message.method ?? `response:${String(message.id)}`))
          if (message.method !== 'tools/call') continue
          const params = (message.params ?? {}) as Json
          mcpCalls.push({
            at: Date.now(),
            tag: String(((params.arguments ?? {}) as Json).tag ?? ''),
            meta: params._meta,
            headers: Object.fromEntries(
              Object.entries(req.headers)
                .filter(([key]) => !['content-length', 'host', 'accept', 'content-type', 'connection', 'user-agent'].includes(key))
                .map(([key, value]) => [key, String(value)]),
            ),
          })
        }
        const replies = messages.map(answer).filter((reply): reply is Json => reply !== undefined)
        if (replies.length === 0) { res.writeHead(202).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(Array.isArray(parsed) ? replies : replies[0]))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, close: () => server.close() })
    })
  })
}

// ── raw app-server client ───────────────────────────────────────────────────

interface Notification { at: number; method: string; params: Json }

interface RpcClient {
  rpc: (method: string, params: unknown) => Promise<unknown>
  notify: (method: string, params: unknown) => void
  notifications: Notification[]
  close: () => void
}

function connectRpc(url: string): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const notifications: Notification[] = []
    let nextId = 1
    const started = Date.now()
    const tryOpen = (): void => {
      const ws = new WebSocket(url)
      ws.on('open', () => {
        ws.on('message', (raw) => {
          const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Json; result?: unknown; error?: { message?: string } }
          if (typeof message.id === 'number' && !message.method) {
            const entry = pending.get(message.id)
            if (!entry) return
            pending.delete(message.id)
            if (message.error) entry.reject(new Error(message.error.message ?? 'rpc error'))
            else entry.resolve(message.result)
            return
          }
          if (message.method) notifications.push({ at: Date.now(), method: message.method, params: message.params ?? {} })
        })
        resolve({
          rpc: (method, params) => new Promise((res, rej) => {
            const id = nextId++
            pending.set(id, { resolve: res, reject: rej })
            ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
          }),
          notify: (method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', method, params })),
          notifications,
          close: () => { try { ws.close() } catch { /* ignore */ } },
        })
      })
      ws.on('error', () => {
        ws.terminate()
        if (Date.now() - started > 15_000) reject(new Error('ws connect timeout'))
        else setTimeout(tryOpen, 250)
      })
    }
    tryOpen()
  })
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = TURN_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(150)
  }
  console.log(`[probe] ⚠️ timed out waiting for: ${label}`)
  return false
}

function turnEnded(client: RpcClient, threadId: string, sinceIndex: number): boolean {
  return client.notifications.slice(sinceIndex).some(
    (n) => n.method === 'turn/completed' && n.params.threadId === threadId,
  )
}

async function runTurn(client: RpcClient, threadId: string, text: string, label: string): Promise<void> {
  const cursor = client.notifications.length
  await client.rpc('turn/start', { threadId, input: [{ type: 'text', text }], model: 'gpt-5.5' })
  const ended = await waitFor(`${label}: turn/completed`, () => turnEnded(client, threadId, cursor))
  console.log(`[probe] ${label}: turn ${ended ? 'completed' : 'DID NOT complete'}`)
}

function short(id: unknown): string {
  return typeof id === 'string' ? id.slice(0, 13) : String(id)
}

// ── scenarios ───────────────────────────────────────────────────────────────

async function runSmoke(): Promise<void> {
  const outDir = argValue('--out') ?? path.join(os.tmpdir(), `mcp-thread-meta-${V2 ? 'v2' : 'v1'}`)
  mkdirSync(outDir, { recursive: true })
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'smoke-thread-meta-'))
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'smoke-thread-meta-cwd-'))
  // The production arg set overlays `mcp_servers.cinematography_kb.*` leaves, so
  // the entry needs a transport to be valid; keep it disabled.
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      '[mcp_servers.cinematography_kb]',
      `command = ${JSON.stringify(process.execPath)}`,
      'args = ["-e", "process.exit(0)"]',
      'enabled = false',
      '',
    ].join('\n'),
    'utf8',
  )

  const model = await startMockModel()
  const mcp = await startMockMcp()
  const port = await pickFreePort(4322)
  const listenUrl = `ws://127.0.0.1:${port}`
  const args = buildCodexLaunchArgs({ listenUrl })
  appendProviderArgs(args, {
    id: 'probe-mock',
    name: 'Probe Mock',
    baseUrl: `http://127.0.0.1:${model.port}/v1`,
    envKey: 'OPENAI_API_KEY',
    model: 'gpt-5.5',
    ...(V2 ? { multiAgentV2: true } : {}),
  })
  args.push(
    '-c', `mcp_servers.catimation.url="http://127.0.0.1:${mcp.port}/mcp"`,
    '-c', 'mcp_servers.catimation.supports_parallel_tool_calls=true',
  )

  const resourceRoot = process.env.CODEX_RESOURCE_ROOT?.trim() || path.join(projectRoot, 'resources')
  const bin = resolveCodexBinary(resourceRoot)
  console.log(`[probe] spawning ${bin} (multi-agent ${V2 ? 'V2' : 'V1'})`)
  let proc: ChildProcess | null = null
  let client: RpcClient | null = null
  const stderrLines: string[] = []
  const ids: Record<string, string | undefined> = {}
  try {
    proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-smoke-offline' },
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/u)) if (line.trim()) stderrLines.push(line.slice(0, 500))
    })
    const exited = new Promise<never>((_, rejectExit) => {
      proc!.once('exit', (code) => rejectExit(new Error(`codex exited early (code=${code})`)))
    })
    client = await Promise.race([connectRpc(listenUrl), exited])
    const init = await client.rpc('initialize', {
      clientInfo: { name: 'smoke-thread-meta', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    }) as { userAgent?: string }
    client.notify('initialized', {})
    console.log(`[probe] initialize OK (${init?.userAgent ?? '?'})`)

    // S1 — plain thread.
    const started = await client.rpc('thread/start', { model: 'gpt-5.5', cwd }) as { thread?: Json }
    const a = String(started.thread?.id ?? '')
    if (!a) throw new Error('thread/start returned no thread id')
    ids.A = a
    writeFileSync(path.join(outDir, 'thread-start-response.json'), JSON.stringify(started, null, 2))
    // MCP servers start in the background; a turn begun before the handshake
    // finishes is offered no MCP tools at all.
    await waitFor('probe MCP tools/list', () => mcpMethods.includes('tools/list'), 20_000)
    try {
      const status = await client.rpc('mcpServerStatus/list', {})
      writeFileSync(path.join(outDir, 'mcp-status.json'), JSON.stringify(status, null, 2))
    } catch (error) {
      console.log(`[probe] mcpServerStatus/list failed: ${(error as Error).message.slice(0, 200)}`)
    }
    console.log(`[probe] MCP mock saw: ${mcpMethods.join(', ') || '(nothing)'}`)
    await runTurn(client, a, 'PROBE_TOOL[s1-plain]', 'S1 plain thread')

    // S2 — fork (what a mid-conversation model switch does), then a turn on the fork.
    const forked = await client.rpc('thread/fork', { threadId: a }) as { thread?: Json }
    const b = String(forked.thread?.id ?? '')
    ids.B = b
    writeFileSync(path.join(outDir, 'thread-fork-response.json'), JSON.stringify(forked, null, 2))
    await runTurn(client, b, 'PROBE_TOOL[s2-fork]', 'S2 forked thread')

    // S3 — the source thread is superseded (fork + unsubscribe) while its turn
    // is still waiting on the model; does its tool call still reach the server?
    const s3Cursor = client.notifications.length
    await client.rpc('turn/start', { threadId: a, input: [{ type: 'text', text: 'PROBE_SLOW_TOOL[s3-superseded]' }], model: 'gpt-5.5' })
    await sleep(800)
    try {
      const again = await client.rpc('thread/fork', { threadId: a }) as { thread?: Json }
      ids.C = String(again.thread?.id ?? '')
      console.log(`[probe] S3 fork-while-running accepted → ${short(ids.C)}`)
    } catch (error) {
      console.log(`[probe] S3 fork-while-running REFUSED: ${(error as Error).message.slice(0, 200)}`)
    }
    try {
      const unsub = await client.rpc('thread/unsubscribe', { threadId: a })
      console.log(`[probe] S3 thread/unsubscribe(A) → ${JSON.stringify(unsub)}`)
    } catch (error) {
      console.log(`[probe] S3 thread/unsubscribe(A) failed: ${(error as Error).message.slice(0, 200)}`)
    }
    await waitFor('S3 superseded tool call', () => mcpCalls.some((call) => call.tag === 's3-superseded'), 15_000)
    console.log(`[probe] S3 notifications from A after unsubscribe: ${
      client.notifications.slice(s3Cursor).filter((n) => n.params.threadId === a).length}`)

    // S4 — sub-agent calls the tool; S5 — nested sub-agent calls the tool.
    const parent = ids.C || b
    ids.parent = parent
    await runTurn(client, parent, 'PROBE_SPAWN{PROBE_TOOL[s4-child]}', 'S4 spawn child')
    await waitFor('S4 child tool call', () => mcpCalls.some((call) => call.tag === 's4-child'), 30_000)
    await runTurn(client, parent, 'PROBE_SPAWN{PROBE_SPAWN{PROBE_TOOL[s5-grandchild]}}', 'S5 spawn nested')
    await waitFor('S5 grandchild tool call', () => mcpCalls.some((call) => call.tag === 's5-grandchild'), 30_000)
    await sleep(1_500)
  } finally {
    const threadStarted = (client?.notifications ?? []).filter((n) => n.method === 'thread/started')
    writeFileSync(path.join(outDir, 'ids.json'), JSON.stringify(ids, null, 2))
    writeFileSync(path.join(outDir, 'mcp-calls.json'), JSON.stringify(mcpCalls, null, 2))
    writeFileSync(path.join(outDir, 'model-requests.json'), JSON.stringify(modelRequests, null, 2))
    writeFileSync(path.join(outDir, 'thread-started.json'), JSON.stringify(threadStarted, null, 2))
    writeFileSync(path.join(outDir, 'tools.json'), JSON.stringify(firstTools ?? null, null, 2))
    writeFileSync(path.join(outDir, 'codex-stderr.log'), stderrLines.join('\n'))
    writeFileSync(
      path.join(outDir, 'notifications.jsonl'),
      (client?.notifications ?? []).map((n) => JSON.stringify(n)).join('\n'),
    )

    console.log('\n[probe] ── ids ──')
    for (const [name, id] of Object.entries(ids)) console.log(`  ${name} = ${id}`)
    console.log('\n[probe] ── MCP tools/call _meta ──')
    for (const call of mcpCalls) console.log(`  ${call.tag}\n    ${JSON.stringify(call.meta)}`)
    console.log('\n[probe] ── thread/started ──')
    for (const n of threadStarted) {
      const thread = (n.params.thread ?? {}) as Json
      console.log(`  id=${short(thread.id)} sessionId=${short(thread.sessionId)} forkedFromId=${short(thread.forkedFromId)}`
        + ` parentThreadId=${short(thread.parentThreadId)} source=${JSON.stringify(thread.source)}`)
    }
    console.log('\n[probe] ── model requests ──')
    for (const request of modelRequests) {
      console.log(`  thread=${short(request.headers['thread-id'])} ${request.action}`
        + `${request.headers['x-openai-subagent'] ? ` [subagent=${request.headers['x-openai-subagent']}]` : ''}`
        + ` tools=${request.toolNames.length}`)
    }
    const offered = [...new Set(modelRequests.flatMap((request) => request.toolNames))]
    console.log(`\n[probe] tools ever offered: ${offered.join(', ')}`)
    console.log(`\n[probe] model requests: ${modelRequests.length}; raw output in ${outDir}`)

    client?.close()
    model.close()
    mcp.close()
    if (proc && proc.exitCode === null) {
      proc.kill('SIGTERM')
      await new Promise((resolve) => {
        proc!.once('exit', resolve)
        setTimeout(() => { try { proc!.kill('SIGKILL') } catch { /* dead */ } resolve(null) }, 2_000)
      })
    }
    for (const dir of [codexHome, cwd]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best-effort */ }
    }
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, rejectGuard) => {
    timer = setTimeout(() => rejectGuard(new Error(`probe timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS)
  })
  try {
    await Promise.race([runSmoke(), guard])
    process.exit(0)
  } catch (error) {
    console.error('\n[probe] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

void main()
