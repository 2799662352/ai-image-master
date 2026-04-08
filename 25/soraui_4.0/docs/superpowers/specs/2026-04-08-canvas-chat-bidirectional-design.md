# Canvas ↔ Chat 双向联动 + Agent 任务状态可视化 — 设计文档

> 日期: 2026-04-08
> 状态: Draft
> 范围: Sub-project 1 of "OiiOii 逆向 + Codex 集成"

---

## 1. 目标

将 sora-ui 的 Canvas ↔ Chat 交互从**单向推送**（Chat → Canvas）升级为**双向联动**（Canvas ↔ Chat），同时补全 **Agent 任务状态可视化**。

### 1.1 成功标准

- 用户在 Canvas 上右键任意 Shape，可触发 Agent 操作（重新生成、高清增强、生成视频、提取角色、发送到聊天）
- Agent 执行任务时，底部 AsyncTaskBar 实时展示进度（agent 名 + 工具名 + 状态 + 预览缩略图）
- 每个 Shape 内部支持交互按钮（删除、下载、重新生成），无需先右键
- 所有改动与现有 LangGraph 工作流和 Redis Pub/Sub 兼容

---

## 2. 逆向发现：OiiOii.ai 的交互模型

### 2.1 OiiOii 技术栈确认

| 组件 | OiiOii 使用 | 证据 |
|------|------------|------|
| Canvas | tldraw 3.15.4 | `cdn.tldraw.com/3.15.4/translations/zh-cn.json` |
| Shape 前缀 | `hogi-*` | DOM class: `hogi-shape-selection-badge`, `hogi-shape-selectable-icon` |
| 工具栏 | 自定义 overlay | `hogi-opt-toolbar`, `hogi-frame-toolbar`, `hogi-nav-toolbar` |
| 后端 | Supabase Auth + 自建 API | `spb.oiioii.ai/auth/v1/user`, `api.oiioii.ai/*` |

### 2.2 OiiOii API 端点清单

**核心 Canvas/Agent APIs：**

| 端点 | 用途 |
|------|------|
| `workspace/get_workspace` | 获取工作区（含 canvas document） |
| `workspace/check_user_workspace` | 用户权限检查 |
| `media/canvas_async_tasks/sync` | Canvas 异步任务同步（?workspaceId=...） |
| `chat/conversation_item` | 获取对话项 |
| `chat_sa_v2/get_message_from_ids` | 按 ID 批量获取消息 |
| `agent_sa_v2/submit_message_to_agent` | 提交消息给 Agent（核心 Agent 入口） |
| `film/get_film` | 获取影片数据 |
| `knowledge/style_assets` | 风格素材库 |
| `knowledge/style_assets/types/enums` | 风格素材类型枚举 |
| `style/user_style_history/list` | 用户风格历史 |
| `style/user_uploaded_styles/list` | 用户上传的风格 |
| `points/mcp_model_pricings` | MCP 模型定价 |

**关键发现：`media/canvas_async_tasks/sync`**

这是 Canvas ↔ Agent 异步任务同步的专用端点。OiiOii 用它实现：
- 前端轮询任务状态
- 任务完成后自动更新 Canvas shape
- 这正是我们需要的 G1（Agent 任务状态可视化）的核心机制

### 2.3 OiiOii Canvas 交互模式

通过浏览器观察和 DOM 分析，OiiOii 的 Canvas 交互包括：

**Shape 级别交互：**
1. **选择徽章** (`hogi-shape-selection-badge`) — shape 被选中时显示勾选图标
2. **可选择图标** (`hogi-shape-selectable-icon`) — 支持多选模式
3. **内嵌交互按钮** — shape 内部的操作按钮（通过 tldraw `pointerEvents: 'all'` + `stopPropagation` 实现）

**工具栏级别交互：**
1. **操作工具栏** (`hogi-opt-toolbar`) — 选择/手型工具、缩放
2. **画板工具栏** (`hogi-frame-toolbar`) — 添加画板、多选
3. **导航工具栏** (`hogi-nav-toolbar`) — "总览" / "图片/视频" 标签切换

**Canvas → Agent 触发（反向联动）：**
- `agent_sa_v2/submit_message_to_agent` — Shape 操作触发 Agent 任务

---

## 3. 当前 sora-ui 现状盘点

### 3.1 已有组件

| 组件 | 文件 | 状态 |
|------|------|------|
| CanvasContextMenu | `canvas/CanvasContextMenu.tsx` | **UI 完整，处理函数为空** |
| 右键菜单状态 | `SpacePage.tsx:249-250` | 已声明 `contextMenu` state |
| 右键事件绑定 | `SpacePage.tsx:1026-1031` | 已绑定到 canvas div |
| 菜单渲染 | `SpacePage.tsx:1170-1182` | 已渲染，`onAction` 是 TODO |
| Agent streaming 指示器 | `SpacePage.tsx:1147-1162` | 右上角黄色脉冲点 |
| AsyncTaskBar import | `SpacePage.tsx:17` | **import 存在但文件不存在** |
| asyncTaskStore import | `SpacePage.tsx:18` | **import 存在但文件不存在** |
| Canvas 自动保存 | `SpacePage.tsx:1078-1126` | 3s throttle, 自动持久化 |
| Canvas awareness | `SpacePage.tsx:1044-1064` | Agent 可读取 canvas 摘要 |
| HandOffCard | `ChatPanel/HandOffCard.tsx` | 完整的 handoff 渲染 |
| RoleLayer | `RoleLayer/RoleLayer.tsx` | Agent 头像标签 |
| Redis Pub/Sub | `pubsub.py` | `publish_agent_event` 支持 4 种事件类型 |
| LangGraph workflow | `story_anime.py` | 7 Agent + `handoff_to_agent` |

### 3.2 菜单定义（已有 8 个操作）

```typescript
// canvas/CanvasContextMenu.tsx MENU_ITEMS
regenerate       // 重新生成
hd_enhance       // 高清增强
generate_video   // 生成视频
extract_character // 提取角色
add_to_chat      // 添加到聊天
download         // 下载
copy             // 复制到剪贴板
delete           // 删除
```

### 3.3 缺失组件

| 组件 | 描述 |
|------|------|
| `asyncTaskStore.ts` | Zustand store — 监听 SSE 事件维护 Agent 任务列表 |
| `AsyncTaskBar.tsx` | 底部浮层 — 展示 agent 任务进度 |
| ContextMenu → Agent 分发 | `SpacePage onAction` 处理函数 |
| Shape 内嵌操作按钮 | 各 ShapeUtil 的 `component()` 中的交互按钮 |
| 后端 agent 状态事件 | `make_agent_node` 中的状态发布调用 |

---

## 4. 模块设计

### 模块 M1: asyncTaskStore — Agent 任务状态管理

**文件**: `src/stores/asyncTaskStore.ts`

**职责**: 监听 SSE 中的 agent 任务事件，维护任务列表，提供 UI 绑定。

```typescript
interface AgentTask {
  id: string;
  agentKey: string;           // ART_DIRECTOR, CHARACTER_DESIGNER, ...
  agentNameZh: string;        // 艺术总监, 角色设计师, ...
  status: 'pending' | 'running' | 'completed' | 'error';
  toolName?: string;          // generate_image, generate_video, ...
  toolNameZh?: string;        // 生成图片, 生成视频, ...
  previewUrl?: string;        // 缩略图预览
  shapeId?: string;           // 关联的 canvas shape ID
  progress?: number;          // 0-100 百分比（如有）
  error?: string;
  startedAt: number;
  completedAt?: number;
}

interface AsyncTaskState {
  tasks: AgentTask[];
  addTask(task: AgentTask): void;
  updateTask(id: string, patch: Partial<AgentTask>): void;
  removeTask(id: string): void;
  getTasksByShape(shapeId: string): AgentTask[];
}
```

**数据源**: 前端 SSE listener（已有的 `chatManager.ts` 或 `useMsgStore` 中的 SSE 连接）中增加对以下事件的处理：
- `agent_started` → `addTask`
- `tool_started` → `updateTask` (status: running, toolName)
- `tool_completed` → `updateTask` (status: completed, previewUrl)
- `agent_error` → `updateTask` (status: error)

**自动清理**: 任务完成 30s 后自动淡出并移除。

---

### 模块 M2: AsyncTaskBar — 底部任务进度条

**文件**: `src/components/AsyncTaskBar.tsx`

**职责**: 在 Canvas 底部显示浮动进度条，每个任务一行。

**UI 规格**:
- 位置: Canvas 区域底部, 居中浮动, z-index 30
- 宽度: max 480px, 自适应
- 每个任务项: Agent 色点 + Agent 名 + 工具名 + 状态动画 + 预览缩略图
- 状态动画: pending=脉冲, running=旋转, completed=勾号淡出, error=红色叹号
- 交互: 点击任务可 pan 画布到对应 shape（如果有 shapeId）
- 主题: 暗色毛玻璃 (rgba(26,29,32,0.85) + backdropFilter blur(8px))

**依赖**:
- `asyncTaskStore` (读取 tasks)
- `HandOffCard` 的 `getAgentRole` / `getAgentColor` (颜色复用)

---

### 模块 M3: CanvasContextMenu Action Dispatcher — 右键菜单动作分发

**文件**: `src/pages/SpacePage.tsx` 中的 `onAction` 处理函数

**职责**: 将右键菜单的 8 个操作分发到对应处理逻辑。

**操作映射**:

| 操作 | 类型 | 实现方式 |
|------|------|---------|
| `regenerate` | Canvas → Agent | 发送消息到 ChatManager: `"请重新生成这张图 [shape context]"` |
| `hd_enhance` | Canvas → Agent | 发送消息: `"请对这张图进行高清增强 [shape context]"` |
| `generate_video` | Canvas → Agent | 发送消息: `"请根据这张图生成视频 [shape context]"` |
| `extract_character` | Canvas → Agent | 发送消息: `"请从这张图中提取角色 [shape context]"` |
| `add_to_chat` | Canvas → Chat | 将 shape 的图片/视频 URL 插入聊天输入框 |
| `download` | 本地操作 | `fetch(url)` → `Blob` → `a.download` |
| `copy` | 本地操作 | `navigator.clipboard.write()` |
| `delete` | Canvas 操作 | `editor.deleteShapes([shapeId])` |

**Canvas → Agent 流程**:

```
用户右键 shape → 选择 "regenerate"
  → 获取 shape 上下文 (type, props, imageUrl, etc.)
  → 构造自然语言指令
  → ChatManagerSAV1.sendMessage(指令)
  → Agent 收到消息 → 执行工具 → publish_agent_event
  → SSE → asyncTaskStore → AsyncTaskBar 展示进度
  → Agent 返回结果 → ConnectedChatPanel callback → editor.updateShape
```

**Shape 上下文提取**:

```typescript
function getShapeContext(editor: Editor, shapeId: string): ShapeContext {
  const shape = editor.getShape(shapeId);
  if (!shape) return null;
  const props = shape.props;
  return {
    type: shape.type,
    imageUrl: props.src || props.url || props.imageUrl,
    videoUrl: props.videoUrl,
    roleName: props.roleName,
    prompt: props.prompt,
    description: props.description,
  };
}
```

---

### 模块 M4: Interactive Shape Overlays — Shape 内嵌操作按钮

**文件**: 各 ShapeUtil 的 `component()` 方法

**目标 Shape 类型** (来自 `canvas/shapes/index.ts`):
- `SoraImageShapeUtil` — 图片 shape
- `SoraVideoShapeUtil` — 视频 shape
- `SoraRoleCardShapeUtil` — 角色卡 shape
- `SoraSceneCardShapeUtil` — 场景卡 shape
- `SoraStoryboardCardShapeUtil` — 分镜卡 shape

**交互按钮设计**:

每个 Shape 在 hover 时显示一个工具条（overlay），包含：

| Shape 类型 | Hover 操作 |
|------------|-----------|
| Image | 🔄 重新生成 / ✨ 高清增强 / 🎬 生成视频 / ⬇ 下载 |
| Video | 🔄 重新生成 / ⬇ 下载 / ▶ 播放 |
| RoleCard | 📝 编辑角色 / 🖼 重新生成角色图 |
| SceneCard | 📝 编辑场景 / 🖼 重新生成场景图 |
| StoryboardCard | 📝 编辑分镜 / 🎬 生成视频 |

**tldraw 交互实现** (基于 Context7 文档):
- shape `component()` 内设置 `pointerEvents: 'all'` 允许交互
- 按钮使用 `onPointerDown={(e) => e.stopPropagation()}` 阻止事件冒泡
- hover 状态使用 CSS `:hover` 或 React state
- 操作触发复用 M3 中的 dispatcher

---

### 模块 M5: Backend Agent State Events — 后端状态事件发布

**文件**: `sora-ai-backend/app/services/agent/oiioii/workflows/story_anime.py`

**改动范围**: `make_agent_node` 函数内部

**新增事件发布点**:

```python
# 在 node_fn 中:

# 1. Agent 开始处理
await publish_agent_event(ws_id, "agent_started", {
    "agent_key": agent_key,
    "agent_name_zh": AGENT_CONFIGS[agent_key].name_zh,
}, agent_name=agent_key)

# 2. 工具调用前 (在 ToolNode 中 hook)
# → 需要自定义 ToolNode 子类，或在 tool 内部发布

# 3. Agent 完成
await publish_agent_event(ws_id, "agent_completed", {
    "agent_key": agent_key,
    "has_tool_calls": bool(response.tool_calls),
}, agent_name=agent_key)
```

**Tool 级别事件** — 在各 tool 实现中（`tools.py`）:

```python
# generate_image tool 内部:
await publish_agent_event(ws_id, "tool_started", {
    "tool_name": "generate_image",
    "tool_name_zh": "生成图片",
})

# 完成时:
await publish_agent_event(ws_id, "tool_completed", {
    "tool_name": "generate_image",
    "preview_url": result_url,
    "shape_id": target_shape_id,  # 如果有关联的 shape
})
```

---

### 模块 M6: SSE Event Router — 前端事件路由

**文件**: `src/stores/oiioii/chatManager.ts` 或新建 `src/stores/oiioii/agentEventRouter.ts`

**职责**: 在现有 SSE 连接中增加对 `agent_started`/`tool_started`/`tool_completed`/`agent_error` 事件的路由，转发到 `asyncTaskStore`。

**数据流**:

```
sora-ai-backend (LangGraph node)
  → publish_agent_event (Redis Pub/Sub, channel: workspace:{id}:agent)
  → sora-ui-backend (SSE controller 订阅 Redis, 转发为 SSE event)
  → 前端 EventSource → chatManager / agentEventRouter
  → agentEventRouter 判断事件类型:
      message/delta → useMsgStore (现有逻辑)
      agent_started/tool_started/tool_completed → asyncTaskStore (新逻辑)
```

**sora-ui-backend SSE 改动**:
- `sseService.ts` 已订阅 `workspace:{id}:agent` channel
- 需确认现有 SSE 转发代码是否原样透传 `event` 字段
- 如果 SSE 只转发 `message` 类型，需增加对新事件类型的转发

---

### 模块 M7: CanvasContextMenu 增强 — 类型感知菜单

**文件**: `canvas/CanvasContextMenu.tsx`

**改动**: 根据 shape 类型过滤菜单项。

当前 `MENU_ITEMS` 是固定的 8 项。应改为：

```typescript
function getMenuItemsForShape(shapeType?: string): MenuItem[] {
  const base = [
    { action: 'download', label: '下载', icon: <DownloadIcon /> },
    { action: 'copy', label: '复制', icon: <CopyIcon /> },
    { action: 'delete', label: '删除', icon: <TrashIcon />, danger: true },
  ];
  
  switch (shapeType) {
    case 'sora-image':
      return [
        { action: 'regenerate', label: '重新生成', icon: <RefreshIcon /> },
        { action: 'hd_enhance', label: '高清增强', icon: <SparkleIcon /> },
        { action: 'generate_video', label: '生成视频', icon: <FilmIcon /> },
        { action: 'extract_character', label: '提取角色', icon: <PersonIcon /> },
        { action: 'add_to_chat', label: '发送到聊天', icon: <MessageIcon /> },
        ...base,
      ];
    case 'sora-video':
      return [
        { action: 'regenerate', label: '重新生成', icon: <RefreshIcon /> },
        { action: 'add_to_chat', label: '发送到聊天', icon: <MessageIcon /> },
        ...base,
      ];
    case 'sora-role-card':
      return [
        { action: 'regenerate', label: '重新生成角色图', icon: <RefreshIcon /> },
        { action: 'add_to_chat', label: '发送到聊天', icon: <MessageIcon /> },
        ...base,
      ];
    default:
      return base;
  }
}
```

同时需要从 `SpacePage` 传入 `shapeType`（当前 `onContextMenu` 已获取 `selected?.id`，需额外获取 `selected?.type`）。

---

## 5. 数据流总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        前端 (sora-ui)                            │
│                                                                  │
│  ┌──────────┐  callback    ┌───────────┐  updateShape  ┌──────┐ │
│  │Connected │────────────→│ SpacePage  │─────────────→│Canvas│ │
│  │ChatPanel │              │ (editor)   │              │tldraw│ │
│  └──────────┘              └───────────┘              └──┬───┘ │
│       ▲                         ▲                        │      │
│       │ SSE msg                 │ onAction               │右键   │
│       │                         │                        ▼      │
│  ┌──────────┐              ┌───────────┐         ┌──────────┐  │
│  │  SSE     │  agent event │ContextMenu│  click  │  Shape   │  │
│  │ Router   │────────────→│ Dispatcher │←────────│ Overlay  │  │
│  └────┬─────┘              └─────┬─────┘         └──────────┘  │
│       │                          │                              │
│       ▼                          ▼ sendMessage                  │
│  ┌──────────┐              ┌───────────┐                       │
│  │AsyncTask │              │   Chat    │                       │
│  │  Store   │              │  Manager  │                       │
│  └────┬─────┘              └─────┬─────┘                       │
│       ▼                          │                              │
│  ┌──────────┐                    │                              │
│  │AsyncTask │                    │                              │
│  │   Bar    │                    │                              │
│  └──────────┘                    │                              │
└──────────────────────────────────┼──────────────────────────────┘
                                   │ HTTP POST
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    后端 (sora-ai-backend)                        │
│                                                                  │
│  ┌───────────┐  invoke   ┌───────────┐  publish   ┌──────────┐ │
│  │ LangGraph │─────────→│  Agent    │───────────→│  Redis   │ │
│  │ Workflow  │           │  Node     │            │  Pub/Sub │ │
│  └───────────┘           └─────┬─────┘            └────┬─────┘ │
│                                │                       │        │
│                                ▼ tool_call             │        │
│                          ┌───────────┐                 │        │
│                          │  Tools    │                 │        │
│                          │(generate, │                 │        │
│                          │ enhance..)│                 │        │
│                          └───────────┘                 │        │
└────────────────────────────────────────────────────────┼────────┘
                                                         │ subscribe
                                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                  中间层 (sora-ui-backend)                        │
│                                                                  │
│  ┌───────────┐  SSE push  ┌───────────┐                        │
│  │  Redis    │───────────→│   SSE     │ → 前端 EventSource     │
│  │ Subscriber│            │ Controller│                        │
│  └───────────┘            └───────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. 实施顺序

| 阶段 | 模块 | 预估工时 | 依赖 |
|------|------|---------|------|
| Phase 1 | M1 asyncTaskStore | 2h | 无 |
| Phase 1 | M2 AsyncTaskBar | 3h | M1 |
| Phase 1 | M5 Backend events | 2h | 无 |
| Phase 1 | M6 SSE event router | 2h | M1, M5 |
| Phase 2 | M3 ContextMenu dispatcher | 3h | 无 |
| Phase 2 | M7 Type-aware menu | 1h | M3 |
| Phase 3 | M4 Shape overlays | 4h | M3 |
| **总计** | | **~17h** | |

Phase 1 (任务状态可视化) 和 Phase 2 (右键菜单反向联动) 可以并行开发。

---

## 7. 错误处理

| 场景 | 处理方式 |
|------|---------|
| Agent 任务超时 (>60s 无状态更新) | asyncTaskStore 标记 status=error, 显示"任务超时" |
| SSE 连接断开 | 重连后通过 `canvas_async_tasks/sync` 轮询补齐状态（参考 OiiOii） |
| Shape 已被删除但任务还在 | asyncTaskStore 检测到 shape 不存在时自动清理任务 |
| 右键操作的 Shape 无 URL | 菜单禁用不适用的操作项（`disabled` 属性） |

---

## 8. 与后续 Codex/OMX 集成的对齐

本设计有意预留了 Codex/OMX 的集成点：

- **asyncTaskStore** 的 `AgentTask` 接口可扩展为 `CodexTask`，支持代码执行任务的状态追踪
- **ContextMenu dispatcher** 的操作映射可扩展新的 action type（如 `execute_code`）
- **SSE event router** 的事件类型可扩展（如 `codex_started`, `codex_output`）
- **M5 后端事件** 的 `publish_agent_event` 已是通用接口，Codex 工具可直接使用

这些扩展不需要修改核心架构，只需增加新的事件类型和处理逻辑。
