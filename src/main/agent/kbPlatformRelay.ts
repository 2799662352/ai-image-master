import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 运镜知识库 MCP 子进程 → 平台网关的本机中转。
 *
 * MCP 子进程的 env 在 codex spawn 时就定死了,而平台 token 跟着登录 / 登出 / 切计费池
 * 随时在变。所以子进程手里只有一枚只对这个端口有效的随机口令,平台凭据由中转在每个
 * 请求上现取:登录后不用重启 codex,登出后子进程也拿不到旧 token。
 */

/** 子进程只能打这三条;网关路径只在这里写死,子进程指定不了别的地址。 */
export const KB_RELAY_ROUTES: ReadonlyMap<string, string> = new Map([
  ['/knowledge/search', '/bailian/knowledge/search'],
  ['/embeddings', '/v1/embeddings'],
  ['/vector/query', '/dashvector/v1/query'],
])

/**
 * 中转自己判定「平台不可用」时用的两个错误码。子进程只在这两种情况、以及网关还没有这条
 * 路由 / 渠道时回落到用户自填的 Key;余额不足、上游报错这类是网关给出的答复,照原样交给
 * 子进程 —— 回落过去等于让用户的私钥替平台的故障买单。
 */
export const KB_RELAY_PLATFORM_UNAVAILABLE = 'platform_unavailable'
export const KB_RELAY_GATEWAY_UNREACHABLE = 'gateway_unreachable'

const MAX_REQUEST_BODY_BYTES = 1 << 20
const DEFAULT_UPSTREAM_TIMEOUT_MS = 60_000

export interface KbPlatformRelayOptions {
  gatewayOrigin: () => string
  /** 返回 null 表示此刻不能走平台(未登录 / 没选计费池)。 */
  platformHeaders: (target: URL) => Record<string, string> | null
  /** 网关回 2xx 之后调用:网关是在转发这次请求的事务里落账的,早报读到的是扣费前的余额。 */
  onSpend?: () => void
  fetchImpl?: typeof fetch
  upstreamTimeoutMs?: number
}

export interface KbPlatformRelay {
  /** `http://127.0.0.1:<port>`,不带路径。 */
  url: string
  token: string
  close: () => Promise<void>
}

function sendError(response: ServerResponse, status: number, code: string, message: string): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: { code, message } }))
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
  if (!header) return false
  const actual = Buffer.from(header)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** 超限时读完丢弃再回 413:提前 destroy 请求会连带掐掉响应,调用方只会看到连接被重置。 */
async function readBody(request: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size <= limit) chunks.push(buffer)
  }
  return size > limit ? null : Buffer.concat(chunks).toString('utf8')
}

export async function startKbPlatformRelay(options: KbPlatformRelayOptions): Promise<KbPlatformRelay> {
  const token = randomBytes(32).toString('hex')
  const expectedAuthorization = Buffer.from(`Bearer ${token}`)
  const fetchImpl = options.fetchImpl ?? fetch
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS

  const relay = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isAuthorized(request.headers.authorization, expectedAuthorization)) {
      sendError(response, 401, 'relay_unauthorized', 'Invalid relay token')
      return
    }
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    const gatewayPath = KB_RELAY_ROUTES.get(pathname)
    if (!gatewayPath) {
      sendError(response, 404, 'not_found', `No relay route for ${pathname}`)
      return
    }
    if (request.method !== 'POST') {
      sendError(response, 405, 'method_not_allowed', 'Only POST is relayed')
      return
    }
    const body = await readBody(request, MAX_REQUEST_BODY_BYTES)
    if (body === null) {
      sendError(response, 413, 'request_too_large', 'Request body exceeds 1 MiB')
      return
    }

    const target = new URL(gatewayPath, options.gatewayOrigin())
    const platformHeaders = options.platformHeaders(target)
    if (!platformHeaders) {
      sendError(
        response,
        401,
        KB_RELAY_PLATFORM_UNAVAILABLE,
        'Not signed in to the platform, or no billing pool is selected',
      )
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs)
    const abortOnClientClose = (): void => {
      if (!response.writableEnded) controller.abort()
    }
    response.on('close', abortOnClientClose)
    try {
      let upstream: Response
      try {
        upstream = await fetchImpl(target, {
          method: 'POST',
          headers: { ...platformHeaders, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          sendError(response, 504, 'gateway_timeout', `Gateway did not answer within ${upstreamTimeoutMs} ms`)
        } else {
          sendError(
            response,
            502,
            KB_RELAY_GATEWAY_UNREACHABLE,
            error instanceof Error ? error.message : String(error),
          )
        }
        return
      }

      let text: string
      try {
        text = await upstream.text()
      } catch (error) {
        // 网关已经答复了(可能已落账),这里不能报成 unreachable 让子进程再拿私钥重打一遍。
        sendError(
          response,
          502,
          'gateway_response_failed',
          error instanceof Error ? error.message : String(error),
        )
        return
      }
      if (upstream.ok) options.onSpend?.()
      response.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      })
      response.end(text)
    } finally {
      clearTimeout(timer)
      response.off('close', abortOnClientClose)
    }
  }

  const server = createServer((request, response) => {
    relay(request, response).catch((error: unknown) => {
      sendError(response, 500, 'relay_error', error instanceof Error ? error.message : String(error))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address() as AddressInfo
  let closed = false
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) {
        resolve()
        return
      }
      closed = true
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}
