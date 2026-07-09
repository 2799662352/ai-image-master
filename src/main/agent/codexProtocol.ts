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
  }
}
export interface ThreadStartResponse { thread: Thread }

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
export type CodexCollaborationModeKind = 'plan' | 'default'

export interface CodexCollaborationMode {
  mode: CodexCollaborationModeKind
  settings: {
    model: string
    reasoning_effort: string | null
    developer_instructions: string | null
  }
}

/** One preset row from `collaborationMode/list` (all-optional mask). */
export interface CodexCollaborationModeMask {
  name: string
  mode: CodexCollaborationModeKind | null
  model: string | null
  reasoning_effort?: string | null
}

export interface CollaborationModeListResponse { data: CodexCollaborationModeMask[] }

export interface TurnStartParams {
  threadId: string
  input: CodexUserInput[]
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
