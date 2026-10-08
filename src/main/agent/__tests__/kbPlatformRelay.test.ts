import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  KB_RELAY_ROUTES,
  startKbPlatformRelay,
  type KbPlatformRelay,
  type KbPlatformRelayOptions,
} from '../kbPlatformRelay'

interface GatewayCall {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}

interface FakeGateway {
  origin: string
  calls: GatewayCall[]
  close: () => Promise<void>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function startFakeGateway(
  respond: (call: GatewayCall, response: ServerResponse) => void,
): Promise<FakeGateway> {
  const calls: GatewayCall[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const call: GatewayCall = {
      method: request.method ?? '',
      path: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    }
    calls.push(call)
    respond(call, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  const gateway: FakeGateway = {
    origin: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
  cleanups.push(gateway.close)
  return gateway
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

const PLATFORM_HEADERS = {
  Authorization: 'Bearer platform-pool-token',
  'X-Platform-User-Id': '31',
  'X-Project-Id': '7',
}

async function startRelay(overrides: Partial<KbPlatformRelayOptions> & Pick<KbPlatformRelayOptions, 'gatewayOrigin'>) {
  const relay = await startKbPlatformRelay({
    platformHeaders: () => ({ ...PLATFORM_HEADERS }),
    ...overrides,
  })
  cleanups.push(relay.close)
  return relay
}

async function callRelay(
  relay: KbPlatformRelay,
  path: string,
  init: { method?: string; token?: string | null; body?: string } = {},
): Promise<{ status: number; body: string; json: () => any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = init.token === undefined ? relay.token : init.token
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const method = init.method ?? 'POST'
  const response = await fetch(`${relay.url}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : (init.body ?? '{}'),
  })
  const body = await response.text()
  return { status: response.status, body, json: () => JSON.parse(body) }
}

describe('kbPlatformRelay', () => {
  it('三条路由各自转发到网关上写死的路径:带平台凭据、不带中转口令,原样回传并记一次消费', async () => {
    const gateway = await startFakeGateway((call, response) => {
      json(response, 200, { echoedPath: call.path })
    })
    const onSpend = vi.fn()
    const platformHeaders = vi.fn(() => ({ ...PLATFORM_HEADERS }))
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin, platformHeaders, onSpend })

    for (const [relayPath, gatewayPath] of KB_RELAY_ROUTES) {
      const body = JSON.stringify({ model: 'cinematography-kb', query: `q ${relayPath}` })
      const result = await callRelay(relay, relayPath, { body })
      expect(result.status).toBe(200)
      expect(result.json()).toEqual({ echoedPath: gatewayPath })
    }

    expect(gateway.calls.map((call) => call.path)).toEqual([
      '/bailian/knowledge/search',
      '/v1/embeddings',
      '/dashvector/v1/query',
    ])
    for (const call of gateway.calls) {
      expect(call.method).toBe('POST')
      expect(call.headers.authorization).toBe('Bearer platform-pool-token')
      expect(call.headers['x-project-id']).toBe('7')
      expect(call.headers['x-platform-user-id']).toBe('31')
      expect(call.headers.authorization).not.toContain(relay.token)
    }
    expect(JSON.parse(gateway.calls[0].body)).toEqual({ model: 'cinematography-kb', query: 'q /knowledge/search' })
    expect(platformHeaders.mock.calls.map(([target]) => String(target))).toEqual([
      `${gateway.origin}/bailian/knowledge/search`,
      `${gateway.origin}/v1/embeddings`,
      `${gateway.origin}/dashvector/v1/query`,
    ])
    expect(onSpend).toHaveBeenCalledTimes(3)
  })

  it('没登录或没选计费池:回 401 platform_unavailable,不打网关、不记消费', async () => {
    const gateway = await startFakeGateway((_call, response) => json(response, 200, {}))
    const onSpend = vi.fn()
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin, platformHeaders: () => null, onSpend })

    const result = await callRelay(relay, '/knowledge/search')

    expect(result.status).toBe(401)
    expect(result.json().error.code).toBe('platform_unavailable')
    expect(gateway.calls).toHaveLength(0)
    expect(onSpend).not.toHaveBeenCalled()
  })

  it('中转口令缺失或不对:401 relay_unauthorized,连平台凭据都不取', async () => {
    const gateway = await startFakeGateway((_call, response) => json(response, 200, {}))
    const platformHeaders = vi.fn(() => ({ ...PLATFORM_HEADERS }))
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin, platformHeaders })

    const missing = await callRelay(relay, '/knowledge/search', { token: null })
    const wrong = await callRelay(relay, '/knowledge/search', { token: `${relay.token.slice(0, -1)}0` })

    expect(missing.status).toBe(401)
    expect(missing.json().error.code).toBe('relay_unauthorized')
    expect(wrong.status).toBe(401)
    expect(wrong.json().error.code).toBe('relay_unauthorized')
    expect(platformHeaders).not.toHaveBeenCalled()
    expect(gateway.calls).toHaveLength(0)
  })

  it('只认三条路由、只认 POST', async () => {
    const gateway = await startFakeGateway((_call, response) => json(response, 200, {}))
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin })

    const unknown = await callRelay(relay, '/v1/chat/completions')
    const traversal = await callRelay(relay, '/knowledge/search/../../v1/chat/completions')
    const wrongMethod = await callRelay(relay, '/knowledge/search', { method: 'GET' })

    expect(unknown.status).toBe(404)
    expect(traversal.status).toBe(404)
    expect(wrongMethod.status).toBe(405)
    expect(gateway.calls).toHaveLength(0)
  })

  it('网关的错误答复原样回传(状态码与正文),不记消费', async () => {
    const quotaError = { error: { code: 'insufficient_user_quota', message: '用户额度不足' } }
    const gateway = await startFakeGateway((_call, response) => json(response, 403, quotaError))
    const onSpend = vi.fn()
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin, onSpend })

    const result = await callRelay(relay, '/vector/query')

    expect(result.status).toBe(403)
    expect(result.json()).toEqual(quotaError)
    expect(onSpend).not.toHaveBeenCalled()
  })

  it('网关连不上:502 gateway_unreachable', async () => {
    const relay = await startRelay({
      gatewayOrigin: () => 'https://gateway.invalid',
      fetchImpl: (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch,
    })

    const result = await callRelay(relay, '/embeddings')

    expect(result.status).toBe(502)
    expect(result.json().error.code).toBe('gateway_unreachable')
  })

  it('网关迟迟不答:到点回 504 gateway_timeout,而不是 gateway_unreachable', async () => {
    const gateway = await startFakeGateway(() => { /* never answers */ })
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin, upstreamTimeoutMs: 100 })

    const result = await callRelay(relay, '/knowledge/search')

    expect(result.status).toBe(504)
    expect(result.json().error.code).toBe('gateway_timeout')
  })

  it('请求体超过 1 MiB:413,不打网关', async () => {
    const gateway = await startFakeGateway((_call, response) => json(response, 200, {}))
    const relay = await startRelay({ gatewayOrigin: () => gateway.origin })

    const result = await callRelay(relay, '/vector/query', { body: 'x'.repeat((1 << 20) + 1) })

    expect(result.status).toBe(413)
    expect(gateway.calls).toHaveLength(0)
  })

  it('每次启动一枚新口令,close 可重复调用', async () => {
    const first = await startKbPlatformRelay({ gatewayOrigin: () => 'https://gateway.invalid', platformHeaders: () => null })
    const second = await startKbPlatformRelay({ gatewayOrigin: () => 'https://gateway.invalid', platformHeaders: () => null })

    expect(first.token).toMatch(/^[0-9a-f]{64}$/)
    expect(second.token).not.toBe(first.token)
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    await first.close()
    await first.close()
    await second.close()
  })
})
