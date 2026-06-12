# Seedance 视频 MCP 实施计划

> 规格：`docs/superpowers/specs/2026-06-12-seedance-video-mcp-design.md`
> 执行方式：本会话内联执行（任务粒度按文件组划分，每组完成即跑相关测试）

**Goal:** Seedance 2.0 / 2.0 Fast 接入为 codex MCP 工具（generate_video + check_video_task），提交秒回、长轮询实时状态、限时持久化不绑架回包。

**Architecture:** 任务状态机在主进程（SeedanceTaskManager 单例 + net.fetch Bearer 调用 Ark 协议），MCP 工具经 ToolRouter main handler 调用；渲染进程经 `seedance:task-update` IPC 驱动聊天气泡（复用 ArtifactItem 状态机），完成后历史记录 + 附件落盘。

**Tech Stack:** Electron main (net.fetch / safeStorage / electron-store 模式)、zod、zustand、vitest。

---

### Task 1: 主进程 seedance 服务层

**Files:**
- Create: `src/main/services/seedance/types.ts` — `SeedanceTaskStatus`、`SeedanceTaskState`、`SeedanceTaskUpdate`（IPC 载荷）、`CreateVideoTaskInput`
- Create: `src/main/services/seedance/credentials.ts` — safeStorage 存 apiKey（参考 `tencent/credentials.ts`，无 legacy 迁移，支持 env `SEEDANCE_API_KEY` 兜底）；`getSeedanceApiKey() / setSeedanceApiKey() / getSeedanceKeyState()`
- Create: `src/main/services/seedance/client.ts` — `SEEDANCE_BASE_URL` 常量；`createTask / queryTask / downloadVideo`（net.fetch + `Authorization: Bearer`；POST `/api/v3/contents/generations/tasks`、GET `/tasks/{id}`）
- Create: `src/main/services/seedance/taskManager.ts` — `SeedanceTaskManager`：
  - `Map<taskId, SeedanceTaskState>` + waiter 列表实现 `waitForChange(taskId, ms)`
  - `submit(input, threadId?)` → createTask → 启动 6s 轮询循环
  - succeeded → `persistence:'running'` → deps.persistVideo（下载 + ingest）→ `persistence:'done'` + localPath
  - 每次变更 `deps.broadcast(update)`；终态 30min 后清理
  - 依赖注入（client / persistVideo / broadcast）便于单测
- Test: `src/main/services/seedance/__tests__/taskManager.test.ts` — mock client：queued→running→succeeded 流转、failed 透传 error、waitForChange 状态变化即返回 / 超时返回当前态、persistVideo 失败不影响 succeeded 状态（persistence:'failed'）

### Task 2: MCP 工具 + ToolRouter 透传

**Files:**
- Modify: `src/main/mcp/ToolRouter.ts` — `MainToolHandler` 签名加 `codexThreadId?`；`call()` 对 main handler 先 resolve db threadId 再透传
- Create: `src/main/mcp/tools/videoTools.ts` — `registerVideoTools(server, router)`：
  - `generate_video`：zod schema（prompt/model/resolution/ratio/duration/generateAudio/firstFrame/lastFrame/referenceImages/referenceVideo/referenceAudio）；调 `router.call('generate_video', ...)`；created banner（指示轮询）
  - `check_video_task`：`taskId`；running / succeeded(含 persistencePending) / failed / unknown 四种 banner；succeeded 时附 resource_link(video/mp4)
- Modify: `src/main/mcp/tools/index.ts` — 注册 videoTools
- Test: `src/main/mcp/tools/__tests__/videoTools.test.ts` — banner 文案 + 参数校验（1080p 仅 2.0）

### Task 3: 主进程接线 + preload

**Files:**
- Modify: `src/main/index.ts` —
  - 构造 `SeedanceTaskManager`（persistVideo: downloadVideo → `attachmentService.ingest(threadId,...)`；broadcast: `win.webContents.send('seedance:task-update', u)`）
  - `router.registerMain('generate_video' / 'check_video_task', ...)`：generate_video 内做 Key 检查、本地路径→dataURL（>4.5MB 报错）、content[] 组装、模型映射
  - IPC `seedance:get-config` / `seedance:set-config`
- Modify: `src/preload/index.ts` — CHANNELS.SEEDANCE + `electronAPI.seedance = { getConfig, setConfig, onTaskUpdate }`

### Task 4: 渲染进程气泡 + 持久化

**Files:**
- Modify: `src/types/agent-timeline.ts` — `ArtifactItem` 加 `progressText?: string`
- Modify: `store.ts` — `updateGenerationProgress(itemId, progressText, threadId)`（同 annotate 模式）
- Modify: `cards/ArtifactCard.tsx` — generating 态显示 `item.progressText ?? '正在生成图片…'`；SaveStatusBanner 文案按 artifacts kind 选「张图/个视频」
- Create: `features/agent-chat/SeedanceTaskListener.ts` — 订阅 `onTaskUpdate`：created→begin（排队中）、running→进度文案、succeeded→resolve(video artifact, 本地路径) + 历史记录(type 'codex-video') + recordCodexArtifact + save banner、failed→fail
- Modify: 挂载点（与 mountAgentToolExecutor 同处）
- Test: store progressText reducer 单测

### Task 5: 设置页

**Files:**
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`（或其子组件）— 「Seedance 视频生成」区块：Key 输入（masked 显示已存）+ 保存

### Task 6: 验证

- `npx vitest run src/main/services/seedance src/main/mcp/tools` 等相关测试
- `npm run build:vite` 构建通过
- 实机冒烟（真实 Key、480p/4s fast）由用户或后续会话执行

### 横切约束（坑复盘吸收）

- 工具注册在 server-per-connection 工厂内（既有 registerTools 路径），状态全在单例 TaskManager —— 坑 2 安全
- 两个工具回包都 ≤25s —— 坑 1 的长调用风险彻底消除
- 成功 = 上游出片；下载/落盘/历史是 bookkeeping，绝不阻塞 check 回包 —— 坑 3 模式
- banner 文案短小、显式「完成/勿重试/勿翻文件」—— 对齐 imageTools 既有约定
