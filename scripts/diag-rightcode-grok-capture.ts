// Capture the EXACT JSON codex sends to rightapi.ai/grok on a 2-turn chat.
// Spawns the real bundled codex app-server through CodexLocalBackend with the
// rightcode-grok channel config, but base_url pointed at a local logging proxy
// that forwards to the real gateway and dumps every request body + upstream
// status to scripts/.diag-grok/.
//
// Usage: npx tsx scripts/diag-rightcode-grok-capture.ts <RIGHTCODE_KEY>

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import type { AgentStreamEvent } from '../src/types/agent'

const KEY = process.argv[2]
if (!KEY) {
  console.error('usage: npx tsx scripts/diag-rightcode-grok-capture.ts <RIGHTCODE_KEY>')
  process.exit(1)
}

const UPSTREAM = 'https://rightapi.ai/grok/v1'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const outDir = path.join(projectRoot, 'scripts', '.diag-grok')
mkdirSync(outDir, { recursive: true })

let requestCounter = 0

async function startCaptureProxy(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = Buffer.concat(chunks)
    const index = ++requestCounter
    const stamp = `${String(index).padStart(2, '0')}`
    writeFileSync(path.join(outDir, `req-${stamp}.json`), body)
    console.log(`[capture] #${index} ${request.method} ${request.url} (${body.length}B)`)

    const target = `${UPSTREAM}${request.url ?? ''}`
    try {
      const headers: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value !== 'string') continue
        const lower = name.toLowerCase()
        if (lower === 'host' || lower === 'content-length' || lower === 'connection') continue
        headers[name] = value
      }
      const upstream = await fetch(target, {
        method: request.method ?? 'POST',
        headers,
        body: body.length > 0 ? body : undefined,
        // @ts-expect-error node fetch duplex
        duplex: 'half',
      })
      console.log(`[capture] #${index} → HTTP ${upstream.status}`)
      response.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
      })
      if (upstream.status >= 400) {
        const text = await upstream.text()
        writeFileSync(path.join(outDir, `res-${stamp}-err.txt`), text)
        console.log(`[capture] #${index} error body: ${text.slice(0, 300)}`)
        response.end(text)
        return
      }
      if (upstream.body) {
        const reader = upstream.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          response.write(value)
        }
      }
      response.end()
    } catch (error) {
      console.error(`[capture] #${index} proxy failure:`, error)
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'capture proxy failure' }))
    }
  })
  server.keepAliveTimeout = 120_000
  server.headersTimeout = 125_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function runTurn(
  backend: CodexLocalBackend,
  threadId: string | undefined,
  text: string,
): Promise<string | undefined> {
  console.log(`\n[turn] user: ${text}`)
  const stream = backend.send(threadId, {
    items: [{ type: 'text', text }],
  }) as AsyncIterable<AgentStreamEvent>
  let resolvedThreadId = threadId
  for await (const event of stream) {
    const withThread = event as { threadId?: string }
    if (!resolvedThreadId && withThread.threadId) resolvedThreadId = withThread.threadId
    if (event.type === 'error') {
      console.log(`[turn] ERROR event: ${JSON.stringify(event).slice(0, 400)}`)
    }
    if (event.type === 'turn_completed') console.log('[turn] completed')
  }
  return resolvedThreadId
}

async function main(): Promise<void> {
  // The user's system HTTP proxy must not swallow loopback traffic to the
  // capture listener; codex's reqwest honors NO_PROXY.
  process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1,localhost']
    .filter(Boolean)
    .join(',')
  process.env.no_proxy = process.env.NO_PROXY
  const proxy = await startCaptureProxy()
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'diag-grok-codex-'))
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      '[mcp_servers.apiyi]',
      'command = "node"',
      'args = []',
      'enabled = false',
      '',
      '[mcp_servers.cinematography_kb]',
      'command = "node"',
      'args = []',
      'enabled = false',
      '',
    ].join('\n'),
    'utf8',
  )

  const backend = new CodexLocalBackend({
    resourceRoot: path.join(projectRoot, 'resources'),
    codexHome,
    getApiKey: () => KEY,
    catimationMcp: { port: 59998, token: 'diag-token' },
    provider: {
      id: 'rightcode-grok',
      name: 'Right.Codes Grok',
      baseUrl: proxy.baseUrl,
      envKey: 'OPENAI_API_KEY',
      model: 'grok-4.5',
      requiresOpenaiAuth: true,
      // Production channel policy: codex → compat proxy (null-sanitize +
      // namespace flatten) → capture proxy → rightapi.ai.
      compatibilityPolicy: 'responses-namespace-bridge',
    },
  })

  try {
    await backend.start()
    console.log('[diag] codex started')
    const threadId = await runTurn(backend, undefined, '用一句话回答:1+1=?')
    console.log(`[diag] thread: ${threadId}`)
    await runTurn(backend, threadId, '你是谁')
    console.log(`\n[diag] done — captured bodies in ${outDir}`)
  } finally {
    await backend.stop().catch(() => undefined)
    await proxy.close()
  }
}

main().catch((error) => {
  console.error('[diag] crashed:', error)
  process.exit(1)
})
