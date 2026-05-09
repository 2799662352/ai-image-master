# MCP Cursor-Style JSON UI 设计

## Summary

用 Codex app-server 内置的 JSON-RPC API 替换当前的 TOML 手工文件操作，重建 MCP 管理 UI 为 Cursor 风格的卡片列表 + Monaco JSON 编辑器。UI 全中文。支持从 Cursor `mcp.json` 批量粘贴导入（预览 + 勾选）。实时状态通过 Codex 原生通知推送，无需自建监控守护进程。

**本 spec 替代** `2026-05-09-codex-workspace-settings-extensibility-design.md` 中 MCP 相关部分的设计。Skills CRUD 和其他 workspace 功能保持原 spec 不变。

## 已验证的 Codex 能力（源码依据）

| 能力 | RPC 方法 | 来源 |
|------|---------|------|
| 列出 server + tools + auth + resources | `mcpServerStatus/list` | `codex-rs/app-server/README.md:224` |
| 实时状态推送 (starting/ready/failed/cancelled) | `mcpServer/startupStatus/updated` (notify) | README.md:1737 |
| 原子批量写配置 | `config/batchWrite` | README.md:233 |
| 单值写 | `config/value/write` | README.md:232 |
| 读有效配置 | `config/read` | README.md:229 |
| 热重载 MCP | `config/mcpServer/reload` | README.md:223 |
| OAuth 登录 | `mcpServer/oauth/login` → `mcpServer/oauthLogin/completed` | README.md:221, 1736 |
| 调用工具 | `mcpServer/tool/call` | README.md:226 |
| 读 resource | `mcpServer/resource/read` | README.md:225 |

### MCP Server 完整配置 Schema（`developers.openai.com/codex/config-reference`）

**stdio 类型：**
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `command` | string | ✓ | 启动命令 |
| `args` | string[] | | 参数列表 |
| `env` | map<string,string> | | 环境变量 |
| `env_vars` | array | | 额外白名单环境变量 |
| `cwd` | string | | 工作目录 |

**HTTP/URL 类型：**
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `url` | string | ✓ | Streamable HTTP 端点 |
| `bearer_token_env_var` | string | | Bearer token 环境变量名 |
| `http_headers` | map<string,string> | | 静态 HTTP 头 |
| `env_http_headers` | map<string,string> | | 从环境变量填充的 HTTP 头 |

**通用字段（两种类型共享）：**
| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `enabled` | boolean | true | 启用/禁用 |
| `required` | boolean | false | 必须成功初始化 |
| `startup_timeout_sec` | number | 10 | 启动超时 |
| `startup_timeout_ms` | number | | 同上(毫秒) |
| `tool_timeout_sec` | number | 60 | 单工具调用超时 |
| `enabled_tools` | string[] | | 工具白名单 |
| `disabled_tools` | string[] | | 工具黑名单(在白名单之后) |
| `scopes` | string[] | | OAuth scopes |
| `oauth_resource` | string | | RFC 8707 resource 参数 |
| `experimental_environment` | "local"\|"remote" | local | 运行环境 |

### Cursor `mcp.json` Schema（用户 `~/.cursor/mcp.json`）

```jsonc
{
  "mcpServers": {
    "<name>": {
      // stdio
      "command": "string",
      "args": ["string"],
      "env": { "KEY": "VALUE" },
      // OR url-based
      "url": "string",
      "headers": { "Authorization": "Bearer xxx" }
    }
  }
}
```

**映射关系（Cursor → Codex TOML）：**
| Cursor 字段 | Codex 字段 |
|-------------|-----------|
| `command` | `command` |
| `args` | `args` |
| `env` | `env` |
| `url` | `url` |
| `headers` | `http_headers` |

## Problem Frame

当前 `McpEditor.tsx` 存在以下问题：
1. 只支持 stdio 类型，无法配置 HTTP/URL 类型 server
2. 使用 TOML 字段表单，用户看不到原始配置
3. 无法批量导入，每次只能编辑一个
4. 看不到运行状态（connected/error/工具数量）
5. 看不到 server 提供的工具列表
6. 无 per-tool 启用/禁用控制
7. 无 OAuth 登录流程
8. 直接操作文件——与 Codex 运行时可能冲突

## 设计目标

1. **视觉对齐 Cursor**：参照截图中的卡片布局（状态点 + 图标 + 名称 + 命令 + 工具 chips 网格 + 开关）
2. **数据流全走 RPC**：不直接读写 config.toml，通过 `CodexProtocolClient` 调 app-server
3. **JSON 编辑器**：使用 Monaco Editor 带 Codex 官方 JSON Schema 校验
4. **批量导入**：粘贴 Cursor JSON → 预览表 + 勾选 → 一发 `config/batchWrite`
5. **实时状态**：订阅 `mcpServer/startupStatus/updated` 通知，UI 即时反映
6. **per-tool 控制**：chip 右键菜单禁用单个工具
7. **全中文**：所有标签、按钮、提示用中文

## Architecture

### 数据流

```
┌─────────────────┐     WebSocket JSON-RPC      ┌─────────────────────┐
│  Renderer        │ ◀─────────────────────────▶ │  codex app-server    │
│  (React UI)      │         via IPC             │  (Rust binary)       │
│                  │                              │                      │
│  McpListPage     │─── listMcpServers() ───────▶│  mcpServerStatus/list│
│  (卡片列表)       │◀── startupStatus notify ───│  startup push        │
│                  │                              │                      │
│  McpJsonEditor   │─── batchWriteConfig() ─────▶│  config/batchWrite   │
│  (Monaco)        │─── reloadMcpServers() ─────▶│  config/mcpServer/   │
│                  │                              │     reload           │
│  BulkImportModal │─── batchWriteConfig() ─────▶│                      │
│  (预览+勾选)      │                              │                      │
│                  │                              │                      │
│  ToolChip       │─── writeConfigValue() ──────▶│  config/value/write  │
│  (右键禁用)       │                              │                      │
│                  │                              │                      │
│  OAuthButton    │─── mcpOAuthLogin() ─────────▶│  mcpServer/oauth/    │
│                  │◀── oauthCompleted notify ───│     login            │
└─────────────────┘                              └─────────────────────┘
```

### Electron IPC 层

在 `CodexProtocolClient.ts` 新增以下公开方法（复用现有 `this.rpc<T>()` 模式）：

```typescript
// 新增 MCP 管理方法
async listMcpServers(params?: { detail?: string; limit?: number; cursor?: string }): Promise<McpServerStatusList> {
  return this.rpc<McpServerStatusList>('mcpServerStatus/list', params ?? { detail: 'full' })
}

async batchWriteConfig(edits: ConfigEdit[], reloadUserConfig?: boolean): Promise<void> {
  await this.rpc('config/batchWrite', { edits, reloadUserConfig: reloadUserConfig ?? true })
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

async mcpOAuthLogin(name: string): Promise<{ authorization_url: string }> {
  return this.rpc('mcpServer/oauth/login', { name })
}

async mcpToolCall(params: { threadId?: string; server: string; tool: string; arguments?: unknown }): Promise<unknown> {
  return this.rpc('mcpServer/tool/call', params)
}
```

新增通知监听（在 `handleRaw` 中路由）：

```typescript
// mcpServer/startupStatus/updated → emit 到 renderer
// mcpServer/oauthLogin/completed  → emit 到 renderer
```

### Renderer 暴露的 IPC Bridge

```typescript
// preload 暴露
electronAPI.agent.listMcpServers()
electronAPI.agent.batchWriteConfig(edits, reload?)
electronAPI.agent.writeConfigValue(keyPath, value)
electronAPI.agent.readConfig()
electronAPI.agent.reloadMcpServers()
electronAPI.agent.mcpOAuthLogin(name)
electronAPI.agent.onMcpStatusUpdate(callback)
electronAPI.agent.onMcpOAuthCompleted(callback)
```

## UI Components

### 1. MCP 卡片列表（McpServerList）

替换当前 `McpSection.tsx`。

```
┌─────────────────────────────────────────────────────────────────┐
│  MCP 服务器                                    [+ 新增] [导入]    │
├─────────────────────────────────────────────────────────────────┤
│ 🟢  G  github                                    ✏️  🗑️  ──●    │
│     docker run -i --rm -e GITHUB_PERSONAL_ACCESS...             │
│     ┌────────┐ ┌────────────┐ ┌──────────────┐ ┌─────┐         │
│     │ add_comment_to_pending_review │ add_issue_comment │ ...   │
│     └────────┘ └────────────┘ └──────────────┘ └─────┘         │
├─────────────────────────────────────────────────────────────────┤
│ 🟡  context7                                     ✏️  🗑️  ──●    │
│     npx -y @upstash/context7-mcp@latest                        │
│     ┌───────────────────┐ ┌────────────┐                       │
│     │ resolve-library-id │ │ query-docs │                       │
│     └───────────────────┘ └────────────┘                       │
├─────────────────────────────────────────────────────────────────┤
│ 🔴  my-broken-server                             ✏️  🗑️  ○──    │
│     node /path/to/broken.js                                     │
│     ❌ Error: spawn ENOENT (点击查看详情)                          │
└─────────────────────────────────────────────────────────────────┘
```

**卡片元素：**
- 状态点：🟢 ready / 🟡 starting / 🔴 failed / ⚫ disabled or cancelled
- 图标：取名称首字母（大写），背景色 hash 自动生成
- 名称：`font-mono font-bold`
- 命令/URL：`font-mono text-xs text-zinc-400` 单行截断
- 工具 chips 网格：`flex flex-wrap gap-1`，每个 chip `px-2 py-0.5 rounded bg-zinc-800 text-xs`
- 操作按钮：编辑（✏️）/ 删除（🗑️）/ 启用开关
- chip hover tooltip：工具描述 + 参数列表

**chip 右键菜单（per-tool 控制）：**
```
┌──────────────────────────┐
│ 禁用 "search_code"        │
│ ─────────────────────────│
│ 查看参数                   │
│ 复制工具名                 │
└──────────────────────────┘
```
禁用后写入 `disabled_tools` 数组（`config/value/write`），chip 变灰 + 删除线。

### 2. MCP JSON 编辑器（McpJsonEditor）

点击 [+ 新增] 或 ✏️ 按钮打开。取代当前 `McpEditor.tsx`。

**布局：**
```
┌─────────────────────────────────────────────────────────┐
│  编辑 MCP 服务器: github                    [保存] [取消] │
├───────┬─────────────────────────────────────────────────┤
│ JSON  │  {                                              │
│ ─── ─│    "command": "docker",                          │
│ 可视化│    "args": ["run", "-i", "--rm", ...],           │
│       │    "env": {                                     │
│       │      "GITHUB_PERSONAL_ACCESS_TOKEN": "..."      │
│       │    },                                           │
│       │    "enabled": true,                             │
│       │    "startup_timeout_sec": 15,                   │
│       │    "enabled_tools": null,                       │
│       │    "disabled_tools": ["fork_repository"]        │
│       │  }                                              │
├───────┴─────────────────────────────────────────────────┤
│  ⚠️ 检测到高风险参数: --privileged                         │
└─────────────────────────────────────────────────────────┘
```

**Monaco 配置：**
- 语言: `json`
- Schema: 内嵌简化版 Codex MCP schema（基于 `developers.openai.com/codex/config-schema.json`）
- 主题: `vs-dark` 定制（匹配项目 zinc/cyan 色调）
- 高度: 自适应内容，最大 400px
- 字体: JetBrains Mono（与项目一致）

**「可视化」tab（简化表单模式）：**
- 类型选择：[stdio] / [HTTP]
- stdio: command / args / env 三字段
- HTTP: url / headers 两字段
- 高级选项（折叠态）：enabled / required / startup_timeout / tool_timeout / enabled_tools / disabled_tools / scopes

### 3. 批量导入模态框（BulkImportModal）

点击 [导入] 按钮触发。

**Step 1：粘贴 JSON**
```
┌─────────────────────────────────────────────────────────┐
│  批量导入 MCP 服务器                              [×]    │
├─────────────────────────────────────────────────────────┤
│  粘贴 Cursor 格式的 mcpServers JSON:                     │
│  ┌───────────────────────────────────────────────────┐  │
│  │ {                                                 │  │
│  │   "mcpServers": {                                 │  │
│  │     "github": { ... },                            │  │
│  │     "context7": { ... }                           │  │
│  │   }                                               │  │
│  │ }                                                 │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  或者: [从 Cursor 配置导入 (~/.cursor/mcp.json)]          │
│                                                         │
│                              [下一步 →]                  │
└─────────────────────────────────────────────────────────┘
```

**Step 2：预览 + 勾选**
```
┌─────────────────────────────────────────────────────────┐
│  检测到 17 个 MCP 服务器            [全选] [全不选]        │
├─────────────────────────────────────────────────────────┤
│  ☑ github          stdio   docker run -i --rm ...       │
│  ☑ context7        stdio   npx -y @upstash/...          │
│  ☑ browse          stdio   npx -y @anthropic...         │
│  ☐ old-broken      stdio   /usr/local/bin/old...  ⚠️     │
│  ☑ supabase        url     https://mcp.supabase...      │
│  ...                                                    │
├─────────────────────────────────────────────────────────┤
│  ⚠️ 已存在同名: github, context7 (将覆盖)                 │
│                                                         │
│                    [取消]  [导入选中 (15)]                │
└─────────────────────────────────────────────────────────┘
```

**导入逻辑：**
1. 解析粘贴内容（支持 `{ "mcpServers": {...} }` 或裸 `{ "name": {...} }`）
2. 每个 entry 转换为 Codex schema（`headers` → `http_headers`）
3. 用户勾选后，构造 `config/batchWrite` payload：
   ```json
   {
     "edits": [
       { "keyPath": "mcp_servers.github", "value": { "command": "docker", ... } },
       { "keyPath": "mcp_servers.context7", "value": { "command": "npx", ... } }
     ],
     "reloadUserConfig": true
   }
   ```
4. 一次 RPC 调用完成所有导入 + 热重载

### 4. OAuth 登录按钮

HTTP 类型 server 在卡片上显示「登录」按钮（当 auth status 为 unauthorized 时）。

**流程：**
1. 用户点击「登录」
2. 调 `mcpServer/oauth/login` → 返回 `authorization_url`
3. 打开系统浏览器到该 URL
4. 监听 `mcpServer/oauthLogin/completed` 通知
5. 成功：刷新卡片状态；失败：显示错误

## State Management

新增 Zustand store: `useMcpStore.ts`

```typescript
interface McpServerCard {
  name: string
  type: 'stdio' | 'http'
  command?: string       // stdio
  url?: string           // http
  args?: string[]
  enabled: boolean
  status: 'starting' | 'ready' | 'failed' | 'cancelled' | 'unknown'
  error?: string | null
  tools: Array<{ name: string; description?: string; disabled?: boolean }>
  resources?: Array<{ uri: string; name?: string }>
  authStatus?: 'authorized' | 'unauthorized' | 'unknown'
}

interface McpStore {
  servers: McpServerCard[]
  loading: boolean
  error: string | null
  
  // actions
  fetchServers: () => Promise<void>
  updateStatus: (name: string, status: string, error?: string) => void
  toggleEnabled: (name: string, enabled: boolean) => Promise<void>
  deleteServer: (name: string) => Promise<void>
  disableTool: (serverName: string, toolName: string) => Promise<void>
  enableTool: (serverName: string, toolName: string) => Promise<void>
  importServers: (entries: ImportEntry[]) => Promise<void>
  startOAuth: (name: string) => Promise<void>
}
```

## 新增依赖

| 包名 | 版本 | 用途 | 大小影响 |
|------|------|------|---------|
| `@monaco-editor/react` | latest | React Monaco 封装 | ~2.5MB (CDN worker 分离) |
| `monaco-editor` | latest | 核心编辑器 | 与上面配套 |

Monaco workers 使用 Vite 的 `?worker` 导入或 CDN fallback 加载，不打入主 bundle。

## 文件变更清单

### 新增文件
| 路径 | 职责 |
|------|------|
| `src/renderer/src/features/agent-workspace/McpServerList.tsx` | 卡片列表主组件 |
| `src/renderer/src/features/agent-workspace/McpServerCard.tsx` | 单张卡片组件 |
| `src/renderer/src/features/agent-workspace/McpJsonEditor.tsx` | Monaco JSON 编辑器 |
| `src/renderer/src/features/agent-workspace/BulkImportModal.tsx` | 批量导入模态框 |
| `src/renderer/src/features/agent-workspace/ToolChip.tsx` | 工具 chip + 右键菜单 |
| `src/renderer/src/features/agent-workspace/useMcpStore.ts` | Zustand MCP 状态管理 |
| `src/renderer/src/features/agent-workspace/mcpSchemaJson.ts` | 内嵌 Monaco JSON schema |
| `src/renderer/src/features/agent-workspace/__tests__/useMcpStore.test.ts` | store 单测 |
| `src/renderer/src/features/agent-workspace/__tests__/BulkImportModal.test.ts` | 导入逻辑单测 |
| `src/renderer/src/features/agent-workspace/__tests__/McpServerList.test.tsx` | 列表渲染单测 |

### 修改文件
| 路径 | 变更说明 |
|------|---------|
| `src/main/agent/CodexProtocolClient.ts` | 新增 7 个 MCP RPC 方法 + 2 个通知路由 |
| `src/main/agent/AgentManager.ts` | 暴露 MCP IPC handlers 到 preload |
| `src/renderer/src/features/agent-workspace/McpSection.tsx` | 替换内容为 `<McpServerList />` |
| `package.json` | 添加 `@monaco-editor/react` + `monaco-editor` |

### 删除/废弃文件
| 路径 | 说明 |
|------|------|
| `src/renderer/src/features/agent-workspace/McpEditor.tsx` | 被 `McpJsonEditor.tsx` 替代 |
| `src/main/agent/codexConfigStore.ts` (MCP 部分) | 文件操作被 RPC 替代，仅保留 Skills 部分 |

## 内置 MCP Server 处理

Codex 运行时会注册合成内置 server（如 Memories MCP，PR #21356）。`mcpServerStatus/list` 会返回这些条目。

**UI 规则：**
- 内置 server 卡片带「内置」标签（灰色 badge）
- 不显示编辑/删除按钮
- 启用开关仍可操作（通过 `config/value/write` 设置 `enabled = false`）
- 判断依据：`mcpServerStatus/list` 返回的 server 在 `config/read` 的 `mcp_servers` 表中不存在 → 标记为内置

## OAuth 按钮显示条件

`McpAuthStatus` 枚举值（来自 `codex-rs/app-server-protocol/src/protocol/v2/mcp.rs`）：
- `Unsupported` — 不显示 OAuth 按钮
- `NotLoggedIn` — 显示「登录」按钮
- `BearerToken` — 显示「已认证 (Token)」标签
- `OAuth` — 显示「已登录」标签 + 「登出」按钮（未来支持）

## 安全考虑

1. **环境变量不在 UI 展示完整值**：`env` 字段中的 value 显示为 `***`（masked），仅编辑时可见
2. **高风险命令检测**：保留现有 `RISKY_PATTERNS`（`--privileged`, `sudo`, `rm -rf /` 等），在卡片和编辑器中显示黄色警告
3. **OAuth token 不经过 renderer**：`mcpServer/oauth/login` 直接打开系统浏览器，token 回调在 app-server 内部处理
4. **批量导入确认**：用户必须在预览步骤勾选才能导入，默认不全选已存在同名的

## 异常恢复（Codex 进程崩溃时）

Codex app-server 作为子进程随 Electron 主进程启动（`CodexLocalBackend.ts`），二进制打包在发行版内。正常情况下不存在"Codex 未启动"状态。

唯一可能断连的场景：**Codex 进程崩溃 / OOM 被系统杀死**。此时：
1. `CodexLocalBackend` 已有 crash-restart 逻辑（检测 WebSocket close → 自动重启子进程）
2. MCP UI 在 WebSocket 断连期间显示 inline 提示条：「正在重连 Codex...」（非阻塞，不弹模态框）
3. 重连成功后自动调 `mcpServerStatus/list` 刷新卡片列表
4. 期间用户的编辑操作正常进行（JSON 编辑器是纯前端），保存时若 RPC 失败则 toast 提示「保存失败，Codex 重连中」+ 自动重试队列（最多 3 次，间隔 2s）

## 性能考虑

1. **Monaco 懒加载**：编辑器组件使用 `React.lazy()` + `Suspense`，仅在用户点击编辑时加载
2. **卡片虚拟化**：当 server 数量 > 20 时使用 `react-window` 虚拟滚动（暂定不装，先用原生渲染）
3. **状态通知防抖**：`mcpServer/startupStatus/updated` 可能高频触发，store 内 debounce 100ms 批量更新
4. **工具列表分页**：对于工具数 > 50 的 server，chip 区域默认折叠显示前 20 + "展开更多"

## 测试策略

1. **useMcpStore 单测**：mock RPC 调用，验证 store 状态转换
2. **BulkImportModal 单测**：验证 JSON 解析、Cursor→Codex 字段映射、冲突检测
3. **McpServerList 渲染测试**：给定 store 状态，验证卡片渲染、状态点颜色、工具数量
4. **CodexProtocolClient 集成测试**：mock WebSocket，验证新 RPC 方法的请求/响应格式
5. **右键菜单测试**：验证 disable/enable tool 写入正确 keyPath

## 实现优先级

| Phase | 内容 | 依赖 |
|-------|------|------|
| P1 | CodexProtocolClient 扩展 + IPC bridge | 无 |
| P2 | useMcpStore + McpServerList + McpServerCard | P1 |
| P3 | McpJsonEditor (Monaco) + 新增/编辑流程 | P1, P2 |
| P4 | BulkImportModal (粘贴 + Cursor 导入) | P1, P2 |
| P5 | ToolChip 右键菜单 + per-tool 控制 | P2 |
| P6 | OAuth 登录流程 | P1 |
| P7 | 状态实时推送 + 错误详情 | P1, P2 |

## 与现有 Spec 的关系

- **替代** `2026-05-09-codex-workspace-settings-extensibility-design.md` 的 MCP CRUD 设计
- **保留** 该 spec 的 Skills CRUD、Permissions 面板、Agent Workspace 导航结构
- **废弃** `codexConfigStore.ts` 中的 `listMcpServers` / `getMcpDetail` / `saveMcp` / `deleteMcp` 文件操作函数（保留 Skills 相关函数）
- **兼容** `2026-05-06-codex-agent-integration-design.md` 的 `CodexProtocolClient` 架构

## 视觉参考

- Cursor MCP 设置页截图：`assets/c__Users_27996_AppData_Roaming_Cursor_User_workspaceStorage_empty-window_images_image-8b61b317-df75-479d-875a-47ab058d4257.png`
- 设计要点：卡片首字母头像 + 状态点 + 命令预览 + 工具 chips 网格 + 行级操作按钮
