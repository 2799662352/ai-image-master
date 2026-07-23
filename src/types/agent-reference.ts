// Phase 1 schema is intentionally minimal. Phase 2 can add selection/github
// sources and execution policy fields when real consumers exist.
export type AgentReferenceType =
  | 'file'
  | 'url'
  | 'command'
  | 'mcp'
  | 'image'
  | 'video'
  | 'audio'
  | 'artifact'
  | 'activity'

export type AgentReferenceStatus =
  | 'ready'
  | 'running'
  | 'success'
  | 'error'
  | 'stale'

export type AgentReferenceOpenBehavior =
  | 'code'
  | 'markdown'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'url'
  | 'shellOutput'
  | 'diff'
  | 'jsonResource'

export type AgentReferenceSource =
  | { kind: 'localPath'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'codexItem'; itemId: string }

export interface AgentReferencePreview {
  mime?: string
  summary?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  command?: string
  cwd?: string
  json?: unknown
  thumbnailUri?: string
}

export interface AgentReference {
  id: string
  type: AgentReferenceType
  label: string
  source: AgentReferenceSource
  status: AgentReferenceStatus
  openBehavior: AgentReferenceOpenBehavior
  preview?: AgentReferencePreview
}
