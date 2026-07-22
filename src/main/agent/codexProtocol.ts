import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexWebSearchMode,
} from '../../types/agent'

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }

export interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: unknown; error?: { code: number; message: string } }
export interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: unknown }
export interface JsonRpcServerRequest { jsonrpc: '2.0'; id: number; method: string; params?: unknown }

export type ServerMessage = JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest

export function isServerNotification(msg: ServerMessage): msg is JsonRpcNotification {
  return typeof (msg as JsonRpcNotification).method === 'string' && (msg as JsonRpcServerRequest).id === undefined
}

export function isServerRequest(msg: ServerMessage): msg is JsonRpcServerRequest {
  return typeof (msg as JsonRpcServerRequest).method === 'string' && typeof (msg as JsonRpcServerRequest).id === 'number'
}

export interface ClientInfo { name: string; title?: string | null; version: string }
/**
 * `capabilities.experimentalApi` unlocks `#[experimental(...)]`-gated surface
 * (collaborationMode/list, turn/start.collaborationMode, thread/items/list…).
 * `null` = today's stable-only behaviour, byte-identical wire output.
 */
export interface InitializeParams { clientInfo: ClientInfo; capabilities: { experimentalApi: true } | null }
export interface InitializeResponse { userAgent: string; codexHome: string; platformFamily: string; platformOs: string }

export interface Thread { id: string; preview: string; cwd: string }
export interface Turn { id: string; status: string }

export interface ThreadStartParams {
  model?: string
  modelProvider?: string
  cwd?: string
  sandbox?: CodexSandboxMode
  approvalPolicy?: CodexApprovalPolicy
  config?: {
    web_search: CodexWebSearchMode
    sandbox_workspace_write: {
      writable_roots: string[]
    }
    /**
     * Per-thread developer-role instructions. We use this to inject the
     * `AGENTS.md` (+ fallbacks) of EXTRA selected workspace repositories — the
     * ones beyond the primary `cwd`, whose docs the engine's root→cwd walk does
     * NOT load. `developer_instructions` is a native ConfigToml field
     * (codex-rs/config/src/config_toml.rs); passing it in the per-thread
     * `config` override makes runtime folder switches take effect next turn.
     * Omitted entirely when there are no extra repos with docs.
     */
    developer_instructions?: string
    /**
     * Per-thread context pin (Plan B). Unlike the launch-level `-c
     * model_context_window` override — which applies process-wide and forces a
     * restart to change — these thread-scoped keys pin ONLY this thread's
     * window/auto-compact budget. Verified accepted by the bundled binary in
     * scripts/smoke-per-thread-provider.ts. Spread-omit when unpinned so codex
     * resolves both from its native per-model metadata.
     */
    model_context_window?: number
    model_auto_compact_token_limit?: number
    /**
     * Session tuning overlay (smoke-verified in
     * scripts/smoke-session-tuning-overlay.ts): riding these on thread/start
     * makes settings changes take effect for NEW threads immediately, without
     * a codex restart. `personality` is spread-omitted when the user keeps
     * the 'default' choice so codex resolves its own built-in default.
     */
    personality?: string
    model_reasoning_summary?: string
    show_raw_agent_reasoning?: boolean
    /**
     * GPT-5 output verbosity (batch 2, smoke-batch2-overlay.ts). Spread-omitted
     * when the user keeps 'default' so codex resolves its own default.
     */
    model_verbosity?: string
  }
}
export interface ThreadStartResponse { thread: Thread }

/**
 * Explicit config overrides for `thread/resume` / `thread/fork`
 * (`ThreadResumeParams.model` / `.modelProvider` in app-server v2). When any
 * of these are present, codex skips restoring the thread's persisted
 * model/provider metadata (`has_model_resume_override`), which is required to
 * continue a thread on a DIFFERENT provider channel than the one it was
 * created under. Spread-omit each absent field — older binaries reject
 * unknown/null fields.
 */
export interface CodexThreadConfigOverrides {
  model?: string
  modelProvider?: string
  /**
   * Per-thread context pin forwarded on resume/fork (same thread-scoped keys
   * as `ThreadStartParams.config`; smoke-verified on the bundled binary).
   * Spread-omit when the thread is unpinned.
   */
  config?: {
    model_context_window: number
    model_auto_compact_token_limit: number
  }
}

/**
 * App-server v2 `TextElement`: a UI-defined span within the parent `text`
 * buffer. `byteRange` is in UTF-8 BYTES (the server is Rust — indexing by JS
 * UTF-16 code units corrupts spans after any non-ASCII character), and
 * `placeholder` is the optional human-readable label the UI renders for it.
 */
export interface CodexTextElement {
  byteRange: { start: number; end: number }
  placeholder: string | null
}

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: CodexTextElement[] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  /**
   * Skill invocation: codex app-server reads `name` + `path` and injects the
   * full SKILL.md instructions for the model. Per README:
   *   "If you omit the `skill` item, the model will still parse the `$ `
   *   marker and try to locate the skill, which can add latency."
   */
  | { type: 'skill'; name: string; path: string }
  /**
   * Plugin / app invocation: `path` is `plugin://<name>@<marketplace>` (from
   * `plugin/installed` / `plugin/list`) or `app://<connector-id>`. Per README,
   * pairing the mention item with the `@token` in the text makes the server
   * "use the exact path rather than guessing by name".
   */
  | { type: 'mention'; name: string; path: string }

/**
 * EXPERIMENTAL collaboration-mode preset (`turn/start.collaborationMode`,
 * gated behind `capabilities.experimentalApi`). Wire shapes pinned from
 * codex-rs `protocol/src/config_types.rs` (`CollaborationMode` / `Settings` —
 * snake_case fields) and `app-server-protocol/src/protocol/v2/
 * collaboration_mode.rs` (`CollaborationModeMask` — camelCase except the
 * explicitly renamed `reasoning_effort`).
 *
 * `settings.developer_instructions: null` means "use the built-in
 * instructions for the selected mode" — exactly what we want for Plan mode.
 */
// 0.145.0's serde enum accepts `plan | code | custom | default | execute |
// pair_programming` (verified by the bogus-variant probe in
// scripts/smoke-collaboration-mode.ts), but `collaborationMode/list` still
// only advertises the Plan/Default presets and we only ever SEND these two —
// keep the union narrow so a typo can't smuggle an unreviewed mode onto the
// wire.
export type CodexCollaborationModeKind = 'plan' | 'default'

export interface CodexCollaborationMode {
  mode: CodexCollaborationModeKind
  settings: {
    model: string
    reasoning_effort: string | null
    developer_instructions: string | null
  }
}

export interface ThreadSettingsUpdateParams {
  threadId: string
  collaborationMode?: CodexCollaborationMode | null
}

export type ThreadSettingsUpdateResponse = Record<string, never>

export interface CodexThreadSettings {
  cwd: string
  approvalPolicy: string
  approvalsReviewer: string
  sandboxPolicy: Record<string, unknown>
  activePermissionProfile: Record<string, unknown> | null
  model: string
  modelProvider: string
  serviceTier: string | null
  effort: string | null
  summary: string | null
  collaborationMode: CodexCollaborationMode
  personality: string | null
}

export interface ThreadSettingsUpdatedNotification {
  threadId: string
  threadSettings: CodexThreadSettings
}

/** One preset row from `collaborationMode/list` (all-optional mask). */
export interface CodexCollaborationModeMask {
  name: string
  mode: CodexCollaborationModeKind | null
  model: string | null
  reasoning_effort?: string | null
}

export interface CollaborationModeListResponse { data: CodexCollaborationModeMask[] }

/** Stable app-server v2 `model/list` catalog row (Codex 0.144.1 schema). */
export interface CodexModelServiceTier {
  id: string
  name: string
  description: string
}

export interface CodexModel {
  id: string
  model: string
  displayName: string
  description: string
  hidden: boolean
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>
  defaultReasoningEffort: string
  inputModalities: string[]
  supportsPersonality: boolean
  isDefault: boolean
  upgrade: string | null
  additionalSpeedTiers: string[]
  defaultServiceTier: string | null
  serviceTiers: CodexModelServiceTier[]
}

export interface CodexModelListParams {
  cursor?: string | null
  limit?: number | null
  includeHidden?: boolean | null
}

export interface CodexModelListResponse {
  data: CodexModel[]
  nextCursor: string | null
}

export interface TurnStartParams {
  threadId: string
  input: CodexUserInput[]
  model?: string
  effort?: string
  clientUserMessageId?: string
  collaborationMode?: CodexCollaborationMode
}
export interface TurnStartResponse { turn: Turn }

// `turn/steer` (openai/codex#10821): append user input to the in-flight turn
// without starting a new one. `expectedTurnId` must match the active turn.
export interface TurnSteerParams { threadId: string; input: CodexUserInput[]; expectedTurnId: string }
export interface TurnSteerResponse { turnId: string }

export interface TurnInterruptParams { threadId: string; turnId: string }

export interface AgentMessageDelta { threadId: string; turnId: string; itemId: string; delta: string }
export interface ReasoningTextDelta { threadId: string; turnId: string; itemId: string; delta: string }
export interface TurnStartedNotification { threadId: string; turn: Turn }
export interface TurnCompletedNotification { threadId: string; turn: Turn }
export interface ErrorNotification { error: { message?: string }; willRetry: boolean; threadId: string; turnId: string }
