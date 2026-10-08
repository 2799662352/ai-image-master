/**
 * cinematography-kb-mcp 的平台计费模式:两个检索工具先打主进程的本机中转,只有
 * 「平台根本服务不了」才回落到用户自填的 Key。假中转是一台本机 HTTP 服务器,
 * 自填 Key 一律不设 —— 走错分支就会变成真的出网,断言会先失败。
 */
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

type ToolResult = { success: boolean; text?: string; error?: string; detail?: string }

const req = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mcp = req(path.resolve(__dirname, '../../../../resources/cinematography-kb-mcp/index.js')) as {
  platformRelayFromEnv: (env: Record<string, string | undefined>) => { hostname: string; port: number; token: string } | null
  platformUnavailableReason: (res: { status: number; body?: string; timedOut?: boolean; answered?: boolean }) => string | null
  searchKb: (query: string, topK?: unknown) => Promise<ToolResult>
  querySakuga: (args: Record<string, unknown>) => Promise<ToolResult>
}

const ENV_KEYS = [
  'CATIMATION_KB_RELAY_URL',
  'CATIMATION_KB_RELAY_TOKEN',
  'DASHSCOPE_API_KEY',
  'DASHVECTOR_API_KEY',
  'DASHVECTOR_ENDPOINT',
] as const
const RELAY_TOKEN = 'relay-token-for-test'

interface RelayCall {
  path: string
  authorization: string | undefined
  body: any
}

type Answer = { status: number; body: unknown }

let savedEnv: Record<string, string | undefined> = {}
const cleanups: Array<() => Promise<void>> = []

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** 起假中转并把地址 / 口令写进 env,就像 codex 拉起 MCP 子进程时那样。 */
async function startFakeRelay(routes: Record<string, (body: any) => Answer>): Promise<RelayCall[]> {
  const calls: RelayCall[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    calls.push({ path: request.url ?? '', authorization: request.headers.authorization, body })
    const route = routes[request.url ?? '']
    const answer = route ? route(body) : { status: 404, body: { error: { code: 'not_found' } } }
    const isText = typeof answer.body === 'string'
    response.writeHead(answer.status, { 'Content-Type': isText ? 'text/html' : 'application/json' })
    response.end(isText ? (answer.body as string) : JSON.stringify(answer.body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  cleanups.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  process.env.CATIMATION_KB_RELAY_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.CATIMATION_KB_RELAY_TOKEN = RELAY_TOKEN
  return calls
}

const gatewayError = (code: string, message = '') => ({ error: { code, message, type: 'new_api_error' } })
const vector512 = () => Array.from({ length: 512 }, (_, i) => i / 512)

describe('platformRelayFromEnv', () => {
  it('只认明文 http 的本机地址,其余一律当没有中转', () => {
    expect(mcp.platformRelayFromEnv({ CATIMATION_KB_RELAY_URL: 'http://127.0.0.1:5100', CATIMATION_KB_RELAY_TOKEN: 't' }))
      .toEqual({ hostname: '127.0.0.1', port: 5100, token: 't' })
    expect(mcp.platformRelayFromEnv({ CATIMATION_KB_RELAY_URL: 'http://[::1]:5100', CATIMATION_KB_RELAY_TOKEN: 't' }))
      .toEqual({ hostname: '::1', port: 5100, token: 't' })
    expect(mcp.platformRelayFromEnv({ CATIMATION_KB_RELAY_URL: 'http://localhost:5100', CATIMATION_KB_RELAY_TOKEN: 't' }))
      .toEqual({ hostname: 'localhost', port: 5100, token: 't' })

    for (const url of [
      'https://127.0.0.1:5100',
      'http://10.0.0.5:5100',
      'http://miauapi.13797248455.xyz',
      'not a url',
    ]) {
      expect(mcp.platformRelayFromEnv({ CATIMATION_KB_RELAY_URL: url, CATIMATION_KB_RELAY_TOKEN: 't' })).toBeNull()
    }
    expect(mcp.platformRelayFromEnv({ CATIMATION_KB_RELAY_URL: 'http://127.0.0.1:5100' })).toBeNull()
    expect(mcp.platformRelayFromEnv({})).toBeNull()
  })
})

describe('platformUnavailableReason', () => {
  const answer = (status: number, body: unknown) => ({
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

  it('平台服务不了的几种情况才回落', () => {
    expect(mcp.platformUnavailableReason(answer(401, gatewayError('platform_unavailable')))).toBe('signed_out')
    expect(mcp.platformUnavailableReason(answer(502, gatewayError('gateway_unreachable')))).toBe('gateway_unreachable')
    // 还没部署这条路由的网关:JSON 404,或者前端页面配 200。
    expect(mcp.platformUnavailableReason(answer(404, {
      error: { message: 'Invalid URL (POST /bailian/knowledge/search)', type: 'invalid_request_error', param: '', code: '' },
    }))).toBe('not_offered')
    expect(mcp.platformUnavailableReason(answer(200, '<!doctype html><html></html>'))).toBe('not_offered')
    // 用户分组下没有配这个模型的渠道。
    expect(mcp.platformUnavailableReason(answer(503, gatewayError('model_not_found')))).toBe('not_offered')
    expect(mcp.platformUnavailableReason({ status: 0 })).toBe('relay_unreachable')
  })

  it('网关给出的答复不回落:余额、定价、上游报错、超时都原样交给 agent', () => {
    expect(mcp.platformUnavailableReason(answer(403, gatewayError('insufficient_user_quota')))).toBeNull()
    expect(mcp.platformUnavailableReason(answer(500, gatewayError('model_price_error')))).toBeNull()
    expect(mcp.platformUnavailableReason(answer(404, gatewayError('bad_response_status_code')))).toBeNull()
    expect(mcp.platformUnavailableReason(answer(401, gatewayError('relay_unauthorized')))).toBeNull()
    expect(mcp.platformUnavailableReason(answer(504, gatewayError('gateway_timeout')))).toBeNull()
    expect(mcp.platformUnavailableReason(answer(200, { success: true, data: { nodes: [] } }))).toBeNull()
    expect(mcp.platformUnavailableReason({ status: 0, timedOut: true })).toBeNull()
    expect(mcp.platformUnavailableReason({ status: 0, answered: true })).toBeNull()
  })
})

describe('search_cinematography_kb 走平台', () => {
  it('登录后按平台模型名发给中转,带中转口令,不带 agent_id', async () => {
    const calls = await startFakeRelay({
      '/knowledge/search': () => ({
        status: 200,
        body: {
          success: true,
          data: { nodes: [{ score: 0.91, node: { text: '推镜头 dolly in:镜头沿光轴前移', metadata: { doc_name: '运镜基元' } } }] },
        },
      }),
    })

    const result = await mcp.searchKb('推镜头', 5)

    expect(result.success).toBe(true)
    expect(result.text).toContain('推镜头 dolly in')
    expect(result.text).toContain('运镜基元')
    expect(calls).toHaveLength(1)
    expect(calls[0].path).toBe('/knowledge/search')
    expect(calls[0].authorization).toBe(`Bearer ${RELAY_TOKEN}`)
    expect(calls[0].body).toEqual({ model: 'cinematography-kb', query: '推镜头', dense_similarity_top_k: 5 })
  })

  it('没登录且没填 Key:告诉用户两条路', async () => {
    await startFakeRelay({
      '/knowledge/search': () => ({ status: 401, body: gatewayError('platform_unavailable') }),
    })

    const result = await mcp.searchKb('推镜头')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Not signed in to the platform')
    expect(result.error).toContain('DASHSCOPE_API_KEY')
  })

  it('余额不足照实报,不拿用户自填的 Key 再打一遍', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-own-key-must-not-be-used'
    const calls = await startFakeRelay({
      '/knowledge/search': () => ({ status: 403, body: gatewayError('insufficient_user_quota', '用户额度不足') }),
    })

    const result = await mcp.searchKb('推镜头')

    expect(result).toEqual({
      success: false,
      error: 'Platform billing request failed: HTTP 403 insufficient_user_quota',
      detail: '用户额度不足',
    })
    expect(calls).toHaveLength(1)
  })

  it('没有中转时行为与之前一致', async () => {
    const result = await mcp.searchKb('推镜头')
    expect(result).toEqual({ success: false, error: 'Environment variable DASHSCOPE_API_KEY is not set.' })
  })
})

describe('query_sakuga_dataset 走平台', () => {
  it('嵌入与向量检索都走中转,不需要 DashVector Key', async () => {
    const calls = await startFakeRelay({
      '/embeddings': () => ({ status: 200, body: { object: 'list', data: [{ index: 0, embedding: vector512() }] } }),
      '/vector/query': () => ({
        status: 200,
        body: {
          code: 0,
          output: [{ id: '102939_9', score: 0.12, fields: { identifier: '102939_9', text_description: '角色冲刺的作画片段' } }],
        },
      }),
    })

    const result = await mcp.querySakuga({ query: '跑步作画', top_k: 3, filter: 'aesthetic_score > 5' })

    expect(result.success).toBe(true)
    expect(result.text).toContain('角色冲刺的作画片段')
    expect(calls.map((call) => call.path)).toEqual(['/embeddings', '/vector/query'])
    expect(calls[0].body).toEqual({
      model: 'text-embedding-v4',
      input: '跑步作画',
      dimensions: 512,
      encoding_format: 'float',
    })
    expect(calls[1].body).toMatchObject({
      model: 'sakuga-dataset',
      topk: 3,
      include_vector: false,
      filter: 'aesthetic_score > 5',
    })
    expect(calls[1].body.vector).toHaveLength(512)
    expect(calls[1].body.output_fields).toContain('text_description')
    for (const call of calls) expect(call.authorization).toBe(`Bearer ${RELAY_TOKEN}`)
  })

  it('网关没配 DashVector 渠道且没填 Key:说清是哪一步缺了什么', async () => {
    await startFakeRelay({
      '/embeddings': () => ({ status: 200, body: { data: [{ embedding: vector512() }] } }),
      '/vector/query': () => ({ status: 503, body: gatewayError('model_not_found') }),
    })

    const result = await mcp.querySakuga({ query: '跑步作画' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('does not offer this search yet')
    expect(result.error).toContain('DASHVECTOR_API_KEY')
  })

  it('嵌入维度对不上集合时直接报错,不去查向量', async () => {
    const calls = await startFakeRelay({
      '/embeddings': () => ({ status: 200, body: { data: [{ embedding: new Array(1024).fill(0) }] } }),
    })

    const result = await mcp.querySakuga({ query: '跑步作画' })

    expect(result.success).toBe(false)
    expect(result.error).toContain('1024 dimensions')
    expect(calls.map((call) => call.path)).toEqual(['/embeddings'])
  })

  it('上游 DashVector 报错码:不算成功', async () => {
    await startFakeRelay({
      '/embeddings': () => ({ status: 200, body: { data: [{ embedding: vector512() }] } }),
      '/vector/query': () => ({ status: 200, body: { code: -2021, message: 'collection not exist' } }),
    })

    const result = await mcp.querySakuga({ query: '跑步作画' })

    expect(result).toEqual({ success: false, error: 'DashVector code -2021', detail: 'collection not exist' })
  })

  it('没有中转时行为与之前一致', async () => {
    const result = await mcp.querySakuga({ query: '跑步作画' })
    expect(result).toEqual({
      success: false,
      error: 'Environment variable(s) not set: DASHVECTOR_API_KEY, DASHVECTOR_ENDPOINT',
    })
  })
})
