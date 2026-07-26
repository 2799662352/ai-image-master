import { createResponsesFetch } from '@codeproxy/core'
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
import type { AgentModelFamily } from '../../types/agent'
import {
  createAnthropicUsageSink,
  observeAnthropicUsage,
  repairResponsesUsage,
} from './anthropicUsageRepair'
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
function providerServesFamily(
  provider: BridgeCandidateProvider,
  family: AgentModelFamily,
): boolean {
  const models = [provider.model, ...(provider.allowedModels ?? [])]
  return models.some(
    (model) => typeof model === 'string' && inferModelFamily(model) === family,
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

/** Which loopback adapter (if any) a provider channel must be launched behind. */
export type CompatibilityBridgeKind =
  | 'none'
  | 'responses-namespace'
  | 'anthropic-messages'

/**
 * Decides which loopback adapter a provider channel needs.
 *
 * Both never-regress guards below fire even when a preset (or a user-defined
 * custom provider) forgot to declare the matching `compatibilityPolicy`,
 * because in both cases an unbridged launch fails outright rather than
 * degrading: xAI 422s every second turn, and an Anthropic endpoint has no
 * `/responses` route at all.
 */
export function resolveCompatibilityBridge(
  provider: BridgeCandidateProvider | undefined,
): CompatibilityBridgeKind {
  if (!provider) return 'none'
  const policy = provider.compatibilityPolicy ?? 'none'
  switch (policy) {
    case 'anthropic-messages-bridge':
      return 'anthropic-messages'
    case 'responses-namespace-bridge':
      return providerServesFamily(provider, 'anthropic')
        ? 'anthropic-messages'
        : 'responses-namespace'
    case 'none':
      if (providerServesFamily(provider, 'anthropic')) return 'anthropic-messages'
      return providerServesFamily(provider, 'xai') ? 'responses-namespace' : 'none'
    default: {
      const exhaustive: never = policy
      throw new Error(`Unsupported compatibility policy: ${String(exhaustive)}`)
    }
  }
}

/** Returns whether a provider channel needs any loopback adapter. */
export function shouldStartResponsesCompatibilityProxy(
  provider: BridgeCandidateProvider | undefined,
): boolean {
  return resolveCompatibilityBridge(provider) !== 'none'
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

/** How a bridge reaches its upstream, and what it exposes on loopback. */
interface CompatibilityBridgeTransport {
  /** Path prefix appended to the loopback origin so Codex's `base_url` matches. */
  basePath: string
  /**
   * Maps an incoming loopback request to the URL handed to {@link fetch}.
   * Returning `undefined` answers 404 instead of forwarding — used by bridges
   * that can only serve `/responses`.
   */
  resolveTarget: (requestUrl: string) => URL | undefined
  fetch: typeof fetch
  /** Optional in-place tweak applied to a `/responses` body after flattening. */
  transformBody?: (body: JsonObject) => void
}

/**
 * Starts the loopback server shared by every compatibility bridge.
 *
 * Both bridges need the same envelope — read the body, flatten Codex's
 * namespace tools into plain Responses function tools, forward, then restore
 * namespace identity on the way back (streaming or not) — plus the same
 * abort-on-client-close and keep-alive tuning. They differ only in the
 * transport: the namespace bridge forwards to a Responses endpoint verbatim,
 * while the Anthropic bridge hands the already-flattened body to a translating
 * fetch. Keeping one server means a fix to the stream/abort handling can never
 * land on only one of them.
 */
async function startCompatibilityBridgeServer(
  transport: CompatibilityBridgeTransport,
): Promise<ResponsesCompatibilityProxy> {
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
      const target = transport.resolveTarget(request.url ?? '/')
      if (!target) {
        response.statusCode = 404
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          error: { message: `Bridge serves only /responses, not ${request.url ?? '/'}` },
        }))
        return
      }
      let body = rawBody
      let bindings: NamespaceToolBinding[] = []
      if (
        rawBody
        && request.url?.split('?', 1)[0].endsWith('/responses')
        && request.headers['content-type']?.includes('application/json')
      ) {
        const parsed = JSON.parse(rawBody) as JsonObject
        const flattened = flattenNamespaceTools(parsed)
        transport.transformBody?.(flattened.body)
        body = JSON.stringify(flattened.body)
        bindings = flattened.bindings
      }

      const upstreamResponse = await transport.fetch(
        target,
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
  let closed = false
  return {
    baseUrl: `http://127.0.0.1:${address.port}${transport.basePath}`,
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

function parseUpstreamBase(upstreamBaseUrl: string, label: string): URL {
  const upstreamBase = new URL(upstreamBaseUrl)
  if (!['http:', 'https:'].includes(upstreamBase.protocol)) {
    throw new Error(`Unsupported ${label} upstream protocol: ${upstreamBase.protocol}`)
  }
  return upstreamBase
}

/**
 * Starts a loopback proxy that adapts Codex namespace tools to standard Responses calls.
 */
export async function startResponsesCompatibilityProxy(
  upstreamBaseUrl: string,
): Promise<ResponsesCompatibilityProxy> {
  const upstreamBase = parseUpstreamBase(upstreamBaseUrl, 'Responses')
  return startCompatibilityBridgeServer({
    basePath: upstreamBase.pathname.replace(/\/+$/, ''),
    resolveTarget: (requestUrl) => upstreamUrl(upstreamBase, requestUrl),
    fetch,
  })
}

/**
 * Loopback path Codex is pointed at on Anthropic channels.
 *
 * The translating fetch decides whether to translate by regex-matching
 * `/v1/responses$` on the URL it is handed, so we hand it this canonical
 * placeholder rather than a URL derived from the channel's `base_url` — an
 * upstream whose base lacks the `/v1` segment would otherwise silently fall
 * through to raw passthrough and 404 against the Messages API. The host is
 * never contacted: the real endpoint comes from `baseUrl` in the options.
 */
const ANTHROPIC_BRIDGE_TRANSLATE_URL = new URL(
  'http://anthropic-messages-bridge.invalid/v1/responses',
)

/**
 * Drops the Responses-side cache key so no Anthropic `cache_control`
 * breakpoints are emitted.
 *
 * `prompt_cache_key` is Codex's per-conversation cache hint and is transparent
 * on native Responses endpoints, but the translator reads its mere presence as
 * consent to stamp `cache_control: {type:'ephemeral'}` onto up to three system
 * blocks plus the last message block — it is the library's only opt-in for
 * Anthropic prompt caching (`translateRequest` gates `markBlocksForCache` and
 * `markCacheBreakpoint` on this one field). Deleting it therefore does not just
 * hide a hint, it turns caching off.
 *
 * That is worth doing only where reads never land, because Anthropic bills a
 * marked prefix at 1.25x on write and 0.1x on read. Where reads do land the
 * saving is an order of magnitude, so this is opt-in per channel rather than
 * unconditional — see {@link CodexProviderConfig.promptCacheBreakpoints}.
 */
function stripPromptCacheKey(body: JsonObject): void {
  delete body.prompt_cache_key
}

/** Content type that marks a translated stream we can repair usage on. */
const SSE_CONTENT_TYPE = 'text/event-stream'

/**
 * Wraps the library's translating fetch so the usage it reports is the usage
 * the upstream actually billed — see {@link ./anthropicUsageRepair} for the two
 * bugs this corrects and the measurements behind them.
 *
 * The translating fetch is rebuilt per call rather than once per channel. It is
 * a pure closure factory (no sockets, no shared state), and a fresh one per
 * request is what keeps each turn's observation bound to its own response:
 * concurrent turns on the same channel would otherwise write into one sink and
 * report each other's token counts.
 */
function createAnthropicTranslatingFetch(baseUrl: string): typeof fetch {
  return async (input, init) => {
    const sink = createAnthropicUsageSink()
    const translate = createResponsesFetch({
      upstreamFormat: 'anthropic',
      baseUrl,
      fetch: async (upstreamInput, upstreamInit) => {
        const upstream = await fetch(upstreamInput, upstreamInit)
        if (!upstream.body) return upstream
        return new Response(observeAnthropicUsage(upstream.body, sink), {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: upstream.headers,
        })
      },
    })
    const translated = await translate(input, init)
    if (
      !translated.body
      || !translated.headers.get('content-type')?.includes(SSE_CONTENT_TYPE)
    ) {
      return translated
    }
    return new Response(repairResponsesUsage(translated.body, sink), {
      status: translated.status,
      statusText: translated.statusText,
      headers: translated.headers,
    })
  }
}

/**
 * Starts a loopback bridge that speaks Responses to Codex and Anthropic
 * Messages to the upstream.
 *
 * Codex has no Anthropic wire protocol — `wire_api` only accepts `"responses"`
 * (`"chat"` was removed in openai/codex#7782) — so a Claude channel is only
 * reachable by translating both directions in-process. `@codeproxy/core` does
 * the protocol mapping (including `Authorization: Bearer` → `x-api-key`, the
 * `anthropic-version` header, and `thinking: {type:'adaptive'}` for the
 * Sonnet 5 / Opus 4.6+ / Fable 5 generation that rejects the legacy
 * `budget_tokens` shape), and the shared server keeps subagent namespace tools
 * intact around it.
 *
 * Deliberately no `timeoutMs`: the option exists in the library's types but is
 * unimplemented in 0.1.22, so setting it would read as protection while doing
 * nothing. Cancellation instead rides the `AbortSignal` the shared server
 * already wires to client disconnects, which the library does forward upstream.
 */
export async function startAnthropicMessagesBridge(
  upstreamBaseUrl: string,
  options: { promptCacheBreakpoints?: boolean } = {},
): Promise<ResponsesCompatibilityProxy> {
  const upstreamBase = parseUpstreamBase(upstreamBaseUrl, 'Anthropic Messages')
  const translatingFetch = createAnthropicTranslatingFetch(
    upstreamBase.toString().replace(/\/+$/, ''),
  )
  return startCompatibilityBridgeServer({
    basePath: upstreamBase.pathname.replace(/\/+$/, ''),
    resolveTarget: (requestUrl) => (
      requestUrl.split('?', 1)[0].endsWith('/responses')
        ? ANTHROPIC_BRIDGE_TRANSLATE_URL
        : undefined
    ),
    fetch: translatingFetch,
    transformBody: options.promptCacheBreakpoints === false
      ? stripPromptCacheKey
      : undefined,
  })
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
      const bridge = resolveCompatibilityBridge(provider)
      if (bridge === 'none') {
        rewritten.push({ ...provider })
        continue
      }
      const proxy = bridge === 'anthropic-messages'
        ? await startAnthropicMessagesBridge(provider.baseUrl, {
          promptCacheBreakpoints: provider.promptCacheBreakpoints,
        })
        : await startResponsesCompatibilityProxy(provider.baseUrl)
      proxies.push(proxy)
      rewritten.push({ ...provider, baseUrl: proxy.baseUrl })
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
