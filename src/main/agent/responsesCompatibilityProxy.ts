import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import type { CodexProviderConfig } from './codexLaunch'
import { inferModelFamily } from './gatewayModelRouting'

type JsonObject = Record<string, unknown>

export interface NamespaceToolBinding {
  flatName: string
  namespace: string
  name: string
}

export interface FlattenedResponsesRequest<T extends JsonObject> {
  body: T
  bindings: NamespaceToolBinding[]
}

export interface ResponsesCompatibilityProxy {
  baseUrl: string
  /** Effective idle keep-alive window applied to the loopback server. */
  keepAliveTimeoutMs: number
  /** Effective headers timeout applied to the loopback server. */
  headersTimeoutMs: number
  close: () => Promise<void>
}

/**
 * codex-rs (reqwest/hyper) keeps pooled connections idle for ~90s. Node's
 * http.Server default keepAliveTimeout is 5s, so the proxy would close the
 * idle socket first and the client's next turn on the reused connection dies
 * with ECONNRESET. Keep the server side open well past the client pool window
 * so the client always closes first; headersTimeout must stay strictly above
 * keepAliveTimeout so a request racing the idle close isn't cut off while its
 * headers are in flight (and both stay below Node's 300s requestTimeout).
 */
export const PROXY_KEEP_ALIVE_TIMEOUT_MS = 120_000
export const PROXY_HEADERS_TIMEOUT_MS = 125_000

export interface ProviderCompatibilityProxyGroup {
  providers: CodexProviderConfig[]
  close: () => Promise<void>
}

/**
 * Never-regress guard for xAI-backed channels. Upstream codex serializes
 * replayed reasoning history with `content: null` and closed the report as
 * "provider's problem" (openai/codex#11834), so xAI's untagged ModelInput
 * enum 422s every second turn unless our bridge strips the nulls. Any channel
 * that can serve a grok-family model therefore MUST run through the bridge —
 * even when its preset (or a user-defined custom provider) forgot to declare
 * `compatibilityPolicy: 'responses-namespace-bridge'`.
 */
function providerServesXaiModels(provider: BridgeCandidateProvider): boolean {
  const models = [provider.model, ...(provider.allowedModels ?? [])]
  return models.some(
    (model) => typeof model === 'string' && inferModelFamily(model) === 'xai',
  )
}

/**
 * Channel shape the bridge decision understands. `allowedModels` comes from
 * `ProviderChannelPreset` (multi-model channels); plain custom providers only
 * carry `model`.
 */
export type BridgeCandidateProvider = CodexProviderConfig & {
  allowedModels?: readonly string[]
}

/** Returns whether a provider channel needs the Responses namespace bridge. */
export function shouldStartResponsesCompatibilityProxy(
  provider: BridgeCandidateProvider | undefined,
): boolean {
  if (!provider) return false
  const policy = provider.compatibilityPolicy ?? 'none'
  switch (policy) {
    case 'none':
      return providerServesXaiModels(provider)
    case 'responses-namespace-bridge':
      return true
    default: {
      const exhaustive: never = policy
      throw new Error(`Unsupported compatibility policy: ${String(exhaustive)}`)
    }
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJson(item)) as T
  }
  if (!isJsonObject(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
  ) as T
}

function bindingKey(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`
}

function rewriteRequestCalls(
  value: unknown,
  bindingByIdentity: Map<string, NamespaceToolBinding>,
  bindings: NamespaceToolBinding[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteRequestCalls(item, bindingByIdentity, bindings)
    return
  }
  if (!isJsonObject(value)) return

  if (
    value.type === 'function_call'
    && typeof value.namespace === 'string'
    && typeof value.name === 'string'
  ) {
    const key = bindingKey(value.namespace, value.name)
    let binding = bindingByIdentity.get(key)
    if (!binding) {
      binding = {
        flatName: `${value.namespace}__${value.name}`,
        namespace: value.namespace,
        name: value.name,
      }
      bindingByIdentity.set(key, binding)
      bindings.push(binding)
    }
    value.name = binding.flatName
    delete value.namespace
  }
  for (const item of Object.values(value)) {
    rewriteRequestCalls(item, bindingByIdentity, bindings)
  }
}

/**
 * Removes null-valued fields from every replayed `input` item.
 *
 * Codex serializes reasoning history it plays back on later turns as
 * `"content": null` / `"encrypted_content": null`. xAI's Responses `input`
 * is a Rust untagged enum (`ModelInput`); an explicit `content: null` makes
 * the WHOLE request fail to deserialize with HTTP 422, while omitting the
 * field is accepted (verified live against rightapi.ai/grok — turn 1 passed,
 * every turn 2 failed). Omission and null are semantically identical for a
 * request payload, so stripping nulls is safe for every Responses server.
 */
function stripNullInputItemFields(body: JsonObject): void {
  if (!Array.isArray(body.input)) return
  for (const item of body.input) {
    if (!isJsonObject(item)) continue
    for (const [key, value] of Object.entries(item)) {
      if (value === null) delete item[key]
    }
  }
}

const ENCRYPTED_REPLAY_ITEM_TYPES = new Set(['reasoning', 'compaction'])

/**
 * Drops replayed reasoning/compaction items that carry provider-bound
 * `encrypted_content`.
 *
 * Cross-channel continuation (a GPT thread switched to grok) replays history
 * containing OpenAI-encrypted reasoning blobs; xAI cannot decrypt them and
 * fails the whole turn with "Could not decrypt the provided encrypted_content"
 * (openai/codex #17541). Upstream guidance (#25290) is to remove the WHOLE
 * item — blanking only the field turns the error into "Missing required
 * parameter: input[N].encrypted_content". Safe on bridged (xAI-family)
 * channels: grok itself replays reasoning with `encrypted_content: null`
 * (verified via live capture), so any non-empty blob here is by construction
 * foreign replay data the upstream could never use anyway.
 */
function dropForeignEncryptedReplayItems(body: JsonObject): void {
  if (!Array.isArray(body.input)) return
  body.input = body.input.filter((item) => {
    if (!isJsonObject(item)) return true
    if (typeof item.type !== 'string' || !ENCRYPTED_REPLAY_ITEM_TYPES.has(item.type)) return true
    return typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0
  })
}

/**
 * Converts Codex namespace wrappers into standard Responses function tools.
 */
export function flattenNamespaceTools<T extends JsonObject>(
  request: T,
): FlattenedResponsesRequest<T> {
  const body = cloneJson(request)
  const mutableBody: JsonObject = body
  dropForeignEncryptedReplayItems(mutableBody)
  stripNullInputItemFields(mutableBody)
  const bindings: NamespaceToolBinding[] = []
  const bindingByIdentity = new Map<string, NamespaceToolBinding>()
  if (Array.isArray(mutableBody.tools)) {
    const flattenedTools: unknown[] = []
    for (const tool of mutableBody.tools) {
      if (isJsonObject(tool) && tool.type === 'web_search') {
        const {
          external_web_access: _externalWebAccess,
          indexed_web_access: _indexedWebAccess,
          ...compatibleWebSearch
        } = tool
        flattenedTools.push(compatibleWebSearch)
        continue
      }
      if (
        !isJsonObject(tool)
        || tool.type !== 'namespace'
        || typeof tool.name !== 'string'
        || !Array.isArray(tool.tools)
      ) {
        flattenedTools.push(tool)
        continue
      }

      for (const nestedTool of tool.tools) {
        if (
          !isJsonObject(nestedTool)
          || nestedTool.type !== 'function'
          || typeof nestedTool.name !== 'string'
        ) {
          continue
        }
        const binding = {
          flatName: `${tool.name}__${nestedTool.name}`,
          namespace: tool.name,
          name: nestedTool.name,
        }
        bindings.push(binding)
        bindingByIdentity.set(bindingKey(binding.namespace, binding.name), binding)
        flattenedTools.push({
          ...nestedTool,
          name: binding.flatName,
        })
      }
    }
    mutableBody.tools = flattenedTools
  }

  rewriteRequestCalls(body, bindingByIdentity, bindings)
  return { body, bindings }
}

function rewriteResponseCalls(
  value: unknown,
  bindingByFlatName: ReadonlyMap<string, NamespaceToolBinding>,
): void {
  if (Array.isArray(value)) {
    for (const item of value) rewriteResponseCalls(item, bindingByFlatName)
    return
  }
  if (!isJsonObject(value)) return

  if (value.type === 'function_call' && typeof value.name === 'string') {
    const binding = bindingByFlatName.get(value.name)
    if (binding) {
      value.namespace = binding.namespace
      value.name = binding.name
    }
  }
  for (const item of Object.values(value)) rewriteResponseCalls(item, bindingByFlatName)
}

/**
 * Restores Codex namespace identity on standard Responses function calls.
 */
export function restoreNamespaceToolCalls<T>(
  response: T,
  bindings: readonly NamespaceToolBinding[],
): T {
  const restored = cloneJson(response)
  const bindingByFlatName = new Map(
    bindings.map((binding) => [binding.flatName, binding]),
  )
  rewriteResponseCalls(restored, bindingByFlatName)
  return restored
}

function requestHeaders(headers: IncomingHttpHeaders): Headers {
  const forwarded = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (
      value === undefined
      || ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']
        .includes(name.toLowerCase())
    ) {
      continue
    }
    forwarded.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return forwarded
}

function upstreamUrl(baseUrl: URL, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://127.0.0.1')
  const basePath = baseUrl.pathname.replace(/\/+$/, '')
  const suffix = incoming.pathname === basePath
    ? ''
    : incoming.pathname.startsWith(`${basePath}/`)
      ? incoming.pathname.slice(basePath.length)
      : incoming.pathname
  const target = new URL(baseUrl)
  target.pathname = `${basePath}${suffix}`
  target.search = incoming.search
  return target
}

function copyResponseHeaders(source: Headers, target: ServerResponse): void {
  for (const [name, value] of source.entries()) {
    if (
      ['connection', 'content-length', 'content-encoding', 'transfer-encoding']
        .includes(name.toLowerCase())
    ) {
      continue
    }
    target.setHeader(name, value)
  }
}

function rewriteSseFrame(
  frame: string,
  bindings: readonly NamespaceToolBinding[],
): string {
  return frame
    .split(/\r?\n/)
    .map((line) => {
      if (!line.startsWith('data:')) return line
      const payload = line.slice('data:'.length).trimStart()
      if (!payload || payload === '[DONE]') return line
      try {
        return `data: ${JSON.stringify(
          restoreNamespaceToolCalls(JSON.parse(payload), bindings),
        )}`
      } catch {
        return line
      }
    })
    .join('\n')
}

function createSseTransform(
  bindings: readonly NamespaceToolBinding[],
): Transform {
  let buffer = ''
  const decoder = new StringDecoder('utf8')
  return new Transform({
    transform(chunk, _encoding, callback) {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      let separator = /\r?\n\r?\n/.exec(buffer)
      while (separator?.index !== undefined) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        this.push(`${rewriteSseFrame(frame, bindings)}\n\n`)
        separator = /\r?\n\r?\n/.exec(buffer)
      }
      callback()
    },
    flush(callback) {
      buffer += decoder.end()
      if (buffer) this.push(rewriteSseFrame(buffer, bindings))
      callback()
    },
  })
}

async function readRequestBody(
  request: IncomingMessage,
): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Starts a loopback proxy that adapts Codex namespace tools to standard Responses calls.
 */
export async function startResponsesCompatibilityProxy(
  upstreamBaseUrl: string,
): Promise<ResponsesCompatibilityProxy> {
  const upstreamBase = new URL(upstreamBaseUrl)
  if (!['http:', 'https:'].includes(upstreamBase.protocol)) {
    throw new Error(`Unsupported Responses upstream protocol: ${upstreamBase.protocol}`)
  }

  const server = createServer(async (request, response) => {
    const abortController = new AbortController()
    const abortUpstream = (): void => abortController.abort()
    const abortOnEarlyClose = (): void => {
      if (!response.writableEnded) abortUpstream()
    }
    request.once('aborted', abortUpstream)
    response.once('close', abortOnEarlyClose)
    try {
      const method = request.method ?? 'GET'
      const rawBody = await readRequestBody(request)
      let body = rawBody
      let bindings: NamespaceToolBinding[] = []
      if (
        rawBody
        && request.url?.split('?', 1)[0].endsWith('/responses')
        && request.headers['content-type']?.includes('application/json')
      ) {
        const parsed = JSON.parse(rawBody) as JsonObject
        const flattened = flattenNamespaceTools(parsed)
        body = JSON.stringify(flattened.body)
        bindings = flattened.bindings
      }

      const upstreamResponse = await fetch(
        upstreamUrl(upstreamBase, request.url ?? '/'),
        {
          method,
          headers: requestHeaders(request.headers),
          body: method === 'GET' || method === 'HEAD' ? undefined : body,
          signal: abortController.signal,
        },
      )
      response.statusCode = upstreamResponse.status
      copyResponseHeaders(upstreamResponse.headers, response)
      if (!upstreamResponse.body) {
        response.end()
        return
      }

      const contentType = upstreamResponse.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream') && bindings.length > 0) {
        await pipeline(
          Readable.fromWeb(upstreamResponse.body as never),
          createSseTransform(bindings),
          response,
        )
        return
      }

      if (contentType.includes('application/json') && bindings.length > 0) {
        const restored = restoreNamespaceToolCalls(
          JSON.parse(await upstreamResponse.text()),
          bindings,
        )
        response.end(JSON.stringify(restored))
        return
      }

      await pipeline(Readable.fromWeb(upstreamResponse.body as never), response)
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined)
        return
      }
      response.statusCode = 502
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      }))
    } finally {
      request.off('aborted', abortUpstream)
      response.off('close', abortOnEarlyClose)
    }
  })

  server.keepAliveTimeout = PROXY_KEEP_ALIVE_TIMEOUT_MS
  server.headersTimeout = PROXY_HEADERS_TIMEOUT_MS

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  const basePath = upstreamBase.pathname.replace(/\/+$/, '')
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}${basePath}`,
    keepAliveTimeoutMs: server.keepAliveTimeout,
    headersTimeoutMs: server.headersTimeout,
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) {
        resolve()
        return
      }
      closed = true
      server.close((error) => error ? reject(error) : resolve())
      server.closeAllConnections()
    }),
  }
}

/**
 * Starts one compatibility proxy per bridged Provider and returns rewritten configs.
 */
export async function startProviderCompatibilityProxies(
  providers: readonly CodexProviderConfig[],
): Promise<ProviderCompatibilityProxyGroup> {
  const proxies: ResponsesCompatibilityProxy[] = []
  try {
    const rewritten: CodexProviderConfig[] = []
    for (const provider of providers) {
      if (shouldStartResponsesCompatibilityProxy(provider)) {
        const proxy = await startResponsesCompatibilityProxy(provider.baseUrl)
        proxies.push(proxy)
        rewritten.push({ ...provider, baseUrl: proxy.baseUrl })
      } else {
        rewritten.push({ ...provider })
      }
    }
    return {
      providers: rewritten,
      close: async () => {
        await Promise.all(proxies.map((proxy) => proxy.close()))
      },
    }
  } catch (error) {
    await Promise.allSettled(proxies.map((proxy) => proxy.close()))
    throw error
  }
}
