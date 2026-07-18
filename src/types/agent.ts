import type { CodexUserMessageReconcile, TimelineItem } from './agent-timeline'
import type { AgentReference } from './agent-reference'
import type { ThreadGoal } from './codexGoals'
import type { PlanReasoningEffort } from '../shared/collaborationMode'
import type {
  ConcreteModelReasoningEffort,
  ModelSettingsCapabilities,
} from '../shared/modelSettings'

// Canonical home is agent-timeline.ts (BaseItem.codexReconcile persists the
// same shape); re-exported here because stream-event consumers import all
// event payload types from types/agent.
export type { CodexReconcileTextElement, CodexUserMessageReconcile } from './agent-timeline'

export type AgentRole = 'user' | 'assistant' | 'system' | 'tool'
export type AgentToolStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'
export type AgentArtifactType = 'image' | 'file' | 'link'

export interface AgentAttachmentInput {
  /**
   * Renderer-only stable identity for composer chips. Filenames are not unique
   * (clipboard screenshots commonly all arrive as `image.png`), so UI list
   * reconciliation and removal must not use `name` as identity.
   */
  composerId?: string
  name: string
  mime: string
  size: number
  path?: string
  buffer?: ArrayBuffer
}

export interface AgentSkillRef {
  name: string
  path: string
}

/**
 * Plugin / app invocation resolved from an `@token` in `content`. Mirrors the
 * codex app-server `mention` input item: `path` is the exact
 * `plugin://<plugin-name>@<marketplace-name>` returned by `plugin/installed`
 * (or `app://<connector-id>` for ChatGPT apps). Per the README, sending the
 * mention item alongside the text token is what makes codex use the exact
 * target "rather than guessing by name".
 */
export interface AgentMentionRef {
  name: string
  path: string
}

export interface AgentCollaborationCapabilities {
  providerId: string
  backendEpoch?: number
  planDefaultEffort: string | null
  supportedPlanEfforts: string[]
  source: 'codex' | 'fallback'
}

/** Confirmed applied Codex Provider state returned by Provider write IPCs. */
export interface AgentProviderMutationResult {
  activeId: string
  /** Backend generation that owns activeId; absent for non-generational backends. */
  providerGeneration?: number
}

export type AgentCollaborationCapabilitiesResult =
  | { ok: true; data: AgentCollaborationCapabilities }
  | { ok: false; error: string }

export interface AgentCollaborationModeUpdatePayload {
  threadId: string
  mode: 'default' | 'plan'
  model: string
  defaultReasoningEffort?: ConcreteModelReasoningEffort
  planReasoningEffort: PlanReasoningEffort
  requestVersion: number
}

export type AgentCollaborationModeUpdateResult =
  | {
      ok: true
      data: {
        compatibility: 'immediate' | 'next-turn'
        requestVersion: number
      }
    }
  | { ok: false; error: string; requestVersion: number }

export interface AgentSendMessagePayload {
  threadId?: string
  content: string
  attachments: AgentAttachmentInput[]
  references?: AgentReference[]
  currentPage?: string
  /**
   * Caller-selected model id (e.g. `gpt-4.1`, `o4-mini`). When omitted the
   * main process falls back to its default. Forwarded to Codex's `turn/start`
   * via `AgentManager.sendMessage`.
   */
  model?: string
  /**
   * Renderer-confirmed Gateway/model/context intent. The main process verifies
   * this route before accepting a turn so a model can never be sent through a
   * stale Provider Channel.
   */
  modelSelection?: AgentModelSelectionIntent
  /**
   * Native Codex reasoning-effort override for the selected model. This is
   * independent from the model slug and is forwarded as `turn/start.effort`.
   */
  reasoningEffort?: ConcreteModelReasoningEffort
  /**
   * Skills explicitly invoked via `$skill-name` tokens in `content`. When the
   * renderer can resolve the path locally (e.g. via `getSkillsSummary`) it
   * forwards `{ name, path }` here so the main process can attach a `skill`
   * input item to the codex turn — per the codex app-server README this is
   * what makes Codex inject full skill instructions instead of letting the
   * model resolve `$name` itself (which adds latency).
   */
  skills?: AgentSkillRef[]
  /**
   * Plugins/apps explicitly invoked via `@token` in `content`, resolved by the
   * renderer against `plugin/installed`. The main process attaches one
   * `mention` input item per unique path so codex activates the exact plugin.
   */
  mentions?: AgentMentionRef[]
  /**
   * EXPERIMENTAL collaboration-mode preset KIND selected in the composer
   * ('plan' = codex's built-in Plan mode). The main process expands an
   * explicitly supplied Plan or Default into the full codex
   * `CollaborationMode` for `turn/start`; only a genuinely absent field keeps
   * legacy callers' wire behavior unchanged.
   */
  collaborationModeKind?: 'plan' | 'default'
  /** Plan-only effort preference; Auto resolves against Codex's Plan preset. */
  planReasoningEffort?: PlanReasoningEffort
}

/**
 * Return shape of `agent:send-message`.
 *
 * The optional `userMessageItems` carries the *canonicalized* user-turn
 * timeline items (post-attachment-ingest URIs that point at
 * `<userData>/agent/uploads/<hash>.ext`). The renderer's optimistic
 * `send()` initially pushes the user message with the **raw OS path**
 * each attachment was picked from (e.g. `D:\360MoveData\...\foo.png`).
 * Those paths sit outside the fs IPC's allowed-roots gate, so:
 *
 *   - clicking the attachment chip → AttachmentCard.handleClick →
 *     openReference → file-explorer openTab → `fs:stat` REJECTS → tab
 *     silently never opens → ImageViewer never mounts → `useFileUrl`
 *     never runs.
 *
 * After we patch the optimistic message in place with these canonical
 * items, the attachment chip references the uploads-cache path, which
 * IS in allowed-roots, so the tab opens immediately without the
 * "refresh to view" workaround the user previously had to use.
 */
export interface AgentSendMessageResult {
  threadId: string
  userMessageItems?: TimelineItem[]
}

export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never'
export type CodexWebSearchMode = 'cached' | 'live' | 'disabled'

export interface CodexModelContextConfig {
  modelContextWindow: number
  modelAutoCompactTokenLimit: number
}

export type AgentModelFamily = 'openai' | 'xai' | 'other'

export interface AgentModelRoute {
  gatewayId: string
  channelId: string
  modelId: string
  family: AgentModelFamily
}

export type AgentModelAvailability =
  | { status: 'available' }
  | { status: 'needs-key'; reason: string }
  | { status: 'unauthorized'; reason: string }

export interface AgentGatewayRecord {
  id: string
  name: string
  description?: string
  credentialId: string
  defaultChannelId: string
  channelIds: string[]
  isCustom?: boolean
}

export interface AgentModelSettingsEntry {
  id: string
  displayName: string
  description: string
  hidden: boolean
  isDefault: boolean
  family: AgentModelFamily
  route: AgentModelRoute
  availability: AgentModelAvailability
  capabilities: ModelSettingsCapabilities
}

export interface AgentModelSettingsCatalog {
  gatewayId: string
  revision: string
  source: 'codex' | 'mixed' | 'fallback'
  models: AgentModelSettingsEntry[]
}

export type AgentModelSettingsCatalogResult =
  | { ok: true; data: AgentModelSettingsCatalog }
  | { ok: false; error: string }

/** One Gateway/model/context choice asserted by the renderer. */
export interface AgentModelSelectionIntent {
  gatewayId: string
  modelId: string
  contextWindow: number
  catalogRevision: string
  /**
   * `context-only` is reserved for the explicit Context control. Model and turn
   * selection preserve the active Context whenever the target model supports it.
   */
  contextSource?: 'model-selection' | 'context-only'
}

/** A versioned model-selection request that may be tied to a persisted thread. */
export interface AgentModelSelectionApplyPayload
  extends AgentModelSelectionIntent {
  threadId?: string
  /**
   * Renderer-owned correlation version. It is not the cross-origin ordering
   * clock; the main process reserves a separate internal intent sequence.
   */
  requestVersion: number
}

/**
 * Thread-scoped model state, preserving missing-vs-unset identity. The
 * optional routing fields carry the thread's Plan B provider binding when the
 * snapshot source knows it; absent/null = unbound (legacy row or global-only
 * snapshot), which callers resolve against the active gateway.
 */
export type AgentThreadModelSnapshot =
  | { exists: false }
  | {
    exists: true
    model: string | null
    gatewayId?: string | null
    modelProvider?: string | null
  }

/**
 * Thread-scoped routing binding (Plan B per-thread provider routing). Null
 * gatewayId/modelProvider mark a pre-migration row — callers must derive a
 * fallback from the active gateway + the thread's persisted model instead of
 * treating the thread as broken.
 */
export type AgentThreadRoutingSnapshot =
  | { exists: false }
  | {
    exists: true
    model: string | null
    gatewayId: string | null
    modelProvider: string | null
  }

/** Fully confirmed Gateway, Channel, model, and context state. */
export interface AgentModelSelectionSnapshot {
  gatewayId: string
  channelId: string
  modelId: string
  /** Target thread state used for validation and thread-scoped rollback. */
  thread?: AgentThreadModelSnapshot
  contextWindow: number
  autoCompactTokenLimit: number
  catalogRevision: string
  backendEpoch?: number
  threadRestored: boolean
}

/** Stable classification for selection failures exposed across IPC. */
export type AgentModelSelectionErrorKind =
  | 'configuration'
  | 'transient'
  | 'transaction'

/** Last transaction stage reached before a selection failed. */
export type AgentModelSelectionStage =
  | 'validate'
  | 'busy'
  | 'persist'
  | 'restart'
  | 'catalog'
  | 'resume'
  | 'verify'
  | 'rollback'

/** Atomic selection outcome, including compensation and recovery state. */
export type AgentModelSelectionApplyResult =
  | {
      ok: true
      data: AgentModelSelectionSnapshot & { requestVersion: number }
    }
  | {
      ok: false
      error: string
      kind: AgentModelSelectionErrorKind
      stage: AgentModelSelectionStage
      retryable: boolean
      /** Runtime identity is unprovable until an explicit recovery succeeds. */
      recoveryRequired: boolean
      requestVersion: number
      previous: AgentModelSelectionSnapshot
      rollback:
        | { ok: true; snapshot: AgentModelSelectionSnapshot }
        | { ok: false; error: string; effectiveSnapshot: null }
    }

/** Explicit recovery outcome for a poisoned model-selection runtime. */
export type AgentModelSelectionRecoveryResult =
  | {
      ok: true
      recoveryRequired: false
      snapshot: AgentModelSelectionSnapshot | null
    }
  | {
      ok: false
      error: string
      stage: 'busy' | 'recovery'
      retryable: boolean
      recoveryRequired: boolean
    }

export type AgentModelContextSnapshot = CodexModelContextConfig & {
  recoveryRequired: boolean
  recoveryError?: string
}

export type AgentModelContextSnapshotResult =
  | { ok: true; data: AgentModelContextSnapshot }
  | { ok: false; error: string }

export interface AgentModelContextApplyPayload {
  threadId?: string
  model: string
  contextWindow: number
  requestVersion: number
}

export type AgentModelContextApplyStage =
  | 'validate'
  | 'busy'
  | 'persist'
  | 'restart'
  | 'catalog'
  | 'resume'
  | 'verify'
  | 'rollback'

export type AgentModelContextRollbackResult =
  | {
      ok: true
      activeConfig: CodexModelContextConfig
    }
  | {
      ok: false
      error: string
      effectiveConfig: null
    }

export type AgentModelContextApplyResult =
  | {
      ok: true
      data: {
        model: string
        contextWindow: number
        autoCompactTokenLimit: number
        threadRestored: boolean
        requestVersion: number
      }
    }
  | {
      ok: false
      error: string
      stage: AgentModelContextApplyStage
      previousConfig: CodexModelContextConfig
      attemptedConfig: CodexModelContextConfig
      requestVersion: number
      rollback: AgentModelContextRollbackResult
    }

export interface CodexSessionConfig {
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  webSearch: CodexWebSearchMode
  writableRoots: string[]
}

export interface CodexSessionStatus {
  model: string
  sandboxMode: CodexSandboxMode
  approvalPolicy: CodexApprovalPolicy
  webSearch: CodexWebSearchMode
  writableRoots: string[]
}

export interface CodexApprovalRequest {
  id: string
  threadId?: string
  method: string
  params: Record<string, unknown>
  createdAt: string
}

export interface CodexApprovalResponse {
  id: string
  approved: boolean
  message?: string
}

export interface CodexThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  cwd?: string
  model?: string
}

export interface CodexThreadDetail extends CodexThreadSummary {}

export type DoctorStatus = 'ok' | 'warn' | 'fail' | (string & {})

/** One diagnostic check from `codex doctor --json` (rust-v0.137.0 schema). */
export interface DoctorCheck {
  id: string
  category: string
  status: DoctorStatus
  summary: string
  details: Record<string, unknown>
  remediation: string | null
  durationMs: number
}

/** Parsed `codex doctor --json` report; `checks` is flattened to an array. */
export interface DoctorReport {
  schemaVersion: number
  generatedAt: string
  overallStatus: DoctorStatus
  codexVersion: string
  checks: DoctorCheck[]
}

export interface CodexMcpServerSummary {
  name: string
  transport: string
  enabled: boolean
  required: boolean
  command?: string
  url?: string
}

export interface CodexMcpSummary {
  servers: CodexMcpServerSummary[]
  warnings: string[]
}

/**
 * Codex skill scope for the chat `$skill` popup. Matches Codex official docs:
 * - `repo`    → `<projectRoot>/.agents/skills` (Codex REPO)
 * - `user`    → `$HOME/.agents/skills`        (Codex USER)
 * - `system`  → `<resourcesPath>/.agents/skills` shipped read-only with the app (Codex SYSTEM)
 *
 * (Codex ADMIN scope is not yet implemented client-side.)
 */
export type CodexSkillScope = 'repo' | 'user' | 'system'

export interface CodexSkillSummary {
  name: string
  scope: CodexSkillScope
  description: string
  path: string
}

export interface CodexSkillsSummary {
  skills: CodexSkillSummary[]
  warnings: string[]
}

export interface AgentCancelPayload {
  threadId: string
}

export interface AgentThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /**
   * ISO timestamp of the most recent persisted message in the thread.
   * Drives sidebar grouping ("Today" / "Yesterday" / etc). Optional because
   * a brand-new empty thread has none yet.
   */
  lastMessageAt?: string | null
  /**
   * `true` once the user manually renamed the thread. Sidebar uses this to
   * skip auto-title summarization side-effects and to show a small "✎" hint.
   */
  manualTitle?: boolean
}

export interface AgentArtifact {
  id: string
  type: AgentArtifactType
  uri: string
  metadata: Record<string, unknown>
  createdAt: string
}

export interface AgentToolEvent {
  id: string
  name: string
  status: AgentToolStatus
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: string
}

export type ItemDeltaPatch =
  | { kind: 'appendText'; field: 'content' | 'stdout' | 'stderr'; text: string }
  | { kind: 'mergeFields'; fields: Record<string, unknown> }

export interface AgentTokenUsageDelta {
  /** Per-turn input tokens. */
  inputTokens: number
  /** Per-turn output tokens. */
  outputTokens: number
  /** Per-turn reasoning tokens (subset of output). */
  reasoningTokens?: number
  /** Per-turn cached input tokens. */
  cachedInputTokens?: number
}

export interface AgentTokenUsage {
  /** Cumulative input tokens consumed in this thread. */
  inputTokens: number
  /** Cumulative output tokens emitted in this thread. */
  outputTokens: number
  /** Cumulative reasoning tokens (subset of output for reasoning-capable models). */
  reasoningTokens?: number
  /** Cached input tokens for this turn (provider-side prompt caching). */
  cachedInputTokens?: number
  /** Hard context window for the active model, in tokens. Optional because some gateways omit it. */
  contextWindow?: number
  /**
   * Tokens currently considered "in the prompt" — the live context-window
   * occupancy that drives the usage meter and signals when Codex will compact.
   * Sourced (in order): the gateway's explicit `contextUsage`, else synthesized
   * from codex `last_token_usage` (`last.inputTokens + last.outputTokens` — the
   * last request's absolute size), and only as a last resort the cumulative
   * `inputTokens + outputTokens`. NOT the cumulative total, which sums every
   * request's prompt across the thread and would pin the meter at 100%.
   */
  contextUsage?: number
  /**
   * Per-turn delta from Codex's `tokenUsage.last` slice. Cumulative fields
   * above describe the whole thread; `last` describes only the most-recent
   * turn so the popover can render "Last turn: +1.3K / +234". Omitted when
   * the gateway didn't send a `last` slice or when the slice carried only
   * zeroes (treated as "no signal" — we never fabricate per-turn data).
   */
  last?: AgentTokenUsageDelta
}

export interface AgentStreamEventBase {
  threadId: string
  turnId?: string
}

/**
 * Lightweight notice surfaced by the chat panel. Used for:
 *   - `configWarning` (codex emits when config has invalid keys, etc.)
 *   - `deprecationNotice` (warns about removed/renamed RPCs)
 *   - `modelRerouted` (codex routed gpt-5 → gpt-4-turbo behind the scenes)
 *   - `hookStarted` / `hookCompleted` (extension hooks lifecycle pulse)
 *   - `autoApprovalReview` (auto-approver inspecting an action; informational)
 *   - `contextHighWatermark` (renderer-detected: context window crossed the
 *     70% mark — Codex auto-compacts at 90% but if we reach ~95% there is no
 *     room left to emit a summary; see openai/codex#10823 community thread)
 */
export type AgentNoticeKind =
  | 'configWarning'
  | 'deprecation'
  | 'modelRerouted'
  | 'hookStarted'
  | 'hookCompleted'
  | 'autoApprovalReview'
  | 'autoApprovalReviewCompleted'
  | 'contextHighWatermark'
  /**
   * A poisoned codex thread (replayed history rejected by the gateway —
   * request_too_large / 413) was abandoned and the current message re-sent on
   * a fresh codex thread. The chat keeps working but codex-side memory of
   * earlier turns is gone; the user should re-state key context.
   */
  | 'threadContextReset'
  | 'attachmentSkipped'
  /**
   * A `turn/steer` interjection lost the race against turn completion ("no
   * active turn"), so the already-persisted message was delivered as a fresh
   * turn instead. Informational — the conversation keeps flowing.
   */
  | 'steerFallback'
  /**
   * Auto-recovery from PGlite NODEFS abort (upstream PGlite #884 / #794):
   * the local pgdata couldn't be reopened (crash, force-quit, dual instance,
   * installer overwrite) so we either moved the corrupt dir aside and rebuilt,
   * or fell back to an ephemeral non-persistent dir if the circuit breaker
   * tripped. Surfaces with `details.backupPath` or `details.ephemeralDir`.
   */
  | 'pgliteReset'

export interface AgentNotice {
  /** Stable id so the renderer can dedupe identical notices. */
  id: string
  kind: AgentNoticeKind
  level: 'info' | 'warning'
  message: string
  /** Optional thread scope; thread-less notices apply globally. */
  threadId?: string
  /** Source-specific structured details for the UI to render extras (e.g. fromModel/toModel). */
  details?: Record<string, unknown>
}

export type AgentStreamEvent =
  | (AgentStreamEventBase & { type: 'thread_created' })
  | (AgentStreamEventBase & { type: 'item_started'; itemId: string; itemType: TimelineItem['type']; payload: Record<string, unknown> })
  | (AgentStreamEventBase & { type: 'item_delta'; itemId: string; itemType: TimelineItem['type']; patch: ItemDeltaPatch })
  | (AgentStreamEventBase & { type: 'item_completed'; itemId: string; itemType: TimelineItem['type']; final: Record<string, unknown> })
  | (AgentStreamEventBase & { type: 'turn_completed' })
  | (AgentStreamEventBase & { type: 'token_usage_updated'; usage: AgentTokenUsage })
  /**
   * `willRetry: true` mirrors codex's stream-error notification: the backend
   * will retry the SAME model request and re-stream the full response under
   * NEW item ids. Clients must drop the failed attempt's partial text or
   * reasoning output and keep the turn running instead of terminating.
   */
  | (AgentStreamEventBase & { type: 'error'; error: string; willRetry?: boolean })
  | (AgentStreamEventBase & { type: 'cancelled' })
  /**
   * Internal (main-process only): the turn's canonical `userMessage` echo.
   * AgentManager consumes this to reconcile rollout data onto our DB row and
   * never forwards it to the renderer — the user bubble was already rendered
   * locally by `store.send()`, so surfacing it would duplicate the message.
   */
  | (AgentStreamEventBase & { type: 'user_message_reconciled'; reconcile: CodexUserMessageReconcile })
  /**
   * Internal confirmation of persisted Codex thread settings. Thread-scoped
   * but turn-independent, so it bypasses the per-turn lifecycle queue.
   */
  | {
      type: 'thread_settings_updated'
      threadId: string
      mode: 'default' | 'plan'
      model: string
      effort: string | null
    }
  | (AgentStreamEventBase & { type: 'attachment_error'; name: string; error: string })
  | { type: 'mcp_status_updated'; name: string; status: string; error: string | null }
  | { type: 'mcp_oauth_completed'; name: string; success: boolean; error: string | null }
  | { type: 'skills_changed' }
  // Native `/goal`: thread-scoped, turn-independent objective updates. Routed
  // out-of-band (like the mcp_* events) to a dedicated side channel, not the
  // per-turn queue, so goal status stays live even between turns.
  | { type: 'goal_updated'; threadId: string; goal: ThreadGoal }
  | { type: 'goal_cleared'; threadId: string }
  | { type: 'notice'; notice: AgentNotice }

export interface AgentToolRequest {
  id: string
  toolName: string
  params: Record<string, unknown>
  /**
   * DB thread id of the chat that requested this tool, reverse-mapped from the
   * Codex `_meta` thread id by the main process. Lets the renderer attribute a
   * tool's UI (e.g. a generated image) to the requesting chat even when the
   * user has switched to another chat. Undefined for older codex / manual calls.
   */
  threadId?: string
}

export interface AgentToolResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

/**
 * Terminal status broadcast from the renderer to the main process for an
 * asynchronous image task (generate_image / generate_images).
 *
 * The image render runs in the RENDERER (it owns the API client, history,
 * R2, file-panel save). To make image generation "truly async" — matching the
 * Seedance video task model — main no longer holds the long `router.call`
 * IPC open for the whole render. Instead main pre-registers a task, kicks the
 * renderer off (which acks immediately), and the renderer pushes ONE terminal
 * update back over `image:task-update` when the background render settles. The
 * main `ImageTaskManager` mirrors that state so `generate_image` /
 * `check_image_task` can long-poll it exactly like `check_video_task`.
 *
 * Only terminal transitions are broadcast — intermediate "generating" progress
 * is driven directly in the renderer chat bubble, so it never needs to round-
 * trip through main.
 */
export interface ImageTaskUpdate {
  /** Task id assigned by main (passed to the renderer as `params.__taskId`). */
  taskId: string
  /** 'single' = generate_image, 'batch' = generate_images. */
  kind: 'single' | 'batch'
  status: 'succeeded' | 'failed'
  /**
   * single: the renderer generate result `{ ok, count, model, historyId, paths, persistencePending? }`.
   * batch:  `{ successes, failures, savedPaths }`.
   */
  result?: unknown
  error?: string
}

/**
 * Shape returned by the renderer-facing agent IPC calls that don't have a
 * domain-specific payload (`agent:set-api-key`, `agent:test-connection`).
 * Kept narrow on purpose — main and preload both import this so their
 * signatures stay in lock-step.
 */
export interface AgentApiResult {
  ok: boolean
  error?: string
}

/** Writable scopes for MCP config & user-authored skills (Codex `personal` ≈ user, `workspace` ≈ repo). */
export type CodexConfigScope = 'personal' | 'workspace'

/**
 * Listing scope for skills, matching Codex official documentation naming:
 *   - `repo`    → workspace-local skills (writable; alias of CodexConfigScope 'workspace')
 *   - `user`    → home-directory skills (writable; alias of CodexConfigScope 'personal')
 *   - `system`  → bundled-with-installer skills (read-only, packaged mode only)
 *
 * (Codex ADMIN scope not yet implemented.)
 */
export type CodexSkillListScope = 'user' | 'repo' | 'system'

export interface CodexMcpServerInput {
  id?: string
  name: string
  scope: CodexConfigScope
  enabled: boolean
  command: string
  args: string[]
  env: Array<{ key: string; value: string }>
  description?: string
}

export interface CodexMcpServerListItem {
  id: string
  name: string
  scope: CodexConfigScope
  enabled: boolean
  command: string
  argsSummary: string
  envKeysRedacted: string[]
  description?: string
  lastModifiedIso: string
  provenance: 'manual' | 'clipboard' | 'imported'
  warnings: string[]
}

export interface CodexSkillInput {
  id?: string
  name: string
  scope: CodexConfigScope
  description: string
  whenToUse: string
  instructions: string
}

export interface CodexSkillListItem {
  id: string
  name: string
  scope: CodexSkillListScope
  path: string
  description?: string
  warnings: string[]
  /** True for read-only bundled skills shipped with the installer. */
  readOnly?: boolean
}

export interface CodexAuditLogEntry {
  tsIso: string
  action: 'mcp.save' | 'mcp.delete' | 'mcp.set-enabled' | 'skill.save' | 'skill.delete' | 'codex.restart'
  scope?: CodexConfigScope
  name?: string
  provenance?: 'manual' | 'clipboard' | 'imported'
  ok: boolean
  error?: string
}

export interface CodexWorkspacePaths {
  personalConfigToml: string
  personalSkillsRoot: string
  workspaceConfigToml: string
  workspaceSkillsRoot: string
  /**
   * Optional read-only root for `system` scope — skills shipped inside the
   * installer (`<resourcesPath>/.agents/skills` in packaged mode; undefined in
   * dev). Matches Codex official SYSTEM scope.
   */
  systemSkillsRoot?: string
  /**
   * Additional legacy USER-scope skill roots discovered alongside
   * `personalSkillsRoot`. Entries surface as `user` scope and are de-duplicated
   * by skill directory name, with the official `personalSkillsRoot` winning on
   * collision. Used to surface skills written by:
   *   - this app's pre-codex `save-skill` IPC (`<userData>/skills`),
   *   - the Codex CLI legacy USER path (`$HOME/.codex/skills`), still loaded by
   *     the official CLI per openai/codex#14337 but slated for deprecation.
   */
  legacyUserSkillsRoots?: string[]
  runtimeConfigToml: string
  auditLogPath: string
}
