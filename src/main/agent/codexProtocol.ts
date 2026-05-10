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
export interface InitializeParams { clientInfo: ClientInfo; capabilities: null }
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
  }
}
export interface ThreadStartResponse { thread: Thread }

export type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  /**
   * Skill invocation: codex app-server reads `name` + `path` and injects the
   * full SKILL.md instructions for the model. Per README:
   *   "If you omit the `skill` item, the model will still parse the `$ `
   *   marker and try to locate the skill, which can add latency."
   */
  | { type: 'skill'; name: string; path: string }

export interface TurnStartParams { threadId: string; input: CodexUserInput[] }
export interface TurnStartResponse { turn: Turn }

export interface TurnInterruptParams { threadId: string; turnId: string }

export interface AgentMessageDelta { threadId: string; turnId: string; itemId: string; delta: string }
export interface ReasoningTextDelta { threadId: string; turnId: string; itemId: string; delta: string }
export interface TurnStartedNotification { threadId: string; turn: Turn }
export interface TurnCompletedNotification { threadId: string; turn: Turn }
export interface ErrorNotification { error: { message?: string }; willRetry: boolean; threadId: string; turnId: string }
