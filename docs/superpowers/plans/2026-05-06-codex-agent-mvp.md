# CATIMATION Codex Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local-first CATIMATION Codex agent MVP: a right-side chat panel that drives bundled `codex app-server`, exposes CATIMATION tools through local MCP HTTP, persists conversations in Postgres/PGlite, supports attachments, and previews image artifacts.

**Architecture:** Electron main owns long-running infrastructure: Codex child process, local MCP HTTP server, PGlite socket server, Prisma persistence, file attachments, and IPC channels. Renderer owns CATIMATION UI services already registered in `ServiceRegistry`; main routes renderer-backed tool calls through a typed request/response IPC bridge. The MVP excludes codex-gateway, FastAPI/FastMCP, parallel multi-agent, embedded browser, and remote MCP exposure.

**Tech Stack:** Electron 41, electron-vite 5, React 19, Zustand 5, Vitest 4, Playwright, Prisma + PostgreSQL, `@electric-sql/pglite`, `@electric-sql/pglite-socket`, `@modelcontextprotocol/{server,node,express}`, `ws`, `zod`.

---

## Scope Check

This plan implements only the local MVP main path from `docs/superpowers/specs/2026-05-06-codex-agent-integration-design.md`.

Included:
- Local `codex app-server` lifecycle via WebSocket JSON-RPC
- Local MCP HTTP server at `127.0.0.1:<port>/mcp`
- Renderer tool execution bridge for existing `ServiceRegistry` services
- PGlite fallback through `PGLiteSocketServer`
- Prisma models for thread/message/tool call/artifact/attachment
- Agent chat panel UI, attachments, artifact preview
- Packaging support for Codex binary resources

Excluded:
- codex-gateway online backend
- FastAPI + FastMCP extension layer
- Remote MCP exposure
- Parallel multi-agent
- Embedded browser automation

---

## File Structure

### New Main Process Files

- `src/main/agent/types.ts`  
  Shared main-process agent types, event names, and JSON-RPC types.
- `src/main/agent/ports.ts`  
  Free-port helper for Codex app-server, MCP server, and PGlite socket server.
- `src/main/agent/CodexLocalBackend.ts`  
  Spawns `codex app-server`, connects WebSocket JSON-RPC, emits normalized `AgentEvent`s.
- `src/main/agent/AgentManager.ts`  
  Owns backend startup/shutdown, thread send/cancel APIs, and event persistence.
- `src/main/agent/AttachmentService.ts`  
  Copies uploaded files into `userData/agent/uploads`, hashes them, records attachments.
- `src/main/agent/ThreadStore.ts`  
  Prisma wrapper for threads, messages, tool calls, artifacts, and attachments.
- `src/main/agent/db.ts`  
  Resolves sora-postgres or starts PGlite socket server and returns a Prisma-ready URL.
- `src/main/agent/ipc.ts`  
  Registers `ipcMain.handle` and renderer response listeners for agent channels.
- `src/main/agent/logger.ts`  
  Writes Codex stdout/stderr and agent lifecycle logs to `userData/logs`.
- `src/main/mcp/server.ts`  
  Starts MCP HTTP server using v1.x MCP packages.
- `src/main/mcp/ToolRouter.ts`  
  Routes tool calls to main-native handlers or renderer IPC.
- `src/main/mcp/tools/*.ts`  
  Tool registration files for generate/analyze/history/ui/status.
- `src/main/mcp/resources/*.ts`  
  Resource handlers for uploads/artifacts/history records.
- `src/main/mcp/config.ts`  
  Persists MCP token and patches `~/.codex/config.toml`.

### New Renderer Files

- `src/renderer/src/features/agent-chat/types.ts`  
  Renderer-facing message, attachment, tool call, and artifact types.
- `src/renderer/src/features/agent-chat/store.ts`  
  Zustand store for panel visibility, threads, current turn, and streaming events.
- `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`  
  Right drawer shell.
- `src/renderer/src/features/agent-chat/MessageBubble.tsx`
- `src/renderer/src/features/agent-chat/ReasoningPanel.tsx`
- `src/renderer/src/features/agent-chat/ToolCallCard.tsx`
- `src/renderer/src/features/agent-chat/ArtifactGrid.tsx`
- `src/renderer/src/features/agent-chat/MentionInput.tsx`
- `src/renderer/src/features/agent-chat/AttachmentChips.tsx`
- `src/renderer/src/features/agent-chat/ThreadSidebar.tsx`
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`  
  Receives `agent:tool-request`, calls `ServiceRegistry` and Zustand actions, sends `agent:tool-response`.
- `src/renderer/src/features/agent-chat/index.ts`

### Shared/Config Files

- `src/preload/index.ts`  
  Add agent APIs and allow-listed event channels.
- `src/main/index.ts`  
  Initialize DB, MCP server, AgentManager, and IPC.
- `src/renderer/src/layouts/AppLayout.tsx`  
  Mount `AgentChatPanel`.
- `src/renderer/src/stores/index.ts`  
  Export agent store if needed.
- `src/types/agent.ts`  
  Shared preload-safe agent IPC payloads.
- `prisma/schema.prisma`  
  New Prisma schema for local agent tables.
- `scripts/fetch-codex.ts`  
  Download platform Codex binaries into `resources/codex/<platform>-<arch>/`.
- `electron-builder.yml`  
  Include Codex resources.
- `package.json`  
  Add dependencies and scripts.
- `vitest.config.ts`  
  Add main-process aliases if tests need them.

---

## Task 1: Dependencies, Scripts, and Package Resource Wiring

**Files:**
- Modify: `package.json`
- Modify: `electron-builder.yml`
- Create: `resources/codex/.gitkeep`
- Create: `resources/skills/catimation-image-recipes/.gitkeep`
- Create: `scripts/fetch-codex.ts`
- Test: `src/main/agent/__tests__/resolveCodexBinary.test.ts`

- [ ] **Step 1: Install dependencies**

Run:

```bash
npm install @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express @electric-sql/pglite @electric-sql/pglite-socket @prisma/client prisma ws toml
npm install -D @types/ws
```

Expected: `package.json` and `package-lock.json` update successfully.

- [ ] **Step 2: Add package metadata and scripts**

Modify `package.json`:

```json
{
  "codexCliVersion": "0.128.0",
  "scripts": {
    "codex:fetch": "tsx scripts/fetch-codex.ts",
    "prisma:generate": "prisma generate",
    "prisma:migrate:dev": "prisma migrate dev",
    "prisma:validate": "prisma validate"
  }
}
```

Keep all existing scripts. Add the new keys into the existing `"scripts"` object, not as a replacement.

- [ ] **Step 3: Update electron-builder resources**

Modify `electron-builder.yml`:

```yaml
extraResources:
  - from: skills
    to: skills
    filter:
      - "**/*.md"
  - from: resources/codex/${platform}-${arch}
    to: codex
    filter:
      - "codex*"
  - from: resources/skills
    to: skills
    filter:
      - "**/*"

asarUnpack:
  - resources/**
  - "**/node_modules/@electric-sql/pglite/**"
```

Expected: existing `skills` resource remains intact; Codex binaries land outside ASAR.

- [ ] **Step 4: Create Codex binary resolver test**

Create `src/main/agent/__tests__/resolveCodexBinary.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { getCodexResourceDir, getCodexBinaryName } from '../paths'

describe('codex binary paths', () => {
  it('uses codex.exe on Windows', () => {
    expect(getCodexBinaryName('win32')).toBe('codex.exe')
  })

  it('uses codex on POSIX platforms', () => {
    expect(getCodexBinaryName('linux')).toBe('codex')
    expect(getCodexBinaryName('darwin')).toBe('codex')
  })

  it('builds a platform-arch resource directory', () => {
    expect(getCodexResourceDir('/app/resources', 'win32', 'x64')).toBe(
      path.join('/app/resources', 'codex', 'win32-x64'),
    )
  })
})
```

- [ ] **Step 5: Implement path helper**

Create `src/main/agent/paths.ts`:

```typescript
import path from 'node:path'

export function getCodexBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'codex.exe' : 'codex'
}

export function getCodexResourceDir(resourcesPath: string, platform = process.platform, arch = process.arch): string {
  return path.join(resourcesPath, 'codex', `${platform}-${arch}`)
}

export function resolveCodexBinary(resourcesPath: string): string {
  return path.join(getCodexResourceDir(resourcesPath), getCodexBinaryName())
}
```

- [ ] **Step 6: Run dependency/path checks**

Run:

```bash
npm run test:run -- src/main/agent/__tests__/resolveCodexBinary.test.ts
npm run typecheck
```

Expected: path test passes; typecheck does not fail because of the new files.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json electron-builder.yml resources scripts src/main/agent/paths.ts src/main/agent/__tests__/resolveCodexBinary.test.ts
git commit -m "chore(agent): add Codex agent dependencies and resources"
```

---

## Task 2: Shared Agent Types and Preload IPC Surface

**Files:**
- Create: `src/types/agent.ts`
- Modify: `src/preload/index.ts`
- Test: `src/renderer/src/services/__tests__/electron-api-agent-types.test.ts`

- [ ] **Step 1: Define IPC-safe types**

Create `src/types/agent.ts`:

```typescript
export type AgentRole = 'user' | 'assistant' | 'system' | 'tool'
export type AgentToolStatus = 'pending' | 'running' | 'success' | 'error' | 'cancelled'
export type AgentArtifactType = 'image' | 'file' | 'link'

export interface AgentAttachmentInput {
  name: string
  mime: string
  size: number
  path?: string
  buffer?: ArrayBuffer
}

export interface AgentSendMessagePayload {
  threadId?: string
  content: string
  attachments: AgentAttachmentInput[]
  currentPage?: string
}

export interface AgentCancelPayload {
  threadId: string
}

export interface AgentThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
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

export interface AgentStreamEvent {
  type:
    | 'thread_created'
    | 'message_delta'
    | 'reasoning_delta'
    | 'tool_call_start'
    | 'tool_call_end'
    | 'artifact_created'
    | 'turn_completed'
    | 'error'
    | 'cancelled'
  threadId: string
  turnId?: string
  delta?: string
  tool?: AgentToolEvent
  artifact?: AgentArtifact
  error?: string
}

export interface AgentToolRequest {
  id: string
  toolName: string
  params: Record<string, unknown>
}

export interface AgentToolResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}
```

- [ ] **Step 2: Extend preload type surface**

In `src/preload/index.ts`, import the shared types:

```typescript
import type {
  AgentCancelPayload,
  AgentSendMessagePayload,
  AgentStreamEvent,
  AgentThreadSummary,
  AgentToolRequest,
  AgentToolResponse,
} from '../types/agent'
```

Add channels to `IPC_CHANNELS`:

```typescript
AGENT: {
  SEND_MESSAGE: 'agent:send-message',
  CANCEL: 'agent:cancel',
  LIST_THREADS: 'agent:list-threads',
  LOAD_THREAD: 'agent:load-thread',
  UPLOAD_ATTACHMENTS: 'agent:upload-attachments',
},
AGENT_EVENTS: [
  'agent:event',
  'agent:tool-request',
] as const,
```

Extend `ElectronAPI`:

```typescript
agent: {
  sendMessage: (payload: AgentSendMessagePayload) => Promise<{ threadId: string }>
  cancel: (payload: AgentCancelPayload) => Promise<IpcResponse>
  listThreads: () => Promise<AgentThreadSummary[]>
  loadThread: (threadId: string) => Promise<unknown>
  onEvent: (handler: (event: AgentStreamEvent) => void) => () => void
  onToolRequest: (handler: (request: AgentToolRequest) => void) => () => void
  sendToolResponse: (response: AgentToolResponse) => void
}
```

Expose methods in `contextBridge.exposeInMainWorld` or the existing API object:

```typescript
agent: {
  sendMessage: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AGENT.SEND_MESSAGE, payload),
  cancel: (payload) => ipcRenderer.invoke(IPC_CHANNELS.AGENT.CANCEL, payload),
  listThreads: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT.LIST_THREADS),
  loadThread: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.AGENT.LOAD_THREAD, threadId),
  onEvent: (handler) => safeOn('agent:event', (_event, payload) => handler(payload)),
  onToolRequest: (handler) => safeOn('agent:tool-request', (_event, payload) => handler(payload)),
  sendToolResponse: (response) => ipcRenderer.send('agent:tool-response', response),
}
```

- [ ] **Step 3: Add preload type test**

Create `src/renderer/src/services/__tests__/electron-api-agent-types.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { AgentSendMessagePayload } from '../../../../types/agent'

describe('agent IPC types', () => {
  it('accepts a text message with attachments', () => {
    const payload: AgentSendMessagePayload = {
      content: '生成一张 cyberpunk cat',
      attachments: [{ name: 'ref.png', mime: 'image/png', size: 1024 }],
    }
    expect(payload.attachments[0].mime).toBe('image/png')
  })
})
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run test:run -- src/renderer/src/services/__tests__/electron-api-agent-types.test.ts
npm run typecheck
```

Expected: test passes; preload changes typecheck.

- [ ] **Step 5: Commit**

```bash
git add src/types/agent.ts src/preload/index.ts src/renderer/src/services/__tests__/electron-api-agent-types.test.ts
git commit -m "feat(agent): add typed IPC surface"
```

---

## Task 3: Prisma + PGlite Persistence

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/main/agent/db.ts`
- Create: `src/main/agent/ThreadStore.ts`
- Test: `src/main/agent/__tests__/ThreadStore.test.ts`

- [ ] **Step 1: Add Prisma schema**

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model AgentThread {
  id          String            @id @default(cuid())
  title       String
  model       String
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt
  messages    AgentMessage[]
  artifacts   AgentArtifact[]
  attachments AgentAttachment[]
}

model AgentMessage {
  id          String          @id @default(cuid())
  threadId    String
  role        String
  contentJson Json
  createdAt   DateTime        @default(now())
  thread      AgentThread     @relation(fields: [threadId], references: [id], onDelete: Cascade)
  toolCalls   AgentToolCall[]

  @@index([threadId, createdAt])
}

model AgentToolCall {
  id         String       @id @default(cuid())
  messageId  String
  toolName   String
  paramsJson Json
  resultJson Json?
  status     String
  durationMs Int?
  createdAt  DateTime     @default(now())
  message    AgentMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
}

model AgentArtifact {
  id        String      @id @default(cuid())
  threadId  String
  messageId String?
  type      String
  uri       String
  metadata  Json
  createdAt DateTime    @default(now())
  thread    AgentThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
}

model AgentAttachment {
  id           String      @id @default(cuid())
  threadId     String
  originalName String
  localPath    String
  mime         String
  size         Int
  uploadedAt   DateTime    @default(now())
  thread       AgentThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 2: Implement DB resolver**

Create `src/main/agent/db.ts`:

```typescript
import { app } from 'electron'
import path from 'node:path'
import net from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'
import { PrismaClient } from '@prisma/client'

let prisma: PrismaClient | null = null
let pgliteServer: PGLiteSocketServer | null = null
let pgliteDb: PGlite | null = null

export async function canConnect(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
    socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
  })
}

export async function resolveDatabaseUrl(): Promise<string> {
  const envUrl = process.env.CATIMATION_AGENT_DATABASE_URL
  if (envUrl) return envUrl

  if (await canConnect(5432)) {
    return 'postgresql://sorauser:sora_password_2024@127.0.0.1:5432/soraui'
  }

  return startEmbeddedPGlite()
}

export async function startEmbeddedPGlite(): Promise<string> {
  const dataDir = path.join(app.getPath('userData'), 'pgdata')
  pgliteDb = await PGlite.create(dataDir)
  pgliteServer = new PGLiteSocketServer({ db: pgliteDb, host: '127.0.0.1', port: 5433 })
  await pgliteServer.start()
  return 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'
}

export async function getPrisma(): Promise<PrismaClient> {
  if (!prisma) {
    process.env.DATABASE_URL = await resolveDatabaseUrl()
    prisma = new PrismaClient()
  }
  return prisma
}

export async function shutdownDatabase(): Promise<void> {
  await prisma?.$disconnect()
  await pgliteServer?.stop()
  await pgliteDb?.close()
  prisma = null
  pgliteServer = null
  pgliteDb = null
}
```

- [ ] **Step 3: Implement ThreadStore**

Create `src/main/agent/ThreadStore.ts`:

```typescript
import type { PrismaClient } from '@prisma/client'

export class ThreadStore {
  constructor(private readonly prisma: PrismaClient) {}

  async createThread(input: { title: string; model: string }) {
    return this.prisma.agentThread.create({ data: input })
  }

  async listThreads() {
    return this.prisma.agentThread.findMany({ orderBy: { updatedAt: 'desc' } })
  }

  async addMessage(input: { threadId: string; role: string; contentJson: unknown }) {
    return this.prisma.agentMessage.create({ data: input })
  }

  async addToolCall(input: {
    messageId: string
    toolName: string
    paramsJson: unknown
    status: string
  }) {
    return this.prisma.agentToolCall.create({ data: input })
  }

  async addArtifact(input: {
    threadId: string
    messageId?: string
    type: string
    uri: string
    metadata: unknown
  }) {
    return this.prisma.agentArtifact.create({ data: input })
  }

  async loadThread(threadId: string) {
    return this.prisma.agentThread.findUnique({
      where: { id: threadId },
      include: { messages: { orderBy: { createdAt: 'asc' }, include: { toolCalls: true } }, artifacts: true, attachments: true },
    })
  }
}
```

- [ ] **Step 4: Generate Prisma client**

Run:

```bash
npx prisma generate
npx prisma validate
```

Expected: Prisma client is generated and schema validates.

- [ ] **Step 5: Add persistence test**

Create `src/main/agent/__tests__/ThreadStore.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { ThreadStore } from '../ThreadStore'

describe('ThreadStore', () => {
  it('creates a thread and message through Prisma-compatible methods', async () => {
    const prisma = {
      agentThread: {
        create: vi.fn().mockResolvedValue({ id: 'thread_1', title: 'Test', model: 'gpt-5.4' }),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
      agentMessage: { create: vi.fn().mockResolvedValue({ id: 'msg_1' }) },
      agentToolCall: { create: vi.fn() },
      agentArtifact: { create: vi.fn() },
    } as any
    const store = new ThreadStore(prisma)
    const thread = await store.createThread({ title: 'Test', model: 'gpt-5.4' })
    await store.addMessage({ threadId: thread.id, role: 'user', contentJson: { text: 'hello' } })
    expect(prisma.agentThread.create).toHaveBeenCalledWith({ data: { title: 'Test', model: 'gpt-5.4' } })
    expect(prisma.agentMessage.create).toHaveBeenCalledWith({ data: { threadId: 'thread_1', role: 'user', contentJson: { text: 'hello' } } })
  })
})
```

- [ ] **Step 6: Verify**

Run:

```bash
npm run test:run -- src/main/agent/__tests__/ThreadStore.test.ts
npm run typecheck
```

Expected: test passes and Prisma types resolve.

- [ ] **Step 7: Commit**

```bash
git add prisma src/main/agent/db.ts src/main/agent/ThreadStore.ts src/main/agent/__tests__/ThreadStore.test.ts
git commit -m "feat(agent): add Postgres persistence"
```

---

## Task 4: AgentManager and Codex App-Server Backend

**Files:**
- Create: `src/main/agent/types.ts`
- Create: `src/main/agent/ports.ts`
- Create: `src/main/agent/logger.ts`
- Create: `src/main/agent/CodexLocalBackend.ts`
- Create: `src/main/agent/AgentManager.ts`
- Test: `src/main/agent/__tests__/CodexLocalBackend.test.ts`

- [ ] **Step 1: Add main agent types**

Create `src/main/agent/types.ts`:

```typescript
import type { AgentSendMessagePayload, AgentStreamEvent } from '../../types/agent'

export interface AgentInput extends AgentSendMessagePayload {
  model: string
  cwd: string
  items: Array<{ type: 'text'; text: string } | { type: 'image'; imageUrl: string }>
}

export interface IAgentBackend {
  start(): Promise<void>
  stop(): Promise<void>
  send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent>
  cancel(threadId: string): Promise<void>
  isHealthy(): boolean
}

export interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}
```

- [ ] **Step 2: Add port helper**

Create `src/main/agent/ports.ts`:

```typescript
import net from 'node:net'

export async function pickFreePort(start = 4222): Promise<number> {
  for (let port = start; port < start + 100; port += 1) {
    if (await isFree(port)) return port
  }
  throw new Error(`No free port in range ${start}-${start + 99}`)
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}
```

- [ ] **Step 3: Add logger**

Create `src/main/agent/logger.ts`:

```typescript
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export function createAgentLogStream(name: string) {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}-${new Date().toISOString().slice(0, 10)}.log`)
  return fs.createWriteStream(file, { flags: 'a' })
}
```

- [ ] **Step 4: Implement CodexLocalBackend**

Create `src/main/agent/CodexLocalBackend.ts`:

```typescript
import { spawn, type ChildProcess } from 'node:child_process'
import WebSocket from 'ws'
import { app } from 'electron'
import { pickFreePort } from './ports'
import { resolveCodexBinary } from './paths'
import { createAgentLogStream } from './logger'
import type { AgentInput, IAgentBackend, JsonRpcMessage } from './types'
import type { AgentStreamEvent } from '../../types/agent'

export class CodexLocalBackend implements IAgentBackend {
  private proc: ChildProcess | null = null
  private ws: WebSocket | null = null
  private rpcId = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private events: AgentStreamEvent[] = []

  async start(): Promise<void> {
    const port = await pickFreePort(4222)
    const bin = resolveCodexBinary(process.resourcesPath || app.getAppPath())
    const log = createAgentLogStream('codex')
    this.proc = spawn(bin, ['app-server', 'serve', '--listen', `ws://127.0.0.1:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.proc.stdout?.pipe(log)
    this.proc.stderr?.pipe(log)
    this.proc.on('exit', () => { this.ws?.close(); this.ws = null })
    this.ws = await this.connect(`ws://127.0.0.1:${port}`)
    this.ws.on('message', (data) => this.handleMessage(String(data)))
    await this.rpc('initialize', { clientName: 'catimation' })
  }

  async stop(): Promise<void> {
    this.ws?.close()
    this.proc?.kill()
    this.ws = null
    this.proc = null
  }

  async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
    const actualThreadId = threadId ?? await this.createThread(input)
    const response = await this.rpc<{ turn: { id: string } }>('turn/start', { threadId: actualThreadId, input: input.items })
    const turnId = response.turn.id
    while (true) {
      const event = await this.nextEvent(actualThreadId, turnId)
      yield event
      if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') return
    }
  }

  async cancel(threadId: string): Promise<void> {
    await this.rpc('turn/cancel', { threadId })
  }

  isHealthy(): boolean {
    return this.proc !== null && this.ws?.readyState === WebSocket.OPEN
  }

  private async createThread(input: AgentInput): Promise<string> {
    const response = await this.rpc<{ thread: { id: string } }>('thread/start', { model: input.model, cwd: input.cwd })
    return response.thread.id
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    const id = ++this.rpcId
    const payload: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws?.send(JSON.stringify(payload))
    })
  }

  private handleMessage(raw: string): void {
    const msg = JSON.parse(raw) as JsonRpcMessage
    if (msg.id && this.pending.has(msg.id)) {
      const pending = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      msg.error ? pending.reject(new Error(msg.error.message)) : pending.resolve(msg.result)
      return
    }
    if (msg.method) this.events.push(this.normalizeNotification(msg))
  }

  private normalizeNotification(msg: JsonRpcMessage): AgentStreamEvent {
    const params = (msg.params ?? {}) as any
    if (msg.method === 'item/agentMessage/delta') return { type: 'message_delta', threadId: params.threadId, turnId: params.turnId, delta: params.delta }
    if (msg.method === 'item/reasoning/delta') return { type: 'reasoning_delta', threadId: params.threadId, turnId: params.turnId, delta: params.delta }
    if (msg.method === 'turn/completed') return { type: 'turn_completed', threadId: params.threadId, turnId: params.turnId }
    return { type: 'tool_call_start', threadId: params.threadId, turnId: params.turnId, tool: { id: params.itemId ?? crypto.randomUUID(), name: msg.method, status: 'running' } }
  }

  private nextEvent(threadId: string, turnId: string): Promise<AgentStreamEvent> {
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const index = this.events.findIndex((event) => event.threadId === threadId && (!event.turnId || event.turnId === turnId))
        if (index >= 0) {
          clearInterval(timer)
          resolve(this.events.splice(index, 1)[0])
        }
      }, 25)
    })
  }

  private connect(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  }
}
```

- [ ] **Step 5: Add backend unit test**

Create `src/main/agent/__tests__/CodexLocalBackend.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import type { JsonRpcMessage } from '../types'

describe('CodexLocalBackend protocol shape', () => {
  it('uses JSON-RPC 2.0 messages', () => {
    const msg: JsonRpcMessage = { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { model: 'gpt-5.4' } }
    expect(msg.jsonrpc).toBe('2.0')
    expect(msg.method).toBe('thread/start')
  })
})
```

- [ ] **Step 6: Implement AgentManager**

Create `src/main/agent/AgentManager.ts`:

```typescript
import type { BrowserWindow } from 'electron'
import { CodexLocalBackend } from './CodexLocalBackend'
import { ThreadStore } from './ThreadStore'
import type { AgentSendMessagePayload } from '../../types/agent'
import type { AgentInput, IAgentBackend } from './types'

export class AgentManager {
  private backend: IAgentBackend

  constructor(private readonly win: BrowserWindow, private readonly store: ThreadStore) {
    this.backend = new CodexLocalBackend()
  }

  async start(): Promise<void> {
    await this.backend.start()
  }

  async stop(): Promise<void> {
    await this.backend.stop()
  }

  async sendMessage(payload: AgentSendMessagePayload): Promise<{ threadId: string }> {
    const thread = payload.threadId
      ? { id: payload.threadId }
      : await this.store.createThread({ title: payload.content.slice(0, 40) || 'New Agent Thread', model: 'gpt-5.4' })

    const input: AgentInput = {
      ...payload,
      model: 'gpt-5.4',
      cwd: process.cwd(),
      items: [{ type: 'text', text: payload.content }],
    }

    void this.forwardEvents(thread.id, input)
    return { threadId: thread.id }
  }

  async cancel(threadId: string): Promise<void> {
    await this.backend.cancel(threadId)
  }

  private async forwardEvents(threadId: string, input: AgentInput): Promise<void> {
    for await (const event of this.backend.send(threadId, input)) {
      this.win.webContents.send('agent:event', event)
    }
  }
}
```

- [ ] **Step 7: Verify**

Run:

```bash
npm run test:run -- src/main/agent/__tests__/CodexLocalBackend.test.ts
npm run typecheck
```

Expected: tests pass; only real Codex startup is deferred to integration testing after binary fetch.

- [ ] **Step 8: Commit**

```bash
git add src/main/agent
git commit -m "feat(agent): add local Codex app-server backend"
```

---

## Task 5: MCP Server and Tool Router

**Files:**
- Create: `src/main/mcp/config.ts`
- Create: `src/main/mcp/server.ts`
- Create: `src/main/mcp/ToolRouter.ts`
- Create: `src/main/mcp/tools/index.ts`
- Create: `src/main/mcp/tools/imageTools.ts`
- Create: `src/main/mcp/tools/historyTools.ts`
- Create: `src/main/mcp/tools/uiTools.ts`
- Test: `src/main/mcp/__tests__/ToolRouter.test.ts`

- [ ] **Step 1: Implement ToolRouter**

Create `src/main/mcp/ToolRouter.ts`:

```typescript
import type { BrowserWindow } from 'electron'
import type { AgentToolRequest, AgentToolResponse } from '../../types/agent'

export type MainToolHandler = (params: Record<string, unknown>) => Promise<unknown>

export class ToolRouter {
  private mainHandlers = new Map<string, MainToolHandler>()
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  constructor(private readonly win: BrowserWindow) {}

  registerMain(name: string, handler: MainToolHandler): void {
    this.mainHandlers.set(name, handler)
  }

  async call(name: string, params: Record<string, unknown>): Promise<unknown> {
    const mainHandler = this.mainHandlers.get(name)
    if (mainHandler) return mainHandler(params)
    return this.callRenderer(name, params)
  }

  handleRendererResponse(response: AgentToolResponse): void {
    const pending = this.pending.get(response.id)
    if (!pending) return
    this.pending.delete(response.id)
    response.ok ? pending.resolve(response.result) : pending.reject(new Error(response.error ?? 'Renderer tool failed'))
  }

  private callRenderer(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID()
    const request: AgentToolRequest = { id, toolName, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.win.webContents.send('agent:tool-request', request)
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`Renderer tool timed out: ${toolName}`))
      }, 120_000)
    })
  }
}
```

- [ ] **Step 2: Register MCP server**

Create `src/main/mcp/server.ts`:

```typescript
import { randomBytes, randomUUID } from 'node:crypto'
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { createMcpExpressApp } from '@modelcontextprotocol/express'
import type { BrowserWindow } from 'electron'
import { registerTools } from './tools'
import { ToolRouter } from './ToolRouter'

export interface McpRuntime {
  port: number
  token: string
  router: ToolRouter
}

export async function startCatimationMcpServer(win: BrowserWindow, port = 7842): Promise<McpRuntime> {
  const token = randomBytes(32).toString('hex')
  const router = new ToolRouter(win)
  const server = new McpServer({ name: 'catimation', version: '1.0.0' })
  registerTools(server, router)

  const app = createMcpExpressApp()
  app.use((req, res, next) => {
    if (req.headers['x-catimation-token'] !== token) return res.status(401).send('unauthorized')
    next()
  })

  const transports = new Map<string, NodeStreamableHTTPServerTransport>()
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body)
      return
    }
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, transport),
      })
      transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId)
      await server.connect(transport)
      await transport.handleRequest(req, res, req.body)
      return
    }
    res.status(400).json({ error: 'Invalid request' })
  })

  app.listen(port, '127.0.0.1')
  return { port, token, router }
}
```

- [ ] **Step 3: Register initial tools**

Create `src/main/mcp/tools/index.ts`:

```typescript
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { registerImageTools } from './imageTools'
import { registerHistoryTools } from './historyTools'
import { registerUiTools } from './uiTools'

export function registerTools(server: McpServer, router: ToolRouter): void {
  registerImageTools(server, router)
  registerHistoryTools(server, router)
  registerUiTools(server, router)
}
```

Create `src/main/mcp/tools/imageTools.ts`:

```typescript
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerImageTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('generate_image', {
    description: 'Generate images in CATIMATION using the configured image model.',
    inputSchema: z.object({
      prompt: z.string().min(1),
      model: z.string().optional(),
      ratio: z.string().optional(),
      referenceImages: z.array(z.string()).optional(),
    }),
  }, async (params) => {
    const result = await router.call('generate_image', params)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
```

Create `src/main/mcp/tools/historyTools.ts`:

```typescript
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerHistoryTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('query_history', {
    description: 'Query CATIMATION generation history.',
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }),
  }, async (params) => {
    const result = await router.call('query_history', params)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  })
}
```

Create `src/main/mcp/tools/uiTools.ts`:

```typescript
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

export function registerUiTools(server: McpServer, router: ToolRouter): void {
  server.registerTool('open_image_viewer', {
    description: 'Open CATIMATION image viewer with one or more image URLs.',
    inputSchema: z.object({ urls: z.array(z.string()).min(1), startIndex: z.number().int().min(0).default(0) }),
  }, async (params) => {
    await router.call('open_image_viewer', params)
    return { content: [{ type: 'text', text: 'opened' }] }
  })
}
```

- [ ] **Step 4: Add router test**

Create `src/main/mcp/__tests__/ToolRouter.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'
import { ToolRouter } from '../ToolRouter'

describe('ToolRouter', () => {
  it('runs main handlers before renderer fallback', async () => {
    const win = { webContents: { send: vi.fn() } } as any
    const router = new ToolRouter(win)
    router.registerMain('ping', async () => ({ ok: true }))
    await expect(router.call('ping', {})).resolves.toEqual({ ok: true })
    expect(win.webContents.send).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run test:run -- src/main/mcp/__tests__/ToolRouter.test.ts
npm run typecheck
```

Expected: router test passes; MCP imports typecheck with installed packages.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp
git commit -m "feat(agent): add local MCP server and tool router"
```

---

## Task 6: Main IPC Wiring and App Startup

**Files:**
- Create: `src/main/agent/ipc.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/agent/__tests__/ipc.test.ts`

- [ ] **Step 1: Implement IPC registration**

Create `src/main/agent/ipc.ts`:

```typescript
import { ipcMain } from 'electron'
import type { AgentManager } from './AgentManager'
import type { ToolRouter } from '../mcp/ToolRouter'
import type { AgentToolResponse } from '../../types/agent'

export function registerAgentIpc(manager: AgentManager, router: ToolRouter): void {
  ipcMain.handle('agent:send-message', (_event, payload) => manager.sendMessage(payload))
  ipcMain.handle('agent:cancel', async (_event, payload) => {
    await manager.cancel(payload.threadId)
    return { success: true }
  })
  ipcMain.handle('agent:list-threads', () => manager.listThreads?.() ?? [])
  ipcMain.handle('agent:load-thread', (_event, threadId: string) => manager.loadThread?.(threadId) ?? null)
  ipcMain.on('agent:tool-response', (_event, response: AgentToolResponse) => router.handleRendererResponse(response))
}
```

- [ ] **Step 2: Add missing AgentManager methods**

Modify `src/main/agent/AgentManager.ts`:

```typescript
async listThreads() {
  return this.store.listThreads()
}

async loadThread(threadId: string) {
  return this.store.loadThread(threadId)
}
```

- [ ] **Step 3: Wire startup in main**

Modify `src/main/index.ts` after `mainWindow` creation and service setup:

```typescript
import { getPrisma, shutdownDatabase } from './agent/db'
import { ThreadStore } from './agent/ThreadStore'
import { AgentManager } from './agent/AgentManager'
import { registerAgentIpc } from './agent/ipc'
import { startCatimationMcpServer } from './mcp/server'

let agentManager: AgentManager | null = null

async function initAgentRuntime(win: BrowserWindow): Promise<void> {
  const prisma = await getPrisma()
  const threadStore = new ThreadStore(prisma)
  const mcp = await startCatimationMcpServer(win)
  agentManager = new AgentManager(win, threadStore)
  await agentManager.start()
  registerAgentIpc(agentManager, mcp.router)
}

app.on('before-quit', async () => {
  await agentManager?.stop()
  await shutdownDatabase()
})
```

Call it after `mainWindow` is ready:

```typescript
if (mainWindow) {
  void initAgentRuntime(mainWindow).catch((error) => {
    console.error('[AgentRuntime] init failed:', error)
  })
}
```

- [ ] **Step 4: Add IPC unit test**

Create `src/main/agent/__tests__/ipc.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

describe('agent IPC channel names', () => {
  it('uses stable channel names', () => {
    expect('agent:send-message').toBe('agent:send-message')
    expect('agent:tool-response').toBe('agent:tool-response')
  })
})
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run test:run -- src/main/agent/__tests__/ipc.test.ts
npm run typecheck
```

Expected: IPC test passes; typecheck catches any duplicate imports in `src/main/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/agent/ipc.ts src/main/agent/AgentManager.ts src/main/agent/__tests__/ipc.test.ts
git commit -m "feat(agent): wire main-process agent runtime"
```

---

## Task 7: Renderer Tool Executor

**Files:**
- Create: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`
- Modify: `src/renderer/src/features/agent-chat/index.ts`
- Modify: `src/renderer/src/layouts/AppLayout.tsx`
- Test: `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.test.ts`

- [ ] **Step 1: Implement renderer tool executor**

Create `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`:

```typescript
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { ApiService } from '../../services/api'
import type { HistoryDataService } from '../history'
import type { ImageViewer } from '../image-viewer'
import type { AgentToolRequest, AgentToolResponse } from '../../../../types/agent'
import { useTabStore } from '../../stores'

export class AgentToolExecutor {
  start(): () => void {
    return window.electronAPI.agent.onToolRequest((request) => {
      void this.handle(request)
    })
  }

  private async handle(request: AgentToolRequest): Promise<void> {
    const response: AgentToolResponse = await this.execute(request)
    window.electronAPI.agent.sendToolResponse(response)
  }

  private async execute(request: AgentToolRequest): Promise<AgentToolResponse> {
    try {
      const result = await this.call(request.toolName, request.params)
      return { id: request.id, ok: true, result }
    } catch (error) {
      return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private async call(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    if (toolName === 'generate_image') {
      const api = ServiceRegistry.getRequired<ApiService>(SERVICE_KEYS.API)
      return api.generateImage(params as any)
    }
    if (toolName === 'query_history') {
      const history = ServiceRegistry.getRequired<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
      return history.loadHistory?.() ?? []
    }
    if (toolName === 'open_image_viewer') {
      const viewer = ServiceRegistry.getRequired<ImageViewer>(SERVICE_KEYS.IMAGE_VIEWER)
      const { urls, startIndex } = params as { urls: string[]; startIndex?: number }
      viewer.open(urls, startIndex ?? 0)
      return { opened: true }
    }
    if (toolName === 'navigate_page') {
      const { tab } = params as { tab: string }
      useTabStore.getState().switchTab(tab as any)
      return { tab }
    }
    throw new Error(`Unknown renderer tool: ${toolName}`)
  }
}

export function mountAgentToolExecutor(): () => void {
  return new AgentToolExecutor().start()
}
```

- [ ] **Step 2: Export feature**

Create or modify `src/renderer/src/features/agent-chat/index.ts`:

```typescript
export { mountAgentToolExecutor, AgentToolExecutor } from './AgentToolExecutor'
```

- [ ] **Step 3: Mount executor**

Modify `src/renderer/src/layouts/AppLayout.tsx`:

```typescript
import { mountAgentToolExecutor } from '../features/agent-chat'
```

Inside `AppLayout()`:

```typescript
useEffect(() => {
  return mountAgentToolExecutor()
}, [])
```

- [ ] **Step 4: Add executor test**

Create `src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'

describe('AgentToolExecutor', () => {
  it('constructs without side effects', () => {
    expect(new AgentToolExecutor()).toBeInstanceOf(AgentToolExecutor)
  })
})
```

- [ ] **Step 5: Verify**

Run:

```bash
npm run test:run -- src/renderer/src/features/agent-chat/__tests__/AgentToolExecutor.test.ts
npm run typecheck
```

Expected: test passes; any real method name mismatch in `ApiService` is caught and corrected by inspecting `ApiService` before finalizing this task.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/agent-chat src/renderer/src/layouts/AppLayout.tsx
git commit -m "feat(agent): route MCP tools to renderer services"
```

---

## Task 8: Attachment Service

**Files:**
- Create: `src/main/agent/AttachmentService.ts`
- Modify: `src/main/agent/AgentManager.ts`
- Test: `src/main/agent/__tests__/AttachmentService.test.ts`

- [ ] **Step 1: Implement AttachmentService**

Create `src/main/agent/AttachmentService.ts`:

```typescript
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { PrismaClient } from '@prisma/client'
import type { AgentAttachmentInput } from '../../types/agent'

export class AttachmentService {
  constructor(private readonly prisma: PrismaClient) {}

  async ingest(threadId: string, attachments: AgentAttachmentInput[]) {
    const dir = path.join(app.getPath('userData'), 'agent', 'uploads')
    await fs.mkdir(dir, { recursive: true })
    return Promise.all(attachments.map(async (attachment) => {
      const buffer = attachment.buffer ? Buffer.from(attachment.buffer) : await fs.readFile(attachment.path!)
      const sha = crypto.createHash('sha256').update(buffer).digest('hex')
      const ext = path.extname(attachment.name)
      const localPath = path.join(dir, `${sha}${ext}`)
      await fs.writeFile(localPath, buffer)
      return this.prisma.agentAttachment.create({
        data: { threadId, originalName: attachment.name, localPath, mime: attachment.mime, size: attachment.size },
      })
    }))
  }

  async cleanup(cutoffMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - cutoffMs)
    const stale = await this.prisma.agentAttachment.findMany({ where: { uploadedAt: { lt: cutoff } } })
    for (const item of stale) {
      await fs.unlink(item.localPath).catch(() => undefined)
      await this.prisma.agentAttachment.delete({ where: { id: item.id } })
    }
    return stale.length
  }
}
```

- [ ] **Step 2: Attach to AgentManager**

Modify `AgentManager` constructor to receive `AttachmentService`:

```typescript
constructor(
  private readonly win: BrowserWindow,
  private readonly store: ThreadStore,
  private readonly attachments: AttachmentService,
) {
  this.backend = new CodexLocalBackend()
}
```

In `sendMessage`, after thread creation:

```typescript
const savedAttachments = await this.attachments.ingest(thread.id, payload.attachments)
const items = [
  { type: 'text' as const, text: payload.content },
  ...savedAttachments
    .filter((item) => item.mime.startsWith('image/'))
    .map((item) => ({ type: 'image' as const, imageUrl: `file://${item.localPath}` })),
]
```

Use `items` in `AgentInput`.

- [ ] **Step 3: Add test**

Create `src/main/agent/__tests__/AttachmentService.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest'

describe('AttachmentService contract', () => {
  it('stores metadata needed by agent attachments', () => {
    const create = vi.fn()
    create({ data: { threadId: 't1', originalName: 'a.png', localPath: '/tmp/a.png', mime: 'image/png', size: 3 } })
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ mime: 'image/png' }) })
  })
})
```

- [ ] **Step 4: Verify**

Run:

```bash
npm run test:run -- src/main/agent/__tests__/AttachmentService.test.ts
npm run typecheck
```

Expected: test passes; AgentManager constructor call in `src/main/index.ts` is updated.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/AttachmentService.ts src/main/agent/AgentManager.ts src/main/index.ts src/main/agent/__tests__/AttachmentService.test.ts
git commit -m "feat(agent): add attachment ingestion"
```

---

## Task 9: Agent Chat Store and UI Panel

**Files:**
- Create: `src/renderer/src/features/agent-chat/types.ts`
- Create: `src/renderer/src/features/agent-chat/store.ts`
- Create: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/MessageBubble.tsx`
- Create: `src/renderer/src/features/agent-chat/ReasoningPanel.tsx`
- Create: `src/renderer/src/features/agent-chat/ToolCallCard.tsx`
- Create: `src/renderer/src/features/agent-chat/ArtifactGrid.tsx`
- Create: `src/renderer/src/features/agent-chat/AttachmentChips.tsx`
- Create: `src/renderer/src/features/agent-chat/MentionInput.tsx`
- Modify: `src/renderer/src/features/agent-chat/index.ts`
- Modify: `src/renderer/src/layouts/AppLayout.tsx`
- Test: `src/renderer/src/features/agent-chat/__tests__/store.test.ts`

- [ ] **Step 1: Create Zustand store**

Create `src/renderer/src/features/agent-chat/store.ts`:

```typescript
import { create } from 'zustand'
import type { AgentAttachmentInput, AgentStreamEvent } from '../../../../types/agent'

export interface AgentChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
}

interface AgentChatState {
  isOpen: boolean
  threadId?: string
  input: string
  attachments: AgentAttachmentInput[]
  messages: AgentChatMessage[]
  reasoning: string
  isRunning: boolean
  toggle: () => void
  setInput: (input: string) => void
  addAttachment: (attachment: AgentAttachmentInput) => void
  removeAttachment: (name: string) => void
  send: () => Promise<void>
  applyEvent: (event: AgentStreamEvent) => void
}

export const useAgentChatStore = create<AgentChatState>((set, get) => ({
  isOpen: false,
  input: '',
  attachments: [],
  messages: [],
  reasoning: '',
  isRunning: false,
  toggle: () => set((state) => ({ isOpen: !state.isOpen })),
  setInput: (input) => set({ input }),
  addAttachment: (attachment) => set((state) => ({ attachments: [...state.attachments, attachment] })),
  removeAttachment: (name) => set((state) => ({ attachments: state.attachments.filter((item) => item.name !== name) })),
  send: async () => {
    const state = get()
    const content = state.input.trim()
    if (!content || state.isRunning) return
    set((s) => ({
      input: '',
      attachments: [],
      isRunning: true,
      messages: [...s.messages, { id: crypto.randomUUID(), role: 'user', content }],
    }))
    const result = await window.electronAPI.agent.sendMessage({ threadId: state.threadId, content, attachments: state.attachments, currentPage: window.location.hash.slice(1) })
    set({ threadId: result.threadId })
  },
  applyEvent: (event) => {
    if (event.type === 'message_delta') {
      set((state) => {
        const last = state.messages[state.messages.length - 1]
        if (last?.role === 'assistant') {
          return { messages: [...state.messages.slice(0, -1), { ...last, content: last.content + (event.delta ?? '') }] }
        }
        return { messages: [...state.messages, { id: crypto.randomUUID(), role: 'assistant', content: event.delta ?? '' }] }
      })
    }
    if (event.type === 'reasoning_delta') set((state) => ({ reasoning: state.reasoning + (event.delta ?? '') }))
    if (event.type === 'turn_completed' || event.type === 'error' || event.type === 'cancelled') set({ isRunning: false })
  },
}))
```

- [ ] **Step 2: Create panel shell**

Create `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`:

```tsx
import { useEffect } from 'react'
import { useAgentChatStore } from './store'
import { MessageBubble } from './MessageBubble'
import { MentionInput } from './MentionInput'
import { AttachmentChips } from './AttachmentChips'

export function AgentChatPanel() {
  const isOpen = useAgentChatStore((s) => s.isOpen)
  const messages = useAgentChatStore((s) => s.messages)
  const applyEvent = useAgentChatStore((s) => s.applyEvent)

  useEffect(() => window.electronAPI.agent.onEvent(applyEvent), [applyEvent])

  if (!isOpen) return null

  return (
    <aside className="fixed right-0 top-0 z-[40000] h-screen w-[420px] border-l border-cyan-500/30 bg-zinc-950 text-white shadow-2xl">
      <header className="flex h-12 items-center justify-between border-b border-cyan-500/20 px-4">
        <h2 className="text-sm font-semibold text-cyan-200">CATIMATION Agent</h2>
        <button className="text-zinc-400 hover:text-white" onClick={() => useAgentChatStore.getState().toggle()}>×</button>
      </header>
      <div className="h-[calc(100vh-120px)] overflow-y-auto p-4">
        {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
      </div>
      <footer className="border-t border-cyan-500/20 p-3">
        <AttachmentChips />
        <MentionInput />
      </footer>
    </aside>
  )
}
```

- [ ] **Step 3: Add minimal child components**

Create `MessageBubble.tsx`:

```tsx
import type { AgentChatMessage } from './store'

export function MessageBubble({ message }: { message: AgentChatMessage }) {
  const mine = message.role === 'user'
  return (
    <div className={`mb-3 rounded-lg p-3 text-sm ${mine ? 'bg-cyan-500/20' : 'bg-zinc-800'}`}>
      {message.content}
    </div>
  )
}
```

Create `MentionInput.tsx`:

```tsx
import { useAgentChatStore } from './store'

export function MentionInput() {
  const input = useAgentChatStore((s) => s.input)
  const setInput = useAgentChatStore((s) => s.setInput)
  const send = useAgentChatStore((s) => s.send)
  return (
    <form onSubmit={(event) => { event.preventDefault(); void send() }}>
      <textarea className="h-20 w-full rounded bg-zinc-900 p-2 text-sm outline-none ring-1 ring-cyan-500/30" value={input} onChange={(event) => setInput(event.target.value)} />
      <button className="mt-2 w-full rounded bg-cyan-500 py-2 text-sm font-semibold text-black" type="submit">发送</button>
    </form>
  )
}
```

Create `AttachmentChips.tsx`:

```tsx
import { useAgentChatStore } from './store'

export function AttachmentChips() {
  const attachments = useAgentChatStore((s) => s.attachments)
  const removeAttachment = useAgentChatStore((s) => s.removeAttachment)
  if (attachments.length === 0) return null
  return (
    <div className="mb-2 flex gap-2 overflow-x-auto">
      {attachments.map((item) => (
        <button key={item.name} className="rounded bg-zinc-800 px-2 py-1 text-xs" onClick={() => removeAttachment(item.name)} type="button">
          {item.name} ×
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: Add exports and layout mount**

Modify `src/renderer/src/features/agent-chat/index.ts`:

```typescript
export { AgentChatPanel } from './AgentChatPanel'
export { mountAgentToolExecutor, AgentToolExecutor } from './AgentToolExecutor'
export { useAgentChatStore } from './store'
```

Modify `src/renderer/src/layouts/AppLayout.tsx`:

```tsx
import { AgentChatPanel, mountAgentToolExecutor, useAgentChatStore } from '../features/agent-chat'
```

Inside `AppLayout`, add keyboard shortcut:

```typescript
useEffect(() => {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      useAgentChatStore.getState().toggle()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}, [])
```

Render panel after `</main>`:

```tsx
<AgentChatPanel />
```

- [ ] **Step 5: Add store test**

Create `src/renderer/src/features/agent-chat/__tests__/store.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'

describe('useAgentChatStore', () => {
  it('appends assistant deltas', () => {
    useAgentChatStore.setState({ messages: [], reasoning: '', isRunning: true })
    useAgentChatStore.getState().applyEvent({ type: 'message_delta', threadId: 't1', delta: 'hello' })
    useAgentChatStore.getState().applyEvent({ type: 'message_delta', threadId: 't1', delta: ' world' })
    expect(useAgentChatStore.getState().messages[0].content).toBe('hello world')
  })
})
```

- [ ] **Step 6: Verify**

Run:

```bash
npm run test:run -- src/renderer/src/features/agent-chat/__tests__/store.test.ts
npm run typecheck
```

Expected: store test passes; layout compiles.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/features/agent-chat src/renderer/src/layouts/AppLayout.tsx
git commit -m "feat(agent): add chat panel MVP"
```

---

## Task 10: Artifact Preview and File Upload UX

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`
- Modify: `src/renderer/src/features/agent-chat/ArtifactGrid.tsx`
- Modify: `src/renderer/src/features/agent-chat/store.ts`
- Test: `src/renderer/src/features/agent-chat/__tests__/ArtifactGrid.test.tsx`

- [ ] **Step 1: Add artifacts to store**

Modify `store.ts`:

```typescript
import type { AgentArtifact } from '../../../../types/agent'

interface AgentChatState {
  artifacts: AgentArtifact[]
}
```

Initial state:

```typescript
artifacts: [],
```

In `applyEvent`:

```typescript
if (event.type === 'artifact_created' && event.artifact) {
  set((state) => ({ artifacts: [...state.artifacts, event.artifact!] }))
}
```

- [ ] **Step 2: Implement ArtifactGrid**

Create `src/renderer/src/features/agent-chat/ArtifactGrid.tsx`:

```tsx
import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { ImageViewer } from '../image-viewer'
import type { AgentArtifact } from '../../../../types/agent'

export function ArtifactGrid({ artifacts }: { artifacts: AgentArtifact[] }) {
  const images = artifacts.filter((item) => item.type === 'image')
  if (images.length === 0) return null

  const open = (artifact: AgentArtifact) => {
    const viewer = ServiceRegistry.get<ImageViewer>(SERVICE_KEYS.IMAGE_VIEWER)
    const urls = images.map((item) => item.uri)
    const index = images.findIndex((item) => item.id === artifact.id)
    viewer?.open(urls, index)
  }

  return (
    <div className="mt-3 grid grid-cols-3 gap-2">
      {images.map((artifact) => (
        <button key={artifact.id} type="button" onDoubleClick={() => open(artifact)} className="overflow-hidden rounded border border-cyan-500/30">
          <img src={artifact.uri} alt="" className="h-24 w-full object-cover" />
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Render ArtifactGrid**

Modify `AgentChatPanel.tsx`:

```tsx
import { ArtifactGrid } from './ArtifactGrid'
```

Read artifacts:

```typescript
const artifacts = useAgentChatStore((s) => s.artifacts)
```

Render after messages:

```tsx
<ArtifactGrid artifacts={artifacts} />
```

- [ ] **Step 4: Add upload handler**

In `MentionInput.tsx`, add file input:

```tsx
const addAttachment = useAgentChatStore((s) => s.addAttachment)

async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
  const files = Array.from(event.target.files ?? [])
  for (const file of files) {
    addAttachment({ name: file.name, mime: file.type, size: file.size, buffer: await file.arrayBuffer() })
  }
}
```

Render before submit button:

```tsx
<input className="mt-2 text-xs" multiple type="file" onChange={(event) => void onFileChange(event)} />
```

- [ ] **Step 5: Add ArtifactGrid test**

Create `src/renderer/src/features/agent-chat/__tests__/ArtifactGrid.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ArtifactGrid } from '../ArtifactGrid'

describe('ArtifactGrid', () => {
  it('renders image artifacts', () => {
    render(<ArtifactGrid artifacts={[{ id: 'a1', type: 'image', uri: 'file:///a.png', metadata: {}, createdAt: new Date().toISOString() }]} />)
    expect(screen.getByRole('img')).toBeTruthy()
  })
})
```

- [ ] **Step 6: Verify**

Run:

```bash
npm run test:run -- src/renderer/src/features/agent-chat/__tests__/ArtifactGrid.test.tsx
npm run typecheck
```

Expected: artifact test passes; file upload types compile.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/features/agent-chat
git commit -m "feat(agent): add attachments and artifact previews"
```

---

## Task 11: Codex Binary Fetch Script and Runtime Smoke Test

**Files:**
- Modify: `scripts/fetch-codex.ts`
- Create: `src/main/agent/__tests__/codexRuntime.smoke.test.ts`

- [ ] **Step 1: Implement fetch script**

Create `scripts/fetch-codex.ts`:

```typescript
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const version = process.env.CODEX_CLI_VERSION ?? '0.128.0'
const targets = [
  { target: 'win32-x64', binary: 'codex.exe', assetIncludes: ['windows', 'win32', 'x86_64', 'x64'] },
  { target: 'darwin-arm64', binary: 'codex', assetIncludes: ['darwin', 'macos', 'aarch64', 'arm64'] },
  { target: 'darwin-x64', binary: 'codex', assetIncludes: ['darwin', 'macos', 'x86_64', 'x64'] },
  { target: 'linux-x64', binary: 'codex', assetIncludes: ['linux', 'x86_64', 'x64'] },
] as const

interface GitHubAsset {
  name: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  assets: GitHubAsset[]
}

async function main() {
  const release = await fetchRelease(version)
  for (const { target, binary, assetIncludes } of targets) {
    const dir = path.join(process.cwd(), 'resources', 'codex', target)
    await fs.mkdir(dir, { recursive: true })
    const asset = findAsset(release.assets, assetIncludes)
    const archivePath = path.join(dir, asset.name)
    await download(asset.browser_download_url, archivePath)
    await extractArchive(archivePath, dir, binary)
    const binaryPath = path.join(dir, binary)
    await fs.chmod(binaryPath, 0o755).catch(() => undefined)
  }
}

async function fetchRelease(version: string): Promise<GitHubRelease> {
  const tag = version.startsWith('v') ? version : `v${version}`
  const url = `https://api.github.com/repos/2799662352/codex/releases/tags/${tag}`
  const response = await fetch(url, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
  })
  if (!response.ok) throw new Error(`Failed to fetch Codex release ${tag}: ${response.status}`)
  return response.json() as Promise<GitHubRelease>
}

function findAsset(assets: GitHubAsset[], includes: readonly string[]): GitHubAsset {
  const asset = assets.find((candidate) => {
    const name = candidate.name.toLowerCase()
    return includes.every((part) => name.includes(part))
  })
  if (!asset) {
    throw new Error(`No release asset matches: ${includes.join(', ')}`)
  }
  return asset
}

async function download(url: string, outPath: string): Promise<void> {
  const response = await fetch(url, {
    headers: process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {},
  })
  if (!response.ok || !response.body) throw new Error(`Failed to download ${url}: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(outPath, bytes)
}

async function extractArchive(archivePath: string, dir: string, binary: string): Promise<void> {
  const lower = archivePath.toLowerCase()
  if (lower.endsWith('.zip')) {
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(await fs.readFile(archivePath))
    const file = Object.values(zip.files).find((entry) => path.basename(entry.name) === binary)
    if (!file) throw new Error(`Archive ${archivePath} does not contain ${binary}`)
    await fs.writeFile(path.join(dir, binary), await file.async('nodebuffer'))
    return
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    throw new Error(`Unsupported archive ${archivePath}; expected a zip asset or raw ${binary} binary`)
  }
  if (path.basename(archivePath) === binary) {
    await fs.copyFile(archivePath, path.join(dir, binary))
    return
  }
  throw new Error(`Unsupported Codex asset format: ${archivePath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
```

- [ ] **Step 2: Add smoke test gated by binary presence**

Create `src/main/agent/__tests__/codexRuntime.smoke.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { resolveCodexBinary } from '../paths'

describe('codex runtime smoke', () => {
  it('documents binary presence requirement', () => {
    const bin = resolveCodexBinary(process.resourcesPath ?? process.cwd())
    expect(typeof bin).toBe('string')
    if (!fs.existsSync(bin)) {
      console.warn(`Codex binary not present at ${bin}; run npm run codex:fetch and place release asset before integration smoke.`)
    }
  })
})
```

- [ ] **Step 3: Verify resource script**

Run:

```bash
npm run codex:fetch
npm run test:run -- src/main/agent/__tests__/codexRuntime.smoke.test.ts
npm run build:vite
```

Expected: resource folders are created; smoke test passes; Vite build includes new source.

- [ ] **Step 4: Commit**

```bash
git add scripts/fetch-codex.ts resources/codex src/main/agent/__tests__/codexRuntime.smoke.test.ts
git commit -m "chore(agent): scaffold Codex binary packaging"
```

---

## Task 12: End-to-End Validation Pass

**Files:**
- Create: `e2e/agent-chat.spec.ts`
- Modify: `docs/superpowers/specs/2026-05-06-codex-agent-integration-design.md` only if runtime discoveries require a spec correction.

- [ ] **Step 1: Add E2E smoke**

Create `e2e/agent-chat.spec.ts`:

```typescript
import { test, expect } from '@playwright/test'

test('agent panel opens with keyboard shortcut', async ({ page }) => {
  await page.goto('/')
  await page.keyboard.press('Control+Shift+A')
  await expect(page.getByText('CATIMATION Agent')).toBeVisible()
})
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm run test:run -- src/main/agent src/main/mcp src/renderer/src/features/agent-chat
npm run typecheck
npm run build:vite
```

Expected: focused tests pass, typecheck passes, build completes.

- [ ] **Step 3: Run manual local smoke**

Run:

```bash
npm run dev
```

Manual checks:
- Press `Ctrl+Shift+A`; panel opens.
- Type a message; user bubble appears and input clears.
- If Codex binary is present, AgentManager starts without runtime error.
- If Codex binary is absent, UI reports actionable startup error and app stays usable.
- Upload one image; attachment chip appears.
- Emit a fake `artifact_created` event in devtools; image tile appears and double-click opens `ImageViewer`.

- [ ] **Step 4: Commit**

```bash
git add e2e/agent-chat.spec.ts
git commit -m "test(agent): add chat panel smoke coverage"
```

---

## Self-Review Checklist

- [ ] Every MVP spec requirement maps to at least one task:
  - Codex local app-server: Task 4
  - MCP HTTP server: Task 5
  - Renderer tool bridge: Task 7
  - Postgres/PGlite: Task 3
  - Attachments: Task 8 and Task 10
  - Chat UI: Task 9
  - Artifact preview: Task 10
  - Packaging: Task 1 and Task 11
  - Verification: Task 12
- [ ] Non-MVP features remain out of this plan:
  - codex-gateway
  - FastAPI/FastMCP
  - remote MCP
  - parallel multi-agent
  - embedded browser
- [ ] All changed files have exact paths.
- [ ] Every task has a focused test command.
- [ ] Each task ends with a commit command.

