import type {
  AgentSendMessagePayload,
  AgentStreamEvent,
  CodexApprovalResponse,
  CodexSessionConfig,
  CodexThreadDetail,
  CodexThreadSummary,
} from '../../types/agent'

export interface AgentInput extends AgentSendMessagePayload {
  model: string
  cwd: string
  items: Array<
    | { type: 'text'; text: string }
    | { type: 'localImage'; path: string }
    | { type: 'image'; url: string }
  >
}

export interface IAgentBackend {
  start(): Promise<void>
  stop(): Promise<void>
  send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent>
  cancel(threadId: string): Promise<void>
  isHealthy(): boolean
  setSessionConfig?(patch: Partial<CodexSessionConfig>): void
  respondToApprovalResponse?(response: CodexApprovalResponse): Promise<void> | void
  listThreads?(): Promise<CodexThreadSummary[]>
  readThread?(threadId: string): Promise<CodexThreadDetail>
  forkThread?(threadId: string): Promise<CodexThreadSummary>
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}
