// Encapsulates the Codex `app-server` WebSocket JSON-RPC protocol so it can be
// driven against a fake WebSocketServer in tests without spawning the real
// Rust binary. CodexLocalBackend composes this client with its spawn lifecycle.

import WebSocket from 'ws'
import { connectWithRetry } from './connectWithRetry'
import { resolveCodexSessionConfig } from './codexLaunch'
import { CodexNotificationRouter } from './codexNotificationRouter'
import { mapUserInput } from './codexUserInput'
import {
  isServerNotification,
  isServerRequest,
  type ClientInfo,
  type ServerMessage,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnStartResponse,
} from './codexProtocol'
import type {
  AgentStreamEvent,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexSessionConfig,
  CodexThreadDetail,
  CodexThreadSummary,
} from '../../types/agent'
import type { AgentInput, ListThreadsParams } from './types'
import type {
  AppsListParams,
  AppsListResponse,
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportResponse,
  ExternalAgentConfigMigrationItem,
  MarketplaceAddParams,
  MarketplaceAddResponse,
  MarketplaceRemoveResponse,
  MarketplaceUpgradeResponse,
  PluginInstallParams,
  PluginInstallResponse,
  PluginInstalledParams,
  PluginInstalledResponse,
  PluginListParams,
  PluginListResponse,
  PluginReadParams,
  PluginReadResponse,
} from '../../types/codexPlugins'

/**
 * Mirrors `McpServerStatus` from Codex's generated TS schema at
 * `codex-rs/app-server-protocol/schema/typescript/v2/McpServerStatus.ts`.
 * Field names are camelCase on the wire: `authStatus`, `resourceTemplates`.
 */
export interface McpServerStatusEntry {
  name: string
  tools: Record<string, { description?: string; inputSchema?: unknown }>
  resources: Array<{ uri: string; name?: string; description?: string }>
  resourceTemplates: Array<{ uriTemplate: string; name?: string }>
  authStatus: string
}

/**
 * Mirrors `ListMcpServerStatusResponse` from Codex's generated TS schema at
 * `codex-rs/app-server-protocol/schema/typescript/v2/ListMcpServerStatusResponse.ts`.
 * The list lives under `data` (NOT `mcpServers`) and pagination uses the
 * top-level `nextCursor: string | null` cursor.
 */
export interface McpServerStatusListResponse {
  data: McpServerStatusEntry[]
  nextCursor: string | null
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000
/**
 * `mcpServerStatus/list` is structurally slower than every other RPC: codex
 * connects to EVERY configured MCP server and waits for each to reach a terminal
 * state (ready/failed) before it can return their tools. A single slow server
 * (e.g. the external apiyi `node` process with a generous 60s startup window)
 * would therefore blow the default 30s budget and make the WHOLE list reject,
 * blanking the tool panel. We give the list its own 90s budget (> the largest
 * per-server startup_timeout) so a merely-slow server still resolves and the
 * full inventory comes back in one pass; a genuine hang past 90s degrades
 * silently (status keeps flowing via `mcp_status_updated` notifications).
 */
const MCP_LIST_TIMEOUT_MS = 90_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_CONNECT_INTERVAL_MS = 100
const CANCEL_GRACE_MS = 2_000
const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60_000

type PendingRpc = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type TurnQueue = {
  threadId: string
  turnId: string
  buffer: AgentStreamEvent[]
  waiter?: (event: AgentStreamEvent) => void
  closed: boolean
}

type OrphanNotification = { event: AgentStreamEvent; turnId: string }

type PendingServerRequest = {
  wireId: number
  timer: ReturnType<typeof setTimeout>
}

const ORPHAN_BUFFER_LIMIT = 1024

export interface CodexProtocolClientOptions {
  url: string
  clientInfo: ClientInfo
  sessionConfig?: Partial<CodexSessionConfig>
  connectTimeoutMs?: number
  connectIntervalMs?: number
  rpcTimeoutMs?: number
  approvalTimeoutMs?: number
  onLog?: (line: string) => void
  onApprovalRequest?: (request: CodexApprovalRequest) => void
  onMcpNotification?: (event: AgentStreamEvent) => void
}

/**
 * Stateless notification mapping kept around for backwards-compat with any
 * external callers (re-exported from CodexLocalBackend). New code should
 * prefer constructing a {@link CodexNotificationRouter} per session — it adds
 * `item/completed`-agentMessage fallback and delta dedup.
 *
 * @deprecated Prefer `new CodexNotificationRouter().route(method, params)`.
 */
export function mapServerNotification(method: string, params: any): AgentStreamEvent | null {
  return new CodexNotificationRouter().route(method, params ?? {})
}

export class CodexProtocolClient {
  private ws: WebSocket | null = null
  private rpcId = 0
  private pending = new Map<number, PendingRpc>()
  private queues = new Map<string, TurnQueue>()
  private turnIdByThread = new Map<string, string>()
  private readonly notificationRouter = new CodexNotificationRouter()
  // Methods we've already logged-once as "unhandled" so dev sessions see the
  // shape of the upstream notification stream without flooding (e.g.
  // `item/agentMessage/delta` would otherwise log thousands of times). Crucial
  // for diagnosing missing UI features — pre-fix we silently dropped notifs.
  private readonly unhandledMethodsLogged = new Set<string>()
  // (method, item.type) pairs we've already dumped the FULL params for, so we
  // see the *exact wire shape* of every distinct item-bearing notification at
  // most once per session. Required because `unhandled notification` only logs
  // a 200-char preview, which truncates reasoning summary/content arrays right
  // when we need to see them most. Compare against `unhandledMethodsLogged`,
  // which keys on method only and skips successfully-routed notifs entirely.
  private readonly fullDumpedKeys = new Set<string>()
  // Notifications received before their per-turn queue was created. We can
  // race the server's first delta against our turn/start response handling, so
  // we hold them here and drain them when the queue is registered.
  private orphanEvents: OrphanNotification[] = []
  private readonly rpcTimeoutMs: number
  private readonly approvalTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly connectIntervalMs: number
  private sessionConfig: CodexSessionConfig
  private pendingServerRequests = new Map<string, PendingServerRequest>()
  private activeSends = 0

  constructor(private readonly options: CodexProtocolClientOptions) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.connectIntervalMs = options.connectIntervalMs ?? DEFAULT_CONNECT_INTERVAL_MS
    this.sessionConfig = resolveCodexSessionConfig(options.sessionConfig)
  }

  async start(): Promise<void> {
    this.ws = await connectWithRetry({
      attempt: () => this.openOnce(this.options.url),
      timeoutMs: this.connectTimeoutMs,
      intervalMs: this.connectIntervalMs,
    })

    this.ws.on('message', (data) => this.handleRaw(String(data)))
    this.ws.on('close', () => {
      this.failAllQueues(new Error('codex websocket closed'))
      this.rejectPending(new Error('codex websocket closed'))
      this.clearPendingServerRequests()
    })

    await this.rpc('initialize', { clientInfo: this.options.clientInfo, capabilities: null })
    this.notify('initialized', {})
  }

  async stop(): Promise<void> {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.denyAllServerRequests('Codex protocol client stopped')
      try { ws.close() } catch { /* ignore */ }
    }
    this.ws = null
    this.failAllQueues(new Error('Codex protocol client stopped'))
    this.rejectPending(new Error('Codex protocol client stopped'))
    this.clearPendingServerRequests()
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  hasActiveTurns(): boolean {
    return this.queues.size > 0
  }

  hasInFlightWork(): boolean {
    return this.activeSends > 0 || this.hasActiveTurns()
  }

  setSessionConfig(patch: Partial<CodexSessionConfig>): void {
    this.sessionConfig = resolveCodexSessionConfig({
      ...this.sessionConfig,
      ...patch,
      writableRoots: patch.writableRoots ? [...patch.writableRoots] : [...this.sessionConfig.writableRoots],
    })
  }

  async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    this.activeSends += 1
    try {
      let actualThreadId = threadId
      if (!actualThreadId) {
        const response = await this.rpc<ThreadStartResponse>('thread/start', this.threadStartParams(input))
        actualThreadId = response.thread.id
        yield { type: 'thread_created', threadId: actualThreadId }
      }

      const turnResponse = await this.rpc<TurnStartResponse>('turn/start', {
        threadId: actualThreadId,
        input: mapUserInput(input.items),
      })
      const turnId = turnResponse.turn.id
      this.turnIdByThread.set(actualThreadId, turnId)

      const key = queueKey(actualThreadId, turnId)
      const queue: TurnQueue = { threadId: actualThreadId, turnId, buffer: [], closed: false }
      this.queues.set(key, queue)
      this.drainOrphansInto(actualThreadId, turnId, queue)

      try {
        while (true) {
          const event = await this.takeEvent(queue)
          yield event
          if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') return
        }
      } finally {
        queue.closed = true
        this.queues.delete(key)
        if (this.turnIdByThread.get(actualThreadId) === turnId) {
          this.turnIdByThread.delete(actualThreadId)
        }
      }
    } finally {
      this.activeSends -= 1
    }
  }

  async cancel(threadId: string): Promise<void> {
    const turnId = this.turnIdByThread.get(threadId)
    if (!turnId) return

    try {
      await this.rpc('turn/interrupt', { threadId, turnId })
    } catch (error) {
      this.options.onLog?.(`[codex] turn/interrupt rejected: ${stringifyError(error)}`)
    }

    const key = queueKey(threadId, turnId)
    const grace = setTimeout(() => {
      const queue = this.queues.get(key)
      if (!queue || queue.closed) return
      this.pushEventToQueue(queue, { type: 'cancelled', threadId, turnId })
    }, CANCEL_GRACE_MS)
    grace.unref?.()
  }

  async listThreads(params?: ListThreadsParams): Promise<CodexThreadSummary[]> {
    // `thread/list` (app-server v2 ThreadListParams) accepts an optional
    // `archived` filter (true = only archived, false/null = only active) and a
    // `searchTerm` substring match on the extracted title. We forward only the
    // keys the caller set so an argless call keeps the legacy empty-params wire
    // shape (back-compat with older fake servers / call sites).
    const wire: Record<string, unknown> = {}
    if (params?.archived !== undefined) wire.archived = params.archived
    if (params?.searchTerm !== undefined) wire.searchTerm = params.searchTerm
    const response = await this.rpc<unknown>('thread/list', wire)
    return normalizeThreadList(response)
  }

  async readThread(threadId: string): Promise<CodexThreadDetail> {
    const response = await this.rpc<unknown>('thread/read', { threadId })
    return normalizeThreadDetail(response)
  }

  async forkThread(threadId: string): Promise<CodexThreadSummary> {
    const response = await this.rpc<unknown>('thread/fork', { threadId })
    return normalizeThreadSummary(extractThreadRecord(response))
  }

  /**
   * Reopen a persisted thread by id (app-server v2 `thread/resume`,
   * `ThreadResumeParams = { threadId, ... }`) so subsequent `turn/start` calls
   * append to it. After an app-server respawn the new process has no in-memory
   * thread; resume loads the rollout from disk into this generation, restoring
   * the conversation. Response shape matches `thread/start` (`{ thread }`) but
   * the caller keeps the existing id, so we resolve void. Only the required
   * `threadId` is sent — newer optional fields (e.g. `excludeTurns`) are omitted
   * for compatibility with the bundled binary; rejections bubble up so the
   * caller can fall back to a fresh thread.
   */
  async resumeThread(threadId: string): Promise<void> {
    await this.rpc<unknown>('thread/resume', { threadId })
  }

  /**
   * Archive a saved session (app-server `thread/archive`, PR introducing
   * `ThreadArchiveParams`/`ThreadArchiveResponse`). Archived threads are
   * protected from resume/fork and hidden from the default `thread/list`.
   * Response is an empty object, so this resolves void.
   */
  async archiveThread(threadId: string): Promise<void> {
    await this.rpc<unknown>('thread/archive', { threadId })
  }

  /**
   * Restore a previously archived session (app-server `thread/unarchive`).
   * `ThreadUnarchiveResponse = { thread }` so we return the normalized summary.
   */
  async unarchiveThread(threadId: string): Promise<CodexThreadSummary> {
    const response = await this.rpc<unknown>('thread/unarchive', { threadId })
    return normalizeThreadSummary(extractThreadRecord(response))
  }

  // ─── MCP Management RPC ───────────────────────────────────────────────

  async listMcpServers(
    params?: { detail?: 'full' | 'toolsAndAuthOnly'; limit?: number; cursor?: string },
  ): Promise<McpServerStatusListResponse> {
    // Default to the lightweight detail mode (codex PR #16831). `full` rebuilds
    // the entire inventory and probes resources/templates which can take 10s+.
    // Runs on the dedicated MCP_LIST_TIMEOUT_MS budget (not the default 30s) so
    // one slow server can't reject the whole list — see the constant's doc.
    return this.rpc<McpServerStatusListResponse>(
      'mcpServerStatus/list',
      params ?? { detail: 'toolsAndAuthOnly' },
      MCP_LIST_TIMEOUT_MS,
    )
  }

  async batchWriteConfig(edits: Array<{ keyPath: string; value: unknown; mergeStrategy?: string }>, reloadUserConfig = true): Promise<void> {
    await this.rpc('config/batchWrite', { edits, reloadUserConfig })
  }

  async writeConfigValue(keyPath: string, value: unknown): Promise<void> {
    await this.rpc('config/value/write', { keyPath, value })
  }

  async readConfig(): Promise<{ config: Record<string, unknown> }> {
    return this.rpc('config/read', {})
  }

  async reloadMcpServers(): Promise<void> {
    await this.rpc('config/mcpServer/reload', {})
  }

  async mcpOAuthLogin(name: string, scopes?: string[]): Promise<{ authorization_url: string }> {
    return this.rpc('mcpServer/oauth/login', { name, ...(scopes ? { scopes } : {}) })
  }

  async mcpToolCall(params: { threadId?: string; server: string; tool: string; arguments?: unknown }): Promise<unknown> {
    return this.rpc('mcpServer/tool/call', params)
  }

  // ─── Native Plugin / Marketplace / Connectors RPC (app-server v2, ≥0.140) ──
  // Method strings pinned from openai/codex
  // `app-server-protocol/src/protocol/common.rs` (client_request_definitions!)
  // at tag rust-v0.141.0. These require a Codex binary ≥0.140; remote catalogs
  // (`vertical` / `created-by-me-remote`) and `app/list` are additionally
  // gated behind ChatGPT auth / experimental feature flags server-side.
  // NOTE: the wire method is `app/list` (singular) even though the Rust enum
  // variant is `AppsList` — verified against v2/apps.rs + the serialize test.

  /** List plugins across marketplaces. Omitting `marketplaceKinds` queries only
   *  local marketplaces (+ the default remote catalog when feature-flagged). */
  async listPlugins(params?: PluginListParams): Promise<PluginListResponse> {
    return this.rpc<PluginListResponse>('plugin/list', params ?? {})
  }

  /** List only installed plugins (lighter than `plugin/list`). */
  async listInstalledPlugins(params?: PluginInstalledParams): Promise<PluginInstalledResponse> {
    return this.rpc<PluginInstalledResponse>('plugin/installed', params ?? {})
  }

  /** Read full detail (skills, hooks, apps, mcpServers) for one plugin. */
  async readPlugin(params: PluginReadParams): Promise<PluginReadResponse> {
    return this.rpc<PluginReadResponse>('plugin/read', params)
  }

  /** Install a plugin. Returns the auth policy + any apps needing auth. */
  async installPlugin(params: PluginInstallParams): Promise<PluginInstallResponse> {
    return this.rpc<PluginInstallResponse>('plugin/install', params)
  }

  /** Uninstall a plugin by its installed plugin id. */
  async uninstallPlugin(pluginId: string): Promise<void> {
    await this.rpc('plugin/uninstall', { pluginId })
  }

  /** Add a marketplace source (git url / catalog) to discover plugins. */
  async addMarketplace(params: MarketplaceAddParams): Promise<MarketplaceAddResponse> {
    return this.rpc<MarketplaceAddResponse>('marketplace/add', params)
  }

  /** Remove a previously added marketplace by name. */
  async removeMarketplace(marketplaceName: string): Promise<MarketplaceRemoveResponse> {
    return this.rpc<MarketplaceRemoveResponse>('marketplace/remove', { marketplaceName })
  }

  /** Upgrade one marketplace, or all of them when `marketplaceName` is omitted. */
  async upgradeMarketplaces(marketplaceName?: string): Promise<MarketplaceUpgradeResponse> {
    return this.rpc<MarketplaceUpgradeResponse>(
      'marketplace/upgrade',
      marketplaceName ? { marketplaceName } : {},
    )
  }

  /** List available apps / connectors (EXPERIMENTAL; paginated via `nextCursor`). */
  async listApps(params?: AppsListParams): Promise<AppsListResponse> {
    return this.rpc<AppsListResponse>('app/list', params ?? {})
  }

  /** Detect importable external-agent configs (Claude Code, etc.). */
  async detectExternalAgentConfig(
    params?: ExternalAgentConfigDetectParams,
  ): Promise<ExternalAgentConfigDetectResponse> {
    return this.rpc<ExternalAgentConfigDetectResponse>('externalAgentConfig/detect', params ?? {})
  }

  /** Import the selected external-agent migration items. */
  async importExternalAgentConfig(
    migrationItems: ExternalAgentConfigMigrationItem[],
  ): Promise<ExternalAgentConfigImportResponse> {
    return this.rpc<ExternalAgentConfigImportResponse>('externalAgentConfig/import', { migrationItems })
  }

  /** Permanently delete a saved session (distinct from archive/unarchive). */
  async deleteThread(threadId: string): Promise<void> {
    await this.rpc('thread/delete', { threadId })
  }

  respondToServerRequest(response: CodexApprovalResponse): void {
    const pending = this.pendingServerRequests.get(response.id)
    if (!pending) throw new Error(`No pending Codex server request for id ${response.id}`)
    this.pendingServerRequests.delete(response.id)
    clearTimeout(pending.timer)
    this.sendServerRequestResponse(pending.wireId, {
      approved: response.approved,
      ...(response.message ? { message: response.message } : {}),
    })
  }

  private openOnce(url: string): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(url)
      let settled = false
      const cleanup = (): void => {
        ws.removeListener('open', onOpen)
        ws.removeListener('error', onError)
      }
      const onOpen = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(ws)
      }
      const onError = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        try { ws.close() } catch { /* ignore */ }
        reject(error)
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
    })
  }

  private threadStartParams(input: AgentInput): ThreadStartParams {
    const sessionConfig = this.sessionConfig
    return {
      model: input.model,
      cwd: input.cwd,
      sandbox: sessionConfig.sandboxMode,
      approvalPolicy: sessionConfig.approvalPolicy,
      config: {
        web_search: sessionConfig.webSearch,
        sandbox_workspace_write: {
          writable_roots: sessionConfig.writableRoots,
        },
      },
    }
  }

  private notify(method: string, params: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const payload = { jsonrpc: '2.0' as const, method, params }
    this.ws.send(JSON.stringify(payload))
  }

  private rpc<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Codex websocket is not connected'))
    }
    const id = ++this.rpcId
    const payload = { jsonrpc: '2.0' as const, id, method, params }
    const effectiveTimeout = timeoutMs ?? this.rpcTimeoutMs

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex RPC ${method} timed out after ${effectiveTimeout}ms`))
      }, effectiveTimeout)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.ws!.send(JSON.stringify(payload), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  private handleRaw(raw: string): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(raw) as ServerMessage
    } catch {
      this.options.onLog?.(`[codex] failed to parse message: ${raw.slice(0, 200)}`)
      return
    }

    if ('id' in msg && (msg as any).id !== undefined && (msg as any).method === undefined) {
      const response = msg as { id: number; result?: unknown; error?: { code: number; message: string } }
      const pending = this.pending.get(response.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
      return
    }

    if (isServerRequest(msg)) {
      this.options.onLog?.(`[codex] server request: ${msg.method} (id=${msg.id})`)
      this.queueServerRequest(msg)
      return
    }

    if (isServerNotification(msg)) {
      this.routeNotification(msg.method, (msg.params ?? {}) as Record<string, any>)
    }
  }

  private queueServerRequest(msg: { id: number; method: string; params?: unknown }): void {
    const id = String(msg.id)
    if (this.pendingServerRequests.has(id)) {
      this.sendServerRequestResponse(msg.id, {
        approved: false,
        message: 'duplicate approval request id',
      })
      return
    }

    const params = toRecord(msg.params)
    const timer = setTimeout(() => {
      const pending = this.pendingServerRequests.get(id)
      if (!pending) return
      this.pendingServerRequests.delete(id)
      this.sendServerRequestResponse(pending.wireId, {
        approved: false,
        message: 'approval request timed out',
      })
    }, this.approvalTimeoutMs)
    timer.unref?.()
    this.pendingServerRequests.set(id, { wireId: msg.id, timer })

    this.options.onApprovalRequest?.({
      id,
      threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
      method: msg.method,
      params,
      createdAt: new Date().toISOString(),
    })
  }

  private sendServerRequestResponse(id: number, result: { approved: boolean; message?: string }): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const payload = { jsonrpc: '2.0' as const, id, result }
    this.ws.send(JSON.stringify(payload))
  }

  private denyAllServerRequests(message: string): void {
    for (const [id, pending] of this.pendingServerRequests) {
      this.pendingServerRequests.delete(id)
      clearTimeout(pending.timer)
      this.sendServerRequestResponse(pending.wireId, { approved: false, message })
    }
  }

  private clearPendingServerRequests(): void {
    for (const pending of this.pendingServerRequests.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingServerRequests.clear()
  }

  private routeNotification(method: string, params: Record<string, any>): void {
    // Diagnostic: dump full params the first time we see each
    // `(method, item.type)` pair. Apiyi, OpenRouter and other gateways
    // sometimes drift on reasoning/content payload shape; without seeing the
    // raw JSON we end up guessing where the text lives. This logs at most
    // ~30-50 lines per session (one per distinct item type per item method).
    const itemType =
      typeof params?.item?.type === 'string' ? (params.item.type as string) : null
    const dumpKey = itemType ? `${method}#${itemType}` : method
    if ((method.startsWith('item/') || method === 'turn/completed') && !this.fullDumpedKeys.has(dumpKey)) {
      this.fullDumpedKeys.add(dumpKey)
      let json: string
      try {
        json = JSON.stringify(params)
      } catch {
        json = '<unserializable>'
      }
      this.options.onLog?.(`[codex trace] ${dumpKey} ${json.slice(0, 4000)}`)
    }

    const event = this.notificationRouter.route(method, params)
    if (!event) {
      // Log each unhandled method once per session so we can diagnose missing
      // UI features without flooding the log. Examples that legitimately drop:
      // thread/started, turn/started, warning, item/fileChange/outputDelta.
      // If a NEW method (e.g. an undocumented mcp progress notification) shows
      // up here, this single line points us at exactly what to add.
      if (!this.unhandledMethodsLogged.has(method)) {
        this.unhandledMethodsLogged.add(method)
        const peek = peekParams(params)
        this.options.onLog?.(
          peek.length > 0
            ? `[codex] unhandled notification (logged once): ${method} ${peek}`
            : `[codex] unhandled notification (logged once): ${method}`,
        )
      }
      return
    }
    if (event.type === 'mcp_status_updated' || event.type === 'mcp_oauth_completed') {
      this.options.onMcpNotification?.(event)
      return
    }
    const threadId = event.threadId
    const turnId =
      event.turnId
      ?? (typeof params.turnId === 'string' ? params.turnId : undefined)
      ?? (threadId ? this.turnIdByThread.get(threadId) : undefined)
    if (!threadId || !turnId) return
    const queue = this.queues.get(queueKey(threadId, turnId))
    if (queue) {
      this.pushEventToQueue(queue, event)
      return
    }
    // Server began streaming before send()'s `await this.rpc('turn/start', ...)`
    // had a chance to register the per-turn queue. Buffer until it appears.
    if (this.orphanEvents.length < ORPHAN_BUFFER_LIMIT) {
      this.orphanEvents.push({ event, turnId })
    }
  }

  private drainOrphansInto(threadId: string, turnId: string, queue: TurnQueue): void {
    if (this.orphanEvents.length === 0) return
    const remaining: OrphanNotification[] = []
    for (const orphan of this.orphanEvents) {
      if (orphan.event.threadId === threadId && orphan.turnId === turnId) {
        this.pushEventToQueue(queue, orphan.event)
      } else {
        remaining.push(orphan)
      }
    }
    this.orphanEvents = remaining
  }

  private pushEventToQueue(queue: TurnQueue, event: AgentStreamEvent): void {
    if (queue.closed) return
    if (queue.waiter) {
      const resolve = queue.waiter
      queue.waiter = undefined
      resolve(event)
    } else {
      queue.buffer.push(event)
    }
  }

  private takeEvent(queue: TurnQueue): Promise<AgentStreamEvent> {
    return new Promise<AgentStreamEvent>((resolve) => {
      const buffered = queue.buffer.shift()
      if (buffered) {
        resolve(buffered)
        return
      }
      queue.waiter = resolve
    })
  }

  private failAllQueues(error: Error): void {
    for (const queue of this.queues.values()) {
      if (queue.closed) continue
      const event: AgentStreamEvent = {
        type: 'error',
        threadId: queue.threadId,
        turnId: queue.turnId,
        error: error.message,
      }
      if (queue.waiter) {
        const resolve = queue.waiter
        queue.waiter = undefined
        resolve(event)
      } else {
        queue.buffer.push(event)
      }
      queue.closed = true
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function queueKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function normalizeThreadList(value: unknown): CodexThreadSummary[] {
  const record = toRecord(value)
  const rawThreads = Array.isArray(record.threads)
    ? record.threads
    : Array.isArray(record.items)
      ? record.items
      : Array.isArray(value)
        ? value
        : []
  return rawThreads
    .map((item) => normalizeOptionalThreadSummary(item))
    .filter((item): item is CodexThreadSummary => item !== null)
}

function normalizeThreadDetail(value: unknown): CodexThreadDetail {
  return normalizeThreadSummary(extractThreadRecord(value))
}

function extractThreadRecord(value: unknown): Record<string, unknown> {
  const record = toRecord(value)
  return toRecord(record.thread ?? value)
}

function normalizeOptionalThreadSummary(value: unknown): CodexThreadSummary | null {
  const record = toRecord(value)
  const id = stringField(record, 'id')
  if (!id) return null
  return normalizeThreadSummary(record)
}

function normalizeThreadSummary(record: Record<string, unknown>): CodexThreadSummary {
  const id = stringField(record, 'id')
  if (!id) throw new Error('Codex thread response missing id')
  const title = stringField(record, 'title') ?? stringField(record, 'preview') ?? 'Untitled Codex session'
  const createdAt = stringField(record, 'createdAt') ?? stringField(record, 'created_at') ?? ''
  const updatedAt = stringField(record, 'updatedAt') ?? stringField(record, 'updated_at') ?? createdAt
  const cwd = stringField(record, 'cwd')
  const model = stringField(record, 'model')
  return {
    id,
    title,
    createdAt,
    updatedAt,
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Compact one-line preview of a notification's params for the unhandled-method
 * log line. Strips long fields (`text`, `delta`, `data`) to a length cap so the
 * log doesn't explode for streaming notifications. Best-effort only; falls
 * back to an empty string if the payload can't be JSON-stringified.
 */
function peekParams(params: Record<string, any>): string {
  try {
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string') {
        safe[k] = v.length > 80 ? `${v.slice(0, 79)}…` : v
      } else if (v && typeof v === 'object' && 'type' in (v as Record<string, unknown>)) {
        // Keep just the discriminant so we can see the item shape without
        // the full body when it's an `item` payload.
        safe[k] = { type: (v as { type?: unknown }).type, id: (v as { id?: unknown }).id }
      } else {
        safe[k] = v
      }
    }
    const s = JSON.stringify(safe)
    return s.length > 240 ? `${s.slice(0, 239)}…` : s
  } catch {
    return ''
  }
}
