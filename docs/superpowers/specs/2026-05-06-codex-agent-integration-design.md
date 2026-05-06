---
date: 2026-05-06
topic: codex-agent-integration
---

# CATIMATION × Codex Agent 集成设计

## What We're Building

把 OpenAI Codex CLI（`2799662352/codex` fork）作为本地 agent 内嵌进 CATIMATION 桌面应用，让用户能用自然语言指挥整个图像生成/处理工作流。Agent 通过 MCP（Model Context Protocol）调用 CATIMATION 已有的服务能力（图片生成、批量处理、分镜导演、图像理解、历史查询等），同时保留 Codex 原生的 shell / apply_patch / 文件读写等满血开发能力。

**先做"本地优先"**：应用打包自带 Codex CLI 二进制，零外部依赖即可使用。后续再加 codex-gateway 联网通道（不在本 spec 范围内）。

## 上下文与基线

| 已有能力 | 状态 |
|---|---|
| Electron 28 + electron-vite + TypeScript 主框架 | 已落地（v18 完成深度迁移） |
| ServiceRegistry / appServices 命名空间 | 已落地（V16.3 完成 window 全局移除） |
| ApiService、HistoryDataService、BatchPage、DirectorPage 等业务服务 | 已落地 |
| ImageViewer 模块（大图查看 + 操作栏） | 已落地，可直接复用 |
| sora 平台 Postgres + Prisma + R2 存储 | 已落地（25/soraui_4.0/sora-ui-backend） |
| codex-source（OpenAI Codex fork，含 codex-rs / sdk / mcp-server / rmcp-client） | 已 clone 到 25/soraui_4.0/codex-source |
| codex-gateway（Go + WebSocket + Redis 进程池） | 已落地，本期不直接使用 |
| sora-ui 的 AgentChat / SoloPanel / ToolCallCard 等 React 组件 | 已落地，作为 UI 借鉴 |

| 本期新增 | 状态 |
|---|---|
| Codex CLI 二进制随应用打包（per-platform，0.128.0 fork） | 未实现 |
| Electron 主进程 AgentManager（spawn `codex app-server`，WS JSON-RPC） | 未实现 |
| 内嵌 MCP server 暴露 CATIMATION 工具（SDK v1.x 拆包：server / node / express） | 未实现 |
| AgentChatPanel（侧边抽屉，React） | 未实现 |
| 文件上传 / 多图引用 / 双击预览 | 未实现 |
| Postgres / PGlite 双模式持久化（Prisma + `@electric-sql/pglite-socket`） | 未实现 |
| Codex 配置注入（`~/.codex/config.toml` 写入 catimation MCP server） | 未实现 |

## 核心决策

### 决策 1：方案 C 优先 — 本地嵌入 Codex CLI

**问题**：CATIMATION 既要满足"零依赖即用"的桌面应用预期，又要兼容 Sora 平台的统一计费/进程池。

**决策**：本期只做本地嵌入（方案 C）。把 Codex CLI 二进制随应用打包，主进程 spawn `codex app-server`（实验性 JSON-RPC over WebSocket 协议模式），通过 localhost WebSocket 驱动 agent loop。后续追加 codex-gateway 联网通道（方案 A）作为可选增强，不在本 spec 范围。

**理由**：
- 桌面应用首次启动必须能跑，不能依赖远端服务
- Codex CLI 已经成熟（80k stars，主分支 0.128.0），直接复用比自己造 agent loop 划算
- 联网通道是后续优化，接口层（`IAgentBackend`）预留扩展点即可

### 决策 2：MCP-native 工具协议（v1.x SDK 拆包）

**问题**：CATIMATION 暴露给 agent 的工具用什么协议？

**决策**：直接走 MCP，不造自定义 JSON 协议。用 v1.x 拆包 SDK：`@modelcontextprotocol/server` + `@modelcontextprotocol/node` + `@modelcontextprotocol/express`。

**理由**：
- Codex 的 `rmcp-client` 原生支持 MCP（stdio / streamable HTTP）
- v1.x SDK 拆包后职责更清晰：协议、Node 传输、Express 中间件分离
- `createMcpExpressApp()` 中间件自带 DNS rebinding 防护，比手搓 Express 更安全
- 同一个 MCP server 未来可以暴露给 Claude Desktop / Cursor / 其他 Codex 实例
- 把 `127.0.0.1` 换成 `0.0.0.0` 就能远程化，无缝过渡到方案 A

### 决策 3：满血权限，不做沙箱

**问题**：Agent 是否限制为只能调注册的工具？

**决策**：不限制。Agent 拥有 Codex 全部原生能力 — `shell`、`apply_patch`、文件系统、网络、git 全开。

**理由**：
- 用户期望 agent 是"全能开发伙伴"+"图像专家"，不是受限助手
- 这与 Codex CLI 直接在终端跑没区别 — 接受 Codex 就接受这套
- 唯一保留：所有工具调用持久化到 DB，出问题能回溯

> **注**：本 spec 后续提到的 MCP HTTP token 不是 agent 权限模型，而是 localhost 端口安全（防止本机其他进程误调 CATIMATION 内部服务）。Agent 本身依旧满血。

### 决策 4：Postgres + PGlite 双模式持久化

**问题**：Agent 会话/工具调用历史存哪？

**决策**：用 Prisma + Postgres schema。两种部署形态：
- **平台模式**：检测到 sora-postgres 可达 → 直连
- **本地模式**：默认，启动 PGlite（WASM Postgres）嵌入式

**理由**：
- SQLite 与 Sora 平台 Postgres 体系不一致（用户原话："SQLite 太搞笑了"）
- PGlite 提供完整 Postgres 协议 + ~3MB gzipped + 嵌入式（WASM 单进程）
- 通过 `@electric-sql/pglite-socket` 在 Electron 主进程内启动 `PGLiteSocketServer`，绑 localhost TCP / Unix socket，Prisma 用普通 `postgresql://` 连接，与 sora-postgres 完全无差异

### 决策 5：复用 sora-ui 的 AgentChat 组件模式

**问题**：聊天面板从零写还是借鉴现有的？

**决策**：架构借鉴 sora-ui 的 SoloPanel + AgentChat + ToolCallCard，但代码独立实现（不引入 sora-ui 依赖）。

**理由**：
- sora-ui 的 turnAggregator、ReasoningPanel、ToolCallCard 已经是成熟模式
- 直接拷贝代码会引入大量耦合（sora-ui 走 WebSocket，我们走 IPC）
- 借鉴抽象、独立实现更干净

## 架构设计

### 整体架构

```
┌──────────────────────────────────────────────────────────┐
│  CATIMATION Electron App                                  │
│                                                            │
│  ┌─ Renderer (React) ──────────────────────────────────┐ │
│  │                                                      │ │
│  │  ┌─ AgentChatPanel (right drawer, 400px, Ctrl+Shift+A)─┐ │
│  │  │  • MessageBubble / ReasoningPanel                  │ │
│  │  │  • ToolCallCard (folded)                            │ │
│  │  │  • ArtifactGrid (thumbnails, double-click preview)  │ │
│  │  │  • MentionInput (@image:, @history:)                │ │
│  │  │  • AttachmentChips (drag/drop/paste/picker)         │ │
│  │  └─────────────────────────────────────────────────────┘ │
│  │                       │ IPC                            │ │
│  └───────────────────────┼────────────────────────────────┘ │
│                          ▼                                   │
│  ┌─ Main Process ───────────────────────────────────────┐   │
│  │                                                       │   │
│  │  ┌─ AgentManager ──────────────────┐                 │   │
│  │  │  • spawn `codex app-server`      │                 │   │
│  │  │  • WS JSON-RPC client (ws lib)   │                 │   │
│  │  │  • thread/turn 生命周期         │                 │   │
│  │  │  • IAgentBackend interface       │                 │   │
│  │  └────────────┬────────────────────┘                 │   │
│  │               │ WebSocket JSON-RPC localhost          │   │
│  │               ▼                                        │   │
│  │  ┌─ Codex CLI 子进程 (bundled binary) ────────────┐  │   │
│  │  │  ~/.codex/config.toml:                          │  │   │
│  │  │    [mcp_servers.catimation]                     │  │   │
│  │  │    transport = "streamable_http"                 │  │   │
│  │  │    url = "http://127.0.0.1:7842/mcp"             │  │   │
│  │  │    headers.X-CATIMATION-Token = "<random>"       │  │   │
│  │  └────────────┬────────────────────────────────────┘  │   │
│  │               │ MCP (rmcp-client → HTTP localhost)     │   │
│  │               ▼                                        │   │
│  │  ┌─ CATIMATION MCP Server (in-process, HTTP) ──────┐  │   │
│  │  │  @modelcontextprotocol/{server,node,express}     │  │   │
│  │  │  NodeStreamableHTTPServerTransport               │  │   │
│  │  │  createMcpExpressApp() — DNS rebind 防护         │  │   │
│  │  │  bind 127.0.0.1:7842 (localhost-only)            │  │   │
│  │  │                                                  │  │   │
│  │  │  Tools:                                          │  │   │
│  │  │   • generate_image / batch_process               │  │   │
│  │  │   • analyze_image / compare_images               │  │   │
│  │  │   • director_storyboard                          │  │   │
│  │  │   • query_history / manage_templates             │  │   │
│  │  │   • navigate_page / open_image_viewer (UI 反控)   │  │   │
│  │  │   • query_task_status (轮询长任务)                │  │   │
│  │  │                                                  │  │   │
│  │  │  Resources:                                      │  │   │
│  │  │   • catimation://history/<id>                    │  │   │
│  │  │   • catimation://template/<id>                   │  │   │
│  │  │   • catimation://upload/<sha256>                 │  │   │
│  │  │                                                  │  │   │
│  │  │  ↓ 实现层调用 ServiceRegistry.get(...)            │  │   │
│  │  └──────────────────────────────────────────────────┘  │   │
│  │                                                         │   │
│  │  ┌─ Prisma Client ────────────────────────────────┐   │   │
│  │  │  postgresql:// URL                             │   │   │
│  │  │   ├─ sora-postgres (容器)                      │   │   │
│  │  │   └─ PGLiteSocketServer @ 127.0.0.1:5433       │   │   │
│  │  │      └─ PGlite WASM (userData/pgdata)          │   │   │
│  │  │  Models: AgentThread / Message / ToolCall /     │   │   │
│  │  │          Artifact / Attachment                  │   │   │
│  │  └────────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 主进程模块

#### `src/main/agent/AgentManager.ts`

负责 Codex CLI 子进程的全生命周期。Codex 0.128.0 fork 实际有的协议子命令（来自 `codex-rs/cli/src/main.rs::Subcommand`）：
- `codex app-server` — [实验性] JSON-RPC over WebSocket，方法 `thread/start` `turn/start` `item/agentMessage/delta` `turn/completed` 等
- `codex mcp-server` — Codex 自身作为 MCP server（stdio）
- `codex exec` — 非交互单次执行

选 `app-server`：流式 reasoning/turn 输出、双向 JSON-RPC 控制（取消/中断），与 Codex SDK 路径一致。

```typescript
import WebSocket from 'ws';
import { spawn, ChildProcess } from 'node:child_process';

interface IAgentBackend {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(threadId: string, input: AgentInput): AsyncIterable<AgentEvent>;
  cancel(threadId: string): Promise<void>;
  isHealthy(): boolean;
}

class CodexLocalBackend implements IAgentBackend {
  private process: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private restartCount = 0;
  private readonly maxRestarts = 3;
  private rpcId = 0;
  private pending = new Map<number, (r: any) => void>();

  async start() {
    const binPath = resolveCodexBinary();
    const port = await pickFreePort();
    this.process = spawn(binPath, ['app-server', 'serve', '--listen', `ws://127.0.0.1:${port}`], {
      env: this.buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'], // stdout/stderr 写日志文件
    });
    this.process.on('exit', this.handleExit.bind(this));
    this.ws = await this.connectWs(`ws://127.0.0.1:${port}`);
    await this.rpc('initialize', { clientName: 'catimation' });
  }

  async *send(threadId: string, input: AgentInput): AsyncIterable<AgentEvent> {
    if (!threadId) {
      const r = await this.rpc('thread/start', { model: input.model, cwd: input.cwd });
      threadId = r.thread.id;
    }
    const turnId = await this.rpc('turn/start', { threadId, input: input.items });
    // 同时监听 notifications：item/agentMessage/delta、item/toolCall/*、turn/completed
    for await (const evt of this.notificationStream(turnId)) yield evt;
  }

  async cancel(threadId: string) {
    await this.rpc('turn/cancel', { threadId });
  }

  private async rpc<T = any>(method: string, params: any): Promise<T> {
    const id = ++this.rpcId;
    return new Promise<T>((resolve) => {
      this.pending.set(id, resolve);
      this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
}
```

后续加 `CodexGatewayBackend implements IAgentBackend` 即可切换到 codex-gateway WebSocket。

#### `src/main/mcp/server.ts`

MCP server 入口，跑在 Electron 主进程内（同进程，无子进程），通过 HTTP localhost-only 暴露给 Codex CLI 子进程。Codex 用 `rmcp-client` 的 streamable HTTP transport 连接。

用 MCP TypeScript SDK v1.x（拆包后的 `@modelcontextprotocol/server` + `@modelcontextprotocol/node` + `@modelcontextprotocol/express`）。`createMcpExpressApp()` 中间件自带 DNS rebinding 防护。

```typescript
import { randomUUID, randomBytes } from 'node:crypto';
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { createMcpExpressApp } from '@modelcontextprotocol/express';

const MCP_PORT = 7842;
const TOKEN = randomBytes(32).toString('hex'); // 启动时生成，写入 ~/.codex/config.toml

export async function startMcpServer() {
  const server = new McpServer({ name: 'catimation', version: app.getVersion() });

  registerImageTools(server);
  registerDataTools(server);
  registerUITools(server);
  registerResources(server);

  const expressApp = createMcpExpressApp(); // 自带 DNS rebinding 防护
  expressApp.use((req, res, next) => {
    if (req.headers['x-catimation-token'] !== TOKEN) {
      return res.status(401).send('unauthorized');
    }
    next();
  });

  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  expressApp.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.handleRequest(req, res, req.body);
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, transport),
      });
      transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } else {
      res.status(400).json({ error: 'Invalid request' });
    }
  });

  expressApp.listen(MCP_PORT, '127.0.0.1');
}
```

**为什么 HTTP 而非 stdio：**
- stdio transport 需要让 Codex spawn 一个独立 MCP server 子进程，无法直接访问 Electron 主进程的 `ServiceRegistry`
- HTTP transport 让 server 直接在 Electron 主进程跑，零进程边界
- 同一个 server 未来切换到对外暴露（监听 `0.0.0.0`）只需改一行配置

**为什么安全：**
- 绑定 `127.0.0.1`，外网不可达
- 自定义 token header 防本机其他进程误调
- 端口 7842 默认（可在设置里改）

每个工具实现层是薄包装，参数校验后调 `appServices.get(SERVICE_KEYS.X).method(...)`。

**UI 反控工具的特殊处理：**
`navigate_page`、`open_image_viewer`、`update_settings` 这类需要影响渲染进程的工具，MCP server 通过主进程的 `webContents.send('agent:ui-command', ...)` IPC 通知渲染进程执行。渲染进程在 `agent-chat/store.ts` 注册 listener，dispatch 到对应的 React 组件 / Zustand action。

#### Codex 配置注入

应用首次启动时，写入或更新 `~/.codex/config.toml`：

```toml
[mcp_servers.catimation]
transport = "streamable_http"
url = "http://127.0.0.1:7842/mcp"

[mcp_servers.catimation.headers]
X-CATIMATION-Token = "<random-32-bytes-hex-generated-at-install>"
```

token 也持久化到 Electron `userData/mcp-token.txt`，应用启动时读取并要求所有 MCP 请求携带。

#### `src/main/agent/AttachmentService.ts`

处理用户上传的文件 — 拖拽、粘贴、按钮选择。

```typescript
class AttachmentService {
  private cacheDir = path.join(app.getPath('userData'), '.cache/uploads');

  async ingest(threadId: string, files: File[]): Promise<Attachment[]> {
    return Promise.all(files.map(async (f) => {
      const sha = sha256(f.buffer);
      const localPath = path.join(this.cacheDir, sha + path.extname(f.name));
      await fs.writeFile(localPath, f.buffer);
      const att = await prisma.agentAttachment.create({
        data: { threadId, originalName: f.name, localPath, mime: f.mime, size: f.buffer.length },
      });
      return att;
    }));
  }

  async cleanup() {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const stale = await prisma.agentAttachment.findMany({ where: { uploadedAt: { lt: new Date(cutoff) } } });
    for (const att of stale) {
      await fs.unlink(att.localPath).catch(() => {});
      await prisma.agentAttachment.delete({ where: { id: att.id } });
    }
  }
}
```

#### `src/main/agent/db.ts`

数据库连接策略 — Postgres 或 PGlite。

```typescript
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

async function resolveDatabaseUrl(): Promise<string> {
  // 1. 用户设置里的远程 URL（首选 sora-postgres）
  const userConfig = await loadUserSetting('agent.databaseUrl');
  if (userConfig && await canConnect(userConfig)) return userConfig;

  // 2. 自动检测本地 sora-postgres（与 docker-compose.local.yml 对齐）
  const localSora = 'postgresql://sorauser:sora_password_2024@localhost:5432/soraui';
  if (await canConnect(localSora)) return localSora;

  // 3. 嵌入式 PGlite — 通过 socket server 暴露 Postgres wire protocol
  return await startEmbeddedPGlite();
}

async function startEmbeddedPGlite(): Promise<string> {
  const dataDir = path.join(app.getPath('userData'), 'pgdata');
  const db = await PGlite.create(dataDir);
  const port = await pickFreePort(); // 默认尝试 5433，被占用则递增
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  // 进程退出时优雅关闭
  app.on('before-quit', async () => { await server.stop(); await db.close(); });
  return `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;
}
```

**关键设计：**
- PGlite 是 WASM 单进程库，不能跨 Electron window 共享 → **所有 DB 访问统一经主进程**，渲染进程通过 IPC 调用
- `@electric-sql/pglite-socket` 包提供 `PGLiteSocketServer`，把 PGlite 实例暴露成标准 Postgres TCP 服务
- 之后 Prisma 用普通 `postgresql://` URL 连接，与 sora-postgres 路径完全无差异，schema/migration 零改动
- 数据目录 `userData/pgdata` 跟随用户配置走，应用卸载时清理

### 渲染进程模块

#### `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`

右侧抽屉容器，宽度 400px，可拖拽调整。Zustand store 管理本地状态，IPC 监听主进程 agent 事件。

#### 关键子组件

| 组件 | 职责 |
|---|---|
| `MessageBubble.tsx` | 单条消息渲染（user/assistant/system） |
| `ReasoningPanel.tsx` | Agent 思考过程，默认折叠 |
| `ToolCallCard.tsx` | 工具调用 — 状态、参数、结果折叠展开 |
| `ArtifactGrid.tsx` | 图片缩略图（120×120），单击选中 / 双击预览 |
| `MentionInput.tsx` | 输入框，支持 `@image:` `@history:` |
| `AttachmentChips.tsx` | 输入框上方附件芯片，横向滚动 |
| `TodoListCard.tsx` | Codex 的 plan/todo 工具产出展示 |
| `ThreadSidebar.tsx` | 多会话切换 |

#### 双击预览

ArtifactGrid 内每张缩略图绑定 `onDoubleClick` → 打开现有 `ImageViewer` 模块（已实现），传入当前消息内的所有图片作为序列，键盘 `←→` 切换，所有现有操作（下载、复制、重生成）一键复用。

### 数据流

```
User 输入 → AgentChatPanel.send()
  → IPC: agent:send_message { threadId, content, attachments }
    → AttachmentService 落地附件
    → AgentManager 注入应用上下文 (currentPage, selection)
    → WS RPC → codex app-server: turn/start { threadId, input: [...] }
      → Codex agent loop:
        ├─ item/reasoning/delta            → WS notification
        ├─ item/agentMessage/delta         → WS notification (流式文本)
        ├─ item/toolCall/start (catimation.generate_image)
        │  └─ MCP HTTP → CATIMATION MCP server
        │     └─ ApiService.generate() → R2 upload
        │     ← MCP response (image URI as resource)
        ├─ item/toolCall/end
        ├─ item/toolCall/start (catimation.batch_process) → task_id
        ├─ item/toolCall/start (catimation.query_task_status, 轮询)
        └─ turn/completed { turnId, status }
  → AgentManager 事件循环:
    → IPC broadcast → Renderer
    → Prisma persist (thread, message, tool_call, artifact)
  → Renderer Zustand store updates → 增量渲染
```

### 持久化 Schema

```prisma
model AgentThread {
  id           String           @id @default(cuid())
  title        String
  model        String
  systemPrompt String?          @db.Text
  createdAt    DateTime         @default(now())
  updatedAt    DateTime         @updatedAt
  messages     AgentMessage[]
  artifacts    AgentArtifact[]
  attachments  AgentAttachment[]
}

model AgentMessage {
  id          String          @id @default(cuid())
  threadId    String
  role        String           // user | assistant | system | tool
  contentJson Json
  createdAt   DateTime         @default(now())
  thread      AgentThread      @relation(fields: [threadId], references: [id], onDelete: Cascade)
  toolCalls   AgentToolCall[]

  @@index([threadId, createdAt])
}

model AgentToolCall {
  id           String       @id @default(cuid())
  messageId    String
  toolName     String
  paramsJson   Json
  resultJson   Json?
  status       String       // pending | running | success | error | cancelled
  durationMs   Int?
  createdAt    DateTime     @default(now())
  message      AgentMessage @relation(fields: [messageId], references: [id], onDelete: Cascade)
}

model AgentArtifact {
  id        String      @id @default(cuid())
  threadId  String
  messageId String?
  type      String      // image | file | link
  uri       String      // catimation://history/xxx | r2://... | file://...
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

迁移文件落到 `prisma/migrations/2026_05_06_agent_tables/migration.sql`，与 sora-ui-backend 共用 Prisma 工作流。

## 关键事件类型

事件名对齐 codex `app-server` JSON-RPC notifications，AgentManager 透传到 IPC。

| 事件 | 来源 | UI 反应 |
|------|------|--------|
| `item/reasoning/delta` | Codex WS notification | ReasoningPanel 流式追加 |
| `item/agentMessage/delta` | Codex WS notification | MessageBubble 流式追加文本 |
| `item/toolCall/start` | Codex WS notification | ToolCallCard 出现 spinner |
| `item/toolCall/end` | Codex WS notification | ToolCallCard 显示结果 |
| `turn/completed` | Codex WS notification | 当前 turn 收尾 |
| `artifact_created` | MCP server → 主进程 IPC | ArtifactGrid 添加缩略图 |
| `task_progress` | 异步任务（query_task_status 工具产出） | ToolCallCard 进度条更新 |
| `error` | 任意层 | ErrorBubble 显示，附 retry 按钮 |
| `cancelled` | 用户中断（`turn/cancel` RPC） | 标记当前 turn 为已中断 |

## 错误处理（4 层策略）

**Layer 1：Codex CLI 进程崩溃**
- AgentManager 监听 `exit` 事件 → 自动重启（最多 3 次）
- 重启失败 → ChatPanel 红色错误条 `[重试][查看日志]`
- 日志写入 `.logs/codex-cli-{date}.log`

**Layer 2：MCP tool 调用失败**
- ToolExecutor 包装每个 tool 实现，try/catch 后转成 MCP error response
- Agent 收到 error 自己决定重试还是换路（Codex 内置）
- error 持久化到 `AgentToolCall.resultJson`

**Layer 3：Service 层错误**
- 复用现有 `ErrorHandler`
- 网络错误指数退避，最多 3 次
- 业务错误（quota 不足等）直接返回给 agent

**Layer 4：用户中断**
- "停止"按钮 → IPC `agent:cancel` → WS RPC `turn/cancel { threadId }`
- Codex 优雅停止当前 turn，保留已完成 artifact（不杀进程，保持长连接）
- UI 显示"已中断"标记

## 资源限制

| 限制 | 默认值 |
|---|---|
| 单次 turn 超时 | 5 分钟（可配置） |
| 单文件附件 | 50 MB |
| 单次对话总附件 | 500 MB |
| 同 thread 并发 turn | 1 |
| 上传缓存保留 | 7 天 |

## Codex CLI 二进制打包

| 平台 | 二进制 | 大小 |
|------|--------|------|
| Windows x64 | `codex.exe` | ~22MB |
| macOS arm64 | `codex` | ~24MB |
| macOS x64 | `codex` | ~24MB |
| Linux x64 | `codex` | ~22MB |

**electron-builder 配置：**

```js
extraResources: [
  { from: "resources/codex/${platform}-${arch}", to: "codex/", filter: ["codex*"] },
  { from: "resources/skills", to: "skills/" },
  { from: "resources/mcp-config", to: "mcp-config/" }
]
```

**版本管理：**
- `package.json` 固定 `codexCliVersion: "0.128.0"`
- `scripts/fetch-codex.ts` 从 `2799662352/codex` GitHub Release 下载到 `resources/codex/`
- CI 缓存避免重复下载
- 启动时 `codex --version` 校验，不匹配警告

**首次启动：**
- 检查 `~/.codex/auth.json` → 不存在弹"用 ChatGPT 登录" / "API Key" 二选一
- 登录信息交给 Codex 管理，CATIMATION 不存

## 测试策略

| 层 | 工具 | 关键测试 |
|----|------|---------|
| 单元 | Vitest | AgentManager 进程生命周期 + WS JSON-RPC 编解码、McpServer 工具实现、AttachmentService、PGLiteSocketServer 启停 |
| 集成 | Vitest + 真实 Codex CLI | `codex app-server` 完整 thread/turn 链路、MCP 工具完整调用链、Prisma 在 PGlite + sora-postgres 双模式下持久化 |
| MCP 协议 | `@modelcontextprotocol/inspector` | 用 inspector 直连本地 HTTP server 验证 tools/resources（带 token header） |
| E2E | Playwright Electron | 完整流程：发消息→工具调用→渲染→双击预览→重生成 |
| 性能 | Vitest bench | 长对话 100+ 消息渲染 < 100ms / 工具启动延迟 < 200ms |
| 回归 | Visual Regression | AgentChatPanel 各状态截图对比 |

**关键测试用例：**
- Codex CLI 进程崩溃自动重启
- 工具调用超时被正确取消
- 大附件（48MB）上传不阻塞 UI
- 100 轮对话后 Postgres 查询性能仍 < 50ms
- MCP server HTTP 协议消息正确（用 inspector 录制 fixture，含鉴权）

## 项目结构改动

```
temp-ai-image-master-source/
├─ src/
│  ├─ main/
│  │  ├─ index.ts
│  │  ├─ updater.ts
│  │  ├─ agent/                     ← NEW
│  │  │  ├─ AgentManager.ts          # Codex CLI 进程管理
│  │  │  ├─ CodexLocalBackend.ts     # IAgentBackend 实现
│  │  │  ├─ AttachmentService.ts     # 文件上传
│  │  │  ├─ ThreadStore.ts           # Prisma 包装
│  │  │  ├─ db.ts                    # 连接策略 (Postgres / PGlite)
│  │  │  └─ types.ts
│  │  └─ mcp/                        ← NEW
│  │     ├─ server.ts                # MCP server 入口
│  │     ├─ transport.ts             # stdio/HTTP 切换
│  │     ├─ tools/
│  │     │  ├─ generate_image.ts
│  │     │  ├─ batch_process.ts
│  │     │  ├─ analyze_image.ts
│  │     │  ├─ compare_images.ts
│  │     │  ├─ director_storyboard.ts
│  │     │  ├─ query_history.ts
│  │     │  ├─ manage_templates.ts
│  │     │  ├─ navigate_page.ts
│  │     │  ├─ open_image_viewer.ts
│  │     │  └─ query_task_status.ts
│  │     └─ resources/
│  │        ├─ history.ts
│  │        ├─ template.ts
│  │        └─ upload.ts
│  └─ renderer/src/
│     └─ features/
│        └─ agent-chat/              ← NEW
│           ├─ AgentChatPanel.tsx
│           ├─ MessageBubble.tsx
│           ├─ ToolCallCard.tsx
│           ├─ ReasoningPanel.tsx
│           ├─ ArtifactGrid.tsx
│           ├─ MentionInput.tsx
│           ├─ AttachmentChips.tsx
│           ├─ TodoListCard.tsx
│           ├─ ThreadSidebar.tsx
│           └─ store.ts              # Zustand
├─ prisma/
│  ├─ schema.prisma                  # 加 5 个 Agent* 模型
│  └─ migrations/
│     └─ 2026_05_06_agent_tables/
├─ resources/                        ← NEW
│  ├─ codex/
│  │  ├─ win32-x64/codex.exe
│  │  ├─ darwin-arm64/codex
│  │  ├─ darwin-x64/codex
│  │  └─ linux-x64/codex
│  └─ skills/
│     └─ catimation-image-recipes/
├─ scripts/
│  └─ fetch-codex.ts                 ← NEW
└─ docs/
   └─ superpowers/
      ├─ specs/
      │  └─ 2026-05-06-codex-agent-integration-design.md  (this)
      └─ plans/                       (后续 writing-plans 产出)
```

## 开发节奏

| 阶段 | 预估 | 内容 |
|---|---|---|
| **M1：MCP server 骨架** | 3 天 | server 启动、HTTP localhost transport、token 鉴权、3 个核心 tool（generate / analyze / history） |
| **M2：AgentManager + Chat UI** | 4 天 | 进程管理、IPC、最小可用 ChatPanel（文本对话） |
| **M3：附件 + 多图 + 预览** | 3 天 | 文件上传、引用、双击预览、artifact 渲染 |
| **M4：完整工具集** | 3 天 | batch / director / template / navigate 等剩余工具 |
| **M5：持久化 + 多会话** | 2 天 | Prisma + PGlite、会话切换、历史恢复 |
| **M6：打包 + 二进制管理** | 2 天 | electron-builder、Codex 下载脚本、CI |
| **M7：测试 + 文档** | 3 天 | E2E、性能、用户文档 |
| **总计** | **~20 天** | 单人节奏 |

## FastAPI + FastMCP Hybrid Extension（后续扩展）

FastAPI + FastMCP 不替换本地 MVP 主链路。它作为后续扩展层，用来承接 Python AI pipeline、平台远程工具、sora-ai-backend 能力复用。

### 为什么不放在本地 MVP 主链路

CATIMATION 的核心业务能力在 Electron 主进程内：`ServiceRegistry`、`appServices`、`ApiService`、`HistoryDataService`、页面导航与 ImageViewer 反控。如果本地核心 MCP server 改成 Python FastMCP，需要再加一层桥：

```
Codex
  → FastMCP Python sidecar
    → HTTP / IPC bridge
      → Electron Main
        → ServiceRegistry / ApiService
```

这会引入额外的 Python runtime / venv / 依赖打包、跨进程生命周期、日志与错误传播复杂度。对本地桌面 MVP 来说，TS MCP server 直接跑在 Electron 主进程内更短、更稳：

```
Codex
  → TS MCP in Electron Main
    → ServiceRegistry / ApiService
```

### FastAPI + FastMCP 适合的边界

| 场景 | 是否适合 FastAPI + FastMCP | 理由 |
|---|---|---|
| 直接调 CATIMATION 内存态服务 | 不适合 | 需要访问 Electron 主进程对象，Python 只能绕桥 |
| 本地聊天面板 MVP | 不适合 | 增加第三类进程（Node/Electron + Codex + Python） |
| sora-ai-backend 的 Python AI 能力 | 适合 | FastAPI / LangChain / Python 模型生态已存在 |
| OCR、CV、embedding、RAG、LangGraph pipeline | 适合 | Python 工具链更成熟 |
| 平台模式远程 MCP tools | 适合 | 可通过 HTTP transport 暴露给 codex-gateway / sora 平台 |
| 多服务统一审计、限流、鉴权 | 适合 | FastAPI 中间件体系更适合平台治理 |

### 后续形态

后续平台增强可以新增一个 `catimation-python-tools` 服务：

```text
sora platform / codex-gateway
  → FastAPI + FastMCP (/mcp)
    ├─ cv.analyze_image
    ├─ ocr.extract_text
    ├─ rag.search_project_knowledge
    ├─ langgraph.run_director_pipeline
    └─ sora_ai_backend.invoke_workflow
```

本地 CATIMATION 也可以选择性启动 Python sidecar，但只用于重 Python 工具，不承担核心 CATIMATION 工具注册：

```text
Electron Main TS MCP
  ├─ native CATIMATION tools（本地 MVP 主链路）
  └─ proxy_python_tool → FastMCP sidecar（可选）
```

### 实施原则

- **本地 MVP**：只实现 Electron 主进程 TS MCP server，确保安装包和运行链路可控。
- **Python-heavy tools**：后续用 FastAPI + FastMCP 承接，不把 Python 引入 MVP 阻塞路径。
- **平台模式**：FastMCP 服务优先部署在 sora-ai-backend / codex-gateway 旁边，而不是塞进桌面应用。
- **统一协议**：无论 TS MCP 还是 FastMCP，都对外暴露 MCP HTTP transport，Codex 只认 MCP tools，不关心底层语言。

## 后续 Backlog（不在本 spec）

- **方案 A 联网通道**：实现 `CodexGatewayBackend implements IAgentBackend`，连接 codex-gateway WebSocket
- **MCP server 对外暴露**：把 HTTP transport 从 `127.0.0.1` 改为 `0.0.0.0` + 强鉴权，让 Cursor / Claude Desktop 等远程客户端也能用 CATIMATION 工具
- **FastAPI + FastMCP 扩展层**：为 Python AI pipeline / sora-ai-backend 能力新增远程 MCP tools，不进入本地 MVP 主链路
- **并行多 agent**：多 thread 同时跑，画布式管理
- **嵌入式浏览器**：让 agent 能可视化操作 web 页面
- **语音输入**：whisper.cpp 本地语音识别

## 风险

| 风险 | 缓解 |
|---|---|
| Codex `app-server` 仍标记 [experimental]，协议字段可能变更 | 启动时 `codex --version` + 协议握手校验，锁定 fork commit；每次升级走 PR review |
| MCP SDK v1.x 拆包后客户端/服务端版本不齐 | `package.json` 同时锁 `@modelcontextprotocol/server` `@modelcontextprotocol/node` `@modelcontextprotocol/express` 版本，CI 跑 inspector fixture |
| PGlite 是 WASM **单进程** —— 多 Electron window 不能共享同一实例 | 所有 DB 访问统一经主进程，渲染进程通过 IPC 调用；架构层强制约束 |
| PGlite 性能极限（十万级消息） | 监控查询时间，超阈值提示用户切到 sora-postgres |
| Codex 二进制体积让安装包变大 | 安装包 ~80MB → ~110MB，可接受（同类 IDE 都更大） |
| 用户 ChatGPT 账户 token 失效 | UI 检测到 401 → 弹重新登录 |
