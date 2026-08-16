// Encapsulates the Codex `app-server` WebSocket JSON-RPC protocol so it can be
// driven against a fake WebSocketServer in tests without spawning the real
// Rust binary. CodexLocalBackend composes this client with its spawn lifecycle.

import WebSocket from 'ws'
import { connectWithRetry } from './connectWithRetry'
import { resolveCodexSessionConfig } from './codexLaunch'
import { CodexNotificationRouter } from './codexNotificationRouter'
import { mapUserInput } from './codexUserInput'
import { buildExtraRootsDeveloperInstructions } from './projectDocs'
import {
  isServerNotification,
  isServerRequest,
  type ClientInfo,
  type CollaborationModeListResponse,
  type CodexModelListParams,
  type CodexModelListResponse,
  type CodexThreadConfigOverrides,
  type CodexThreadMemoryMode,
  type ServerMessage,
  type ThreadSettingsUpdateParams,
  type ThreadSettingsUpdateResponse,
  type ThreadStartParams,
  type ThreadStartResponse,
  type TurnStartResponse,
  type TurnSteerResponse,
} from './codexProtocol'
import type {
  AgentStreamEvent,
  AgentStreamEventBase,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexSessionConfig,
  CodexSubagentInfo,
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
import type {
  ThreadGoalSetParams,
  ThreadGoalSetResponse,
  ThreadGoalGetResponse,
  ThreadGoalClearResponse,
} from '../../types/codexGoals'

/**
 * Spread-omit serializer for {@link CodexThreadConfigOverrides}: absent fields
 * must not appear on the wire at all (older binaries reject unknown/null
 * fields, and an explicit field — even null — flips codex's
 * `has_model_resume_override` and suppresses persisted-metadata restore).
 */
function threadConfigOverrideParams(
  overrides: CodexThreadConfigOverrides | undefined,
): Partial<CodexThreadConfigOverrides> {
  if (!overrides) return {}
  return {
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.modelProvider ? { modelProvider: overrides.modelProvider } : {}),
    ...(overrides.config ? { config: overrides.config } : {}),
  }
}

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
/**
 * Stream-idle watchdog (upstream gap: openai/codex#30526 — app-server can go
 * permanently silent mid-turn with no turn/completed and no error). If NO
 * event arrives on an active turn for this long, we synthesize a terminal
 * error so the UI recovers instead of hanging forever.
 *
 * **Disabled (`0`).** The 10-minute budget was calibrated against shell
 * commands and approval prompts, but our own MCP tools legitimately run far
 * longer in silence: `tool_timeout_sec` is 2000s and `generate_video` polls a
 * Seedance task for minutes without emitting a single event. The watchdog was
 * therefore killing healthy turns mid-generation, which reads to the user as
 * the app cancelling their paid render.
 *
 * The tradeoff is real: a genuinely wedged app-server now hangs instead of
 * self-recovering. If that comes back, prefer raising this past the tool
 * timeout (e.g. `40 * 60_000`) over re-enabling the old 10-minute value —
 * anything below `tool_timeout_sec` will keep firing on healthy long turns.
 */
const DEFAULT_TURN_IDLE_TIMEOUT_MS = 0

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

/**
 * The thread/turn-scoped subset of `AgentStreamEvent` — everything that
 * carries a top-level `threadId` (per-turn item stream + goal side channel).
 * Out-of-band variants (mcp_*, skills_changed, notice) are excluded: they are
 * dispatched to dedicated callbacks and never enter the per-turn queues.
 */
type TurnScopedStreamEvent = Extract<AgentStreamEvent, AgentStreamEventBase>

type OrphanNotification = { event: TurnScopedStreamEvent; turnId: string }

type PendingServerRequest = {
  wireId: number
  method: string
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
  /**
   * Max silence (no events at all) tolerated on an active turn before the
   * stream-idle watchdog ends it with a terminal error. `0` disables the
   * watchdog. Defaults to {@link DEFAULT_TURN_IDLE_TIMEOUT_MS}.
   */
  turnIdleTimeoutMs?: number
  /**
   * Opt into `#[experimental(...)]`-gated app-server surface by announcing
   * `capabilities: { experimentalApi: true }` at initialize (needed for
   * `collaborationMode/list` and `turn/start.collaborationMode`). Off by
   * default so the stable wire behaviour stays byte-identical.
   */
  experimentalApi?: boolean
  onLog?: (line: string) => void
  /**
   * A mapped event that belongs to no turn this client started — in practice a
   * sub-agent's thread (multi-agent V2 is on by default at 0.145, and a child
   * streams its whole turn under its own thread id on this connection).
   *
   * Exists so those events have somewhere to GO. They must not enter
   * `orphanEvents`: that buffer is only for the millisecond race between the
   * server streaming and `send()` registering its queue, and it is drained by
   * exact `(threadId, turnId)` match — a child's id is never claimed, so
   * buffering it leaks until the cap starts evicting the main thread's real
   * race orphans.
   */
  onUnroutedEvent?: (event: AgentStreamEvent, context: { turnId: string }) => void
  onApprovalRequest?: (request: CodexApprovalRequest) => void
  /**
   * 服务端自己解决/清理了某个待决请求（`serverRequest/resolved`）。上游会在 turn
   * 开始、完成或被打断时清掉未回答的请求并发这条通知，所以渲染层必须据此撤下审批
   * 卡 —— 它的 pendingApprovals 只在切换线程/新会话/删除线程时清空。
   */
  onApprovalResolved?: (info: { id: string; threadId?: string }) => void
  onMcpNotification?: (event: AgentStreamEvent) => void
  /**
   * Out-of-band native `/goal` updates (`thread/goal/updated|cleared`). Like
   * `onMcpNotification`, these are thread-scoped but turn-independent, so they
   * bypass the per-turn queue and go straight to the renderer's goal state.
   */
  onGoalNotification?: (event: AgentStreamEvent) => void
  onThreadSettingsNotification?: (
    event: Extract<AgentStreamEvent, { type: 'thread_settings_updated' }>,
  ) => void
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
  /**
   * Threads whose `turn/start` is in flight — the only threads whose events can
   * still be claimed by a queue that does not exist yet. Membership is what
   * separates "arrived a beat early" from "belongs to somebody else".
   */
  private readonly awaitingTurnStart = new Set<string>()
  private readonly rpcTimeoutMs: number
  private readonly approvalTimeoutMs: number
  private readonly connectTimeoutMs: number
  private readonly connectIntervalMs: number
  private readonly turnIdleTimeoutMs: number
  private sessionConfig: CodexSessionConfig
  private pendingServerRequests = new Map<string, PendingServerRequest>()
  private activeSends = 0

  constructor(private readonly options: CodexProtocolClientOptions) {
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.connectIntervalMs = options.connectIntervalMs ?? DEFAULT_CONNECT_INTERVAL_MS
    this.turnIdleTimeoutMs = options.turnIdleTimeoutMs ?? DEFAULT_TURN_IDLE_TIMEOUT_MS
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

    await this.rpc('initialize', {
      clientInfo: this.options.clientInfo,
      capabilities: this.options.experimentalApi ? { experimentalApi: true } : null,
    })
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

  /**
   * Thread-scoped busy probe (Plan B per-thread routing): reports whether the
   * given CODEX thread currently has an active turn. Unlike the global
   * {@link hasInFlightWork}, other threads' turns are invisible here — an
   * in-process provider switch only needs ITS OWN thread idle.
   */
  hasActiveTurnOnThread(threadId: string): boolean {
    return this.turnIdByThread.has(threadId)
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

      // `clientUserMessageId` (app-server v2): echoed back as `clientId` on
      // the turn's `userMessage` item, letting rollout history reconcile to
      // our persisted AgentMessage rows. Spread-omit when absent — older
      // binaries reject unknown/null fields.
      // `collaborationMode` (EXPERIMENTAL, needs experimentalApi capability):
      // preset that takes precedence over model/effort/instructions for this
      // and subsequent turns. Same spread-omit posture as clientUserMessageId.
      // Opens the buffering window for THIS thread and nothing else: events
      // arriving before the queue exists are ours to claim; events for any
      // other thread belong to a sub-agent and go to `onUnroutedEvent`.
      this.awaitingTurnStart.add(actualThreadId)
      let turnResponse: TurnStartResponse
      try {
        turnResponse = await this.rpc<TurnStartResponse>('turn/start', {
          threadId: actualThreadId,
          input: mapUserInput(input.items),
          model: input.model,
          ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
          ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
          ...(input.collaborationMode ? { collaborationMode: input.collaborationMode } : {}),
        })
      } catch (error) {
        this.awaitingTurnStart.delete(actualThreadId)
        throw error
      }
      const turnId = turnResponse.turn.id
      this.turnIdByThread.set(actualThreadId, turnId)

      const key = queueKey(actualThreadId, turnId)
      const queue: TurnQueue = { threadId: actualThreadId, turnId, buffer: [], closed: false }
      this.queues.set(key, queue)
      this.drainOrphansInto(actualThreadId, turnId, queue)
      // Closed only after the drain: anything still in flight now has a queue.
      this.awaitingTurnStart.delete(actualThreadId)

      try {
        while (true) {
          const event = await this.takeEvent(queue)
          yield event
          if (event.type === 'turn_completed' || event.type === 'cancelled') return
          // Stream-retry contract (openai/codex#7611): `willRetry: true` means
          // codex is retrying the SAME request and will re-stream on this same
          // turn — the queue must stay registered or the retry's events get
          // orphaned and the UI hangs. Only terminal errors end the stream.
          if (event.type === 'error' && event.willRetry !== true) return
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

  /**
   * Append user input to the in-flight turn without starting a new one
   * (Codex app-server `turn/steer`, openai/codex#10821 — a.k.a. "插话/steering").
   * Requires an active turn on the thread: the appended output rides the SAME
   * turn's event stream that the original `send()` generator is already
   * draining, so no new queue is registered here. Rejects if there is no active
   * turn (the caller surfaces it as a notice / falls back to a fresh turn).
   * Returns the accepted turnId.
   */
  async steer(threadId: string, input: AgentInput): Promise<string> {
    const expectedTurnId = this.turnIdByThread.get(threadId)
    if (!expectedTurnId) {
      throw new Error(`turn/steer: no active turn on thread ${threadId}`)
    }
    const response = await this.rpc<TurnSteerResponse>('turn/steer', {
      threadId,
      input: mapUserInput(input.items),
      expectedTurnId,
      ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
    })
    return response.turnId
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

  /**
   * Identity a spawned agent only exposes on its own thread record.
   *
   * Separate from `readThread` because that one normalizes down to the summary
   * shape the thread list needs, dropping exactly these fields.
   */
  async readSubagentInfo(threadId: string): Promise<CodexSubagentInfo | null> {
    const response = await this.rpc<unknown>('thread/read', { threadId })
    return extractSubagentInfo(extractThreadRecord(response))
  }

  async forkThread(
    threadId: string,
    overrides?: CodexThreadConfigOverrides,
    lastTurnId?: string,
  ): Promise<CodexThreadSummary> {
    // `lastTurnId` (codex 0.145 ThreadForkParams, camelCase on the wire):
    // "Optional last turn id to fork through, inclusive. When specified,
    // turns after last_turn_id are omitted from the fork." Spread-omit so
    // the legacy no-branch wire shape stays byte-identical for old binaries.
    const response = await this.rpc<unknown>('thread/fork', {
      threadId,
      ...threadConfigOverrideParams(overrides),
      ...(lastTurnId ? { lastTurnId } : {}),
    })
    return normalizeThreadSummary(extractThreadRecord(response))
  }

  /**
   * `thread/unsubscribe` — drop this connection's event subscription for a
   * thread. codex only unloads a loaded thread once it has NO subscribers and
   * has been idle for its unload window, so this is the required cleanup after
   * a provider-switch fork abandons the source thread.
   */
  async unsubscribeThread(threadId: string): Promise<void> {
    await this.rpc<unknown>('thread/unsubscribe', { threadId })
  }

  /**
   * Reopen a persisted thread by id (app-server v2 `thread/resume`,
   * `ThreadResumeParams = { threadId, ... }`) so subsequent `turn/start` calls
   * append to it. After an app-server respawn the new process has no in-memory
   * thread; resume loads the rollout from disk into this generation, restoring
   * the conversation. Response shape matches `thread/start` (`{ thread }`) but
   * the caller keeps the existing id, so we resolve void.
   *
   * `overrides` matters for cross-channel switches: codex restores the thread's
   * PERSISTED `model_provider` from metadata on resume (openai/codex#19287),
   * and after e.g. a grok→gpt switch that old provider table is no longer in
   * the launch config — resume then fails with "failed to load configuration:
   * Model provider `<old>` not found". Passing an explicit model/modelProvider
   * suppresses the persisted-metadata restore (`has_model_resume_override`) and
   * keeps the thread on the CURRENT selection. Other optional fields (e.g.
   * `excludeTurns`) stay omitted for compatibility with the bundled binary;
   * rejections bubble up so the caller can fall back to a fresh thread.
   */
  async resumeThread(
    threadId: string,
    overrides?: CodexThreadConfigOverrides,
  ): Promise<void> {
    await this.rpc<unknown>('thread/resume', {
      threadId,
      ...threadConfigOverrideParams(overrides),
    })
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

  /** List the runtime's model catalog instead of guessing model slugs in UI code. */
  async listModels(params?: CodexModelListParams): Promise<CodexModelListResponse> {
    return this.rpc<CodexModelListResponse>('model/list', params ?? {})
  }

  /**
   * List Codex feature flags with stage metadata + enabled/default state
   * (`experimentalFeature/list`, app-server v2). Used to discover the exact
   * feature key for gated capabilities (e.g. `memories`) instead of guessing.
   * `threadId` computes `enabled` from that thread's refreshed config; omit
   * for the server default. Response shape re-pinned against
   * v2/experimental_feature.rs @ rust-v0.145.0: rows live under `data` with a
   * `name` key (the old `features`/`id` shape predates 0.145 and never
   * matched the shipped wire format).
   */
  async experimentalFeatureList(params?: {
    threadId?: string
    cursor?: string
    limit?: number
  }): Promise<{
    data: Array<{
      name: string
      stage: string
      enabled: boolean
      defaultEnabled: boolean
      displayName?: string | null
      description?: string | null
    }>
    nextCursor?: string | null
  }> {
    return this.rpc('experimentalFeature/list', params ?? {})
  }

  /**
   * List collaboration-mode presets (`collaborationMode/list`, EXPERIMENTAL —
   * requires the client to have announced `capabilities.experimentalApi` at
   * initialize, i.e. the `experimentalApi: true` constructor option). Returns
   * masks like `{name: "Plan", mode: "plan", …}` used to populate a Plan/Code
   * mode picker; the chosen preset is sent as `turn/start.collaborationMode`.
   */
  async listCollaborationModes(): Promise<CollaborationModeListResponse> {
    return this.rpc('collaborationMode/list', {})
  }

  async updateThreadSettings(
    params: ThreadSettingsUpdateParams,
  ): Promise<ThreadSettingsUpdateResponse> {
    return this.rpc<ThreadSettingsUpdateResponse>('thread/settings/update', params)
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

  // ─── Goals (thread/goal/*, app-server v2) ─────────────────────────────────
  // Wire methods pinned from openai/codex `codex-rs/app-server/README.md`. A
  // goal is a persisted per-thread objective; set/get/clear are local SQLite
  // ops (no model call — they work offline). The `goals` feature is stable +
  // default-on in the bundled binary. Status changes stream back via the
  // `thread/goal/updated` / `thread/goal/cleared` notifications routed above.

  /** Create, replace, or update the current goal (or change its status). */
  async setThreadGoal(params: ThreadGoalSetParams): Promise<ThreadGoalSetResponse> {
    return this.rpc<ThreadGoalSetResponse>('thread/goal/set', params)
  }

  /** Read the current goal without changing it (`{ goal: null }` when unset). */
  async getThreadGoal(threadId: string): Promise<ThreadGoalGetResponse> {
    return this.rpc<ThreadGoalGetResponse>('thread/goal/get', { threadId })
  }

  /** Remove the current goal. */
  async clearThreadGoal(threadId: string): Promise<ThreadGoalClearResponse> {
    return this.rpc<ThreadGoalClearResponse>('thread/goal/clear', { threadId })
  }

  // ─── Context compaction (thread/compact/*, app-server v2) ─────────────────
  // Pinned from openai/codex `codex-rs/app-server/README.md`. Manual history
  // compaction: returns `{}` immediately, progress streams via standard
  // `turn/*` + `item/*` notifications (a single `contextCompaction` item,
  // started→completed). While compaction runs the thread is effectively in a
  // turn. This is REAL compaction — the model summarizes + drops history — not
  // a client-side prompt trick.
  async compactThread(threadId: string): Promise<Record<string, never>> {
    return this.rpc<Record<string, never>>('thread/compact/start', { threadId })
  }

  // ─── Cross-session memory (memories feature, app-server v2) ───────────────
  // Method strings + wire shapes pinned from openai/codex
  // `client_request_definitions!` @ common.rs and v2/thread.rs at
  // rust-v0.145.0. Both are `#[experimental(...)]`-gated, so they require the
  // `experimentalApi: true` constructor option (same gate as
  // collaborationMode/list). They act on `$CODEX_HOME/memories/` maintained by
  // the engine when `features.memories=true`.

  /**
   * Toggle memory eligibility for ONE thread (`thread/memoryMode/set`).
   * `mode` serializes lowercase per upstream `#[serde(rename_all =
   * "lowercase")]` on `ThreadMemoryMode`. Returns `{}`.
   */
  async setThreadMemoryMode(
    params: { threadId: string; mode: CodexThreadMemoryMode },
  ): Promise<Record<string, never>> {
    return this.rpc<Record<string, never>>('thread/memoryMode/set', params)
  }

  /**
   * Wipe the global memory store (`memory/reset`). Upstream declares params
   * as `Option<()>` with `skip_serializing_if = "Option::is_none"` — an empty
   * object would fail unit deserialization, so we pass `undefined` and rely
   * on JSON.stringify dropping the key so the request carries NO params
   * member at all. Returns `{}`.
   */
  async resetMemory(): Promise<Record<string, never>> {
    return this.rpc<Record<string, never>>('memory/reset', undefined)
  }

  // ─── Native Plugin / Marketplace / Connectors RPC (app-server v2, ≥0.140) ──
  // Method strings pinned from openai/codex
  // `app-server-protocol/src/protocol/common.rs` (client_request_definitions!),
  // originally at rust-v0.141.0 and revalidated at rust-v0.145.0. These require
  // a Codex binary ≥0.140; remote catalogs
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
    const result = pending.method === 'mcpServer/elicitation/request'
      ? {
          action: response.approved ? 'accept' : 'decline',
          content: null,
          _meta: null,
        }
      : {
          approved: response.approved,
          ...(response.message ? { message: response.message } : {}),
        }
    this.sendServerRequestResponse(pending.wireId, result)
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
    // Multi-repo AGENTS.md: aggregate the EXTRA selected roots' project-docs
    // (beyond the primary cwd, which the engine auto-loads) into a per-thread
    // `developer_instructions` override. Computed here so runtime folder
    // switches take effect on the next new thread. `undefined` → field omitted.
    const developerInstructions = buildExtraRootsDeveloperInstructions(
      input.cwd,
      sessionConfig.writableRoots,
    )
    // Per-thread routing (Plan B): `modelProvider` pins the new thread to a
    // registered provider table; the thread-scoped context keys pin only this
    // thread's window (unlike the process-wide `-c model_context_window`).
    // Both spread-omit so the legacy wire shape stays byte-identical.
    const pin = input.threadContextPin
    return {
      model: input.model,
      ...(input.modelProvider ? { modelProvider: input.modelProvider } : {}),
      cwd: input.cwd,
      sandbox: sessionConfig.sandboxMode,
      approvalPolicy: sessionConfig.approvalPolicy,
      config: {
        web_search: sessionConfig.webSearch,
        sandbox_workspace_write: {
          writable_roots: sessionConfig.writableRoots,
        },
        // Session tuning (smoke-verified overlay keys): new threads pick up
        // the CURRENT settings without a codex restart; the launch `-c` args
        // only serve as the process-level fallback.
        model_reasoning_summary: sessionConfig.reasoningSummary,
        show_raw_agent_reasoning: sessionConfig.showRawReasoning,
        ...(sessionConfig.personality !== 'default' ? { personality: sessionConfig.personality } : {}),
        ...(sessionConfig.modelVerbosity !== 'default' ? { model_verbosity: sessionConfig.modelVerbosity } : {}),
        ...(developerInstructions ? { developer_instructions: developerInstructions } : {}),
        ...(pin
          ? {
              model_context_window: pin.modelContextWindow,
              model_auto_compact_token_limit: pin.modelAutoCompactTokenLimit,
            }
          : {}),
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
      this.sendServerRequestResponse(
        msg.id,
        this.serverRequestRejection(msg.method, 'duplicate approval request id', 'decline'),
      )
      return
    }

    const params = toRecord(msg.params)
    const timer = setTimeout(() => {
      const pending = this.pendingServerRequests.get(id)
      if (!pending) return
      this.pendingServerRequests.delete(id)
      this.sendServerRequestResponse(
        pending.wireId,
        this.serverRequestRejection(pending.method, 'approval request timed out', 'cancel'),
      )
    }, this.approvalTimeoutMs)
    timer.unref?.()
    this.pendingServerRequests.set(id, { wireId: msg.id, method: msg.method, timer })

    this.options.onApprovalRequest?.({
      id,
      threadId: typeof params.threadId === 'string' ? params.threadId : undefined,
      method: msg.method,
      params,
      createdAt: new Date().toISOString(),
    })
  }

  private sendServerRequestResponse(id: number, result: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const payload = { jsonrpc: '2.0' as const, id, result }
    this.ws.send(JSON.stringify(payload))
  }

  private serverRequestRejection(
    method: string,
    message: string,
    elicitationAction: 'decline' | 'cancel',
  ): unknown {
    if (method === 'mcpServer/elicitation/request') {
      return { action: elicitationAction, content: null, _meta: null }
    }
    return { approved: false, message }
  }

  private denyAllServerRequests(message: string): void {
    for (const [id, pending] of this.pendingServerRequests) {
      this.pendingServerRequests.delete(id)
      clearTimeout(pending.timer)
      this.sendServerRequestResponse(
        pending.wireId,
        this.serverRequestRejection(pending.method, message, 'cancel'),
      )
    }
  }

  private clearPendingServerRequests(): void {
    for (const pending of this.pendingServerRequests.values()) {
      clearTimeout(pending.timer)
    }
    this.pendingServerRequests.clear()
  }

  /**
   * 服务端已自行解决/清理该请求 —— 清掉本地待决项与它的超时定时器，**不回响应**
   * （回了会是对一个已丢弃请求的应答）。未知 id 不做任何事。
   */
  private handleServerRequestResolved(params: Record<string, any>): void {
    const raw = params?.requestId
    if (typeof raw !== 'string' && typeof raw !== 'number') return
    const id = String(raw)
    const pending = this.pendingServerRequests.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pendingServerRequests.delete(id)
    this.options.onApprovalResolved?.({
      id,
      ...(typeof params?.threadId === 'string' ? { threadId: params.threadId } : {}),
    })
  }

  private routeNotification(method: string, params: Record<string, any>): void {
    if (method === 'serverRequest/resolved') {
      this.handleServerRequestResolved(params)
      return
    }

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
      // thread/started, turn/started, warning,
      // remoteControl/status/changed (0.145+ remote-control daemon status —
      // we never pair a remote controller, so it is always "disabled" noise).
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
    if (event.type === 'goal_updated' || event.type === 'goal_cleared') {
      this.options.onGoalNotification?.(event)
      return
    }
    if (event.type === 'thread_settings_updated') {
      this.options.onThreadSettingsNotification?.(event)
      return
    }
    if (event.type === 'skills_changed' || event.type === 'notice') {
      // Not turn-scoped (no threadId); the router never produces these today.
      // Drop rather than wedge them into a per-turn queue they don't belong to.
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
    // had a chance to register the per-turn queue. Buffer until it appears —
    // but ONLY for a thread we are mid-`turn/start` on. Anything else has no
    // future claimant (a sub-agent's thread never gets a queue here), and
    // buffering it would fill the cap and start evicting the events this
    // buffer exists to protect.
    if (this.awaitingTurnStart.has(threadId)) {
      if (this.orphanEvents.length < ORPHAN_BUFFER_LIMIT) {
        this.orphanEvents.push({ event, turnId })
      }
      return
    }
    // The turn id rides along because it is not on the event and cannot be
    // recovered later: interrupting a sub-agent needs its own
    // `(threadId, turnId)`, and this is the only place both are in hand.
    this.options.onUnroutedEvent?.(event, { turnId })
  }

  /**
   * Interrupt a turn on any thread, including one this client never started.
   *
   * `cancel()` cannot serve here: it resolves the turn id from
   * `turnIdByThread`, which only knows threads we opened. A sub-agent's turn is
   * addressable all the same — measured with
   * `scripts/smoke-subagents.ts --interrupt-child`, the server accepts it and
   * the child's turn ends.
   */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    try {
      await this.rpc('turn/interrupt', { threadId, turnId })
    } catch (error) {
      this.options.onLog?.(`[codex] turn/interrupt (sub-agent) rejected: ${stringifyError(error)}`)
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
      // Stream-idle watchdog: the timer spans exactly one inter-event gap
      // (armed only while we're actually waiting; any arriving event clears
      // it), so steady deltas never trip it — only a truly silent turn does.
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      const waiter = (event: AgentStreamEvent): void => {
        if (idleTimer) clearTimeout(idleTimer)
        resolve(event)
      }
      if (this.turnIdleTimeoutMs > 0) {
        idleTimer = setTimeout(() => {
          if (queue.waiter === waiter) queue.waiter = undefined
          this.options.onLog?.(
            `[codex] turn ${queue.turnId} idle for ${this.turnIdleTimeoutMs}ms — ending stream (watchdog)`,
          )
          resolve({
            type: 'error',
            threadId: queue.threadId,
            turnId: queue.turnId,
            error: `Codex 回合空闲超过 ${Math.round(this.turnIdleTimeoutMs / 1000)}s 无任何事件,已由看门狗终止(stream idle watchdog)`,
          })
        }, this.turnIdleTimeoutMs)
        idleTimer.unref?.()
      }
      queue.waiter = waiter
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

/**
 * Pull the spawn identity out of a thread record, tolerating both spellings
 * upstream ships: a top-level camelCase `agentNickname` plus the snake_case
 * spawn record it mirrors (`source.subAgent.thread_spawn`).
 */
function extractSubagentInfo(record: Record<string, unknown>): CodexSubagentInfo | null {
  const spawn = toRecord(toRecord(toRecord(record.source).subAgent).thread_spawn)
  const nickname = stringField(record, 'agentNickname') ?? stringField(spawn, 'agent_nickname')
  return nickname ? { nickname } : null
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
