// Offline measurement of the hidden thread-title request (the official codex
// TUI flow behind `runTemporaryStructuredTurn`) against the bundled binary.
//
// A local mock Responses endpoint records every request codex sends and
// answers the title request with a schema-shaped title, so the report shows
// what one title costs to send: body bytes, instructions, each input item,
// tools, and whether the global AGENTS.md, the memory summary, the skills list
// or MCP tools leaked into it.
//
// Safety: no network and no real key. A fresh temporary CODEX_HOME (removed
// afterwards) is seeded with copies of ~/.codex/AGENTS.md and
// ~/.codex/memories/memory_summary.md when they exist, so the numbers match
// this machine. The catimation MCP points at a dead port: if the thread-level
// `enabled=false` did not take, thread/start would wedge on rmcp retries and
// the run fails on its deadline.
//
// Usage: pnpm exec tsx scripts/smoke-thread-title.ts [--cwd <dir>] [--model <slug>] [--effort <low|default>]
// Worktree/CI: CODEX_RESOURCE_ROOT=<absolute-resources-path> pnpm exec tsx ...

import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import { resolveCodexBinary } from '../src/main/agent/paths'
import { pickFreePort } from '../src/main/agent/ports'
import {
  THREAD_TITLE_SOURCE,
  THREAD_TITLE_TIMEOUT_MS,
  parseThreadTitle,
  threadTitleOutputSchema,
  threadTitlePrompt,
} from '../src/main/agent/threadTitle'

const SMOKE_TIMEOUT_MS = 120_000
const SAMPLE_MESSAGE = '帮我把视频工作台里参考图满 12 张后加号消失的问题修好,顺便看看素材库缩略图为什么会破'
const MOCK_TITLE = '修复工作台加号与缩略图'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

interface RecordedRequest {
  method: string
  path: string
  bytes: number
  body: Record<string, unknown>
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rough o200k-style estimate: ~4 ASCII chars per token, ~1 token per CJK char. */
function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (const character of text) {
    if ((character.codePointAt(0) ?? 0) < 128) ascii += 1
    else other += 1
  }
  return Math.round(ascii / 4 + other)
}

function sse(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

function startMockResponses(): Promise<{ port: number; requests: RecordedRequest[]; close: () => void }> {
  const requests: RecordedRequest[] = []
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        } catch {
          // not JSON (GET probes)
        }
        requests.push({ method: req.method ?? '', path: req.url ?? '', bytes: raw.length, body })
        if (req.method !== 'POST' || !(req.url ?? '').endsWith('/responses')) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'not served by the smoke mock' } }))
          return
        }
        const text = JSON.stringify({ title: MOCK_TITLE })
        const message = { type: 'message', id: 'msg_smoke', role: 'assistant' }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(sse('response.created', { response: { id: 'resp_smoke' } }))
        res.write(sse('response.output_item.added', { output_index: 0, item: { ...message, content: [] } }))
        res.write(sse('response.output_text.delta', {
          item_id: 'msg_smoke', output_index: 0, content_index: 0, delta: text,
        }))
        res.write(sse('response.output_item.done', {
          output_index: 0,
          item: { ...message, content: [{ type: 'output_text', text, annotations: [] }] },
        }))
        res.write(sse('response.completed', {
          response: {
            id: 'resp_smoke',
            usage: {
              input_tokens: 0,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 0,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 0,
            },
          },
        }))
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ port, requests, close: () => server.close() })
    })
  })
}

async function resolveResourceRoot(): Promise<string> {
  const configured = process.env.CODEX_RESOURCE_ROOT?.trim()
  if (configured && !path.isAbsolute(configured)) {
    throw new Error(`CODEX_RESOURCE_ROOT must be absolute, got: ${configured}`)
  }
  const resourceRoot = configured || path.join(path.resolve(__dirname, '..'), 'resources')
  const binaryPath = resolveCodexBinary(resourceRoot)
  const binaryStat = await stat(binaryPath).catch((error: unknown) => {
    throw new Error(`Codex binary not found at ${binaryPath}: ${errorMessage(error)}`)
  })
  if (!binaryStat.isFile()) throw new Error(`Codex binary path is not a file: ${binaryPath}`)
  return resourceRoot
}

/** First line long enough to be distinctive; used to detect a file's text in the request. */
async function markerLine(file: string): Promise<string | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  return text?.split(/\r?\n/u).map((line) => line.trim()).find((line) => line.length >= 24)
}

async function seedCodexHome(codexHome: string): Promise<{ agentsMarker?: string; memoryMarker?: string }> {
  const realHome = path.join(os.homedir(), '.codex')
  const node = JSON.stringify(process.execPath)
  await writeFile(path.join(codexHome, 'config.toml'), [
    '[mcp_servers.apiyi]',
    `command = ${node}`,
    'args = ["-e", "process.exit(0)"]',
    'enabled = false',
    '',
    '[mcp_servers.cinematography_kb]',
    `command = ${node}`,
    'args = ["-e", "process.exit(0)"]',
    'enabled = false',
    '',
  ].join('\n'), 'utf8')

  const agentsSource = path.join(realHome, 'AGENTS.md')
  const agentsMarker = await markerLine(agentsSource)
  if (agentsMarker) await copyFile(agentsSource, path.join(codexHome, 'AGENTS.md'))

  const memorySource = path.join(realHome, 'memories', 'memory_summary.md')
  const memoryMarker = await markerLine(memorySource)
  if (memoryMarker) {
    await mkdir(path.join(codexHome, 'memories'), { recursive: true })
    await copyFile(memorySource, path.join(codexHome, 'memories', 'memory_summary.md'))
  }
  return { agentsMarker, memoryMarker }
}

function contentTexts(item: Record<string, unknown>): string[] {
  const content = Array.isArray(item.content) ? item.content : []
  return content
    .map((part) => (part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined))
    .filter((text): text is string => typeof text === 'string')
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/u).map((part) => part.trim()).find((part) => part.length > 0) ?? ''
  return line.length > 60 ? `${line.slice(0, 60)}...` : line
}

function report(
  request: RecordedRequest,
  markers: { agentsMarker?: string; memoryMarker?: string },
): void {
  const body = request.body
  const instructions = typeof body.instructions === 'string' ? body.instructions : ''
  const input = Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : []
  const tools = Array.isArray(body.tools) ? (body.tools as Record<string, unknown>[]) : []
  const toolsJson = JSON.stringify(tools)
  const format = (body.text as Record<string, unknown> | undefined)?.format as Record<string, unknown> | undefined

  const inputTexts = input.flatMap(contentTexts)
  const allText = [instructions, ...inputTexts].join('\n')
  const total = estimateTokens(instructions) + inputTexts.reduce((sum, text) => sum + estimateTokens(text), 0)
    + estimateTokens(toolsJson) + estimateTokens(JSON.stringify(format ?? {}))

  console.log(`\n[measure] POST ${request.path}  body=${request.bytes} bytes  ~${total} tokens (estimate)`)
  console.log(`  model=${String(body.model)}  reasoning=${JSON.stringify(body.reasoning ?? null)}  store=${String(body.store)}`)
  console.log(`  text.format=${format ? `${String(format.type)}${format.name ? ` (${String(format.name)})` : ''}` : 'absent'}`)
  console.log(`  instructions: ${Buffer.byteLength(instructions, 'utf8')} bytes ~${estimateTokens(instructions)} tokens`)
  input.forEach((item, index) => {
    const texts = contentTexts(item)
    const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0)
    const tokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0)
    const label = String(item.role ?? item.type)
    console.log(`  input[${index}] ${label}: ${bytes} bytes ~${tokens} tokens  parts=${texts.length}`)
    for (const text of texts) console.log(`      - ${Buffer.byteLength(text, 'utf8')}B  ${firstLine(text)}`)
  })
  const toolNames = tools.map((tool) => String(tool.name ?? tool.type))
  console.log(`  tools: ${tools.length} (${Buffer.byteLength(toolsJson, 'utf8')} bytes ~${estimateTokens(toolsJson)} tokens) ${toolNames.join(', ')}`)
  console.log('  leaks:')
  console.log(`    global ~/.codex/AGENTS.md : ${markers.agentsMarker ? allText.includes(markers.agentsMarker) : 'n/a (no file)'}`)
  console.log(`    memory_summary.md         : ${markers.memoryMarker ? allText.includes(markers.memoryMarker) : 'n/a (no file)'}`)
  console.log(`    skills list (SKILL.md)    : ${allText.includes('SKILL.md')}`)
  console.log(`    catimation / MCP tools    : ${toolNames.some((name) => /catimation|mcp__|generate_image/u.test(name))}`)
}

async function runSmoke(): Promise<void> {
  const resourceRoot = await resolveResourceRoot()
  const model = argValue('--model') ?? 'gpt-5.5'
  const effort = argValue('--effort') ?? 'low'
  const codexHome = await mkdtemp(path.join(os.tmpdir(), 'catimation-thread-title-smoke-'))
  const emptyCwd = await mkdtemp(path.join(os.tmpdir(), 'catimation-thread-title-cwd-'))
  const cwd = argValue('--cwd') ?? emptyCwd
  const mock = await startMockResponses()
  let backend: CodexLocalBackend | undefined
  try {
    const markers = await seedCodexHome(codexHome)
    const deadPort = await pickFreePort(47_000)
    backend = new CodexLocalBackend({
      resourceRoot,
      codexHome,
      connectTimeoutMs: 10_000,
      getApiKey: () => 'sk-smoke-offline',
      experimentalApi: true,
      provider: {
        id: 'smoke-mock',
        name: 'Smoke Mock',
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        envKey: 'OPENAI_API_KEY',
        model,
      },
      catimationMcp: { port: deadPort, token: 'smoke-offline' },
    })
    await backend.start()
    console.log(`[smoke] codex started (CODEX_HOME=${codexHome}, cwd=${cwd}, model=${model}, effort=${effort})`)

    const startedAt = Date.now()
    const result = await backend.runTemporaryStructuredTurn({
      threadSource: THREAD_TITLE_SOURCE,
      model,
      ...(effort === 'default' ? {} : { effort }),
      cwd,
      prompt: threadTitlePrompt(SAMPLE_MESSAGE),
      outputSchema: threadTitleOutputSchema(),
      timeoutMs: THREAD_TITLE_TIMEOUT_MS,
    })
    console.log(`[smoke] hidden title turn finished in ${Date.now() - startedAt}ms -> parsed title: ${parseThreadTitle(result.text)}`)

    console.log(`[smoke] upstream requests: ${mock.requests.map((r) => `${r.method} ${r.path}`).join(' | ') || '(none)'}`)
    const titleRequests = mock.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/responses'))
    if (titleRequests.length !== 1) throw new Error(`expected exactly 1 Responses request, saw ${titleRequests.length}`)
    report(titleRequests[0], markers)
  } finally {
    await backend?.stop().catch(() => undefined)
    mock.close()
    for (const dir of [codexHome, emptyCwd]) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error: unknown) => {
        console.warn(`[smoke] temp dir cleanup deferred (${errorMessage(error)}): ${dir}`)
      })
    }
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)), SMOKE_TIMEOUT_MS)
    timer.unref?.()
  })
  try {
    await Promise.race([runSmoke(), guard])
    console.log('\n[smoke] PASS')
  } catch (error) {
    console.error('\n[smoke] FAIL:', errorMessage(error))
    process.exitCode = 1
  } finally {
    if (timer) clearTimeout(timer)
  }
}

void main()
