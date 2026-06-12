# Seedance 视频生成 MCP 工具 — 设计稿

> 日期：2026-06-12
> 状态：已批准（用户确认：两工具轮询 / 设置页填 Key / 完整对齐 generate_image 体验）
> 上游文档：`seedance-openapi-ark-2026-06-12.md`（Ark 火山任务协议）
> 前置复盘：`docs/2026-06-12-mcp-stdio-bridge-pitfalls.md`（三个坑的教训全部吸收进本设计）

## 目标

把 Seedance 2.0 / 2.0 Fast 视频生成接入 CATIMATION，暴露为 codex 可调用的 MCP 工具：

- **不断流**：杜绝长工具调用 —— 提交秒回、查询长轮询 ≤25s，每次回包都远小于任何超时阈值；
- **codex 知道实时状态**：codex 通过 `check_video_task` 主动轮询拿到 queued/running/succeeded/failed；
- **持久化不绑架回包**：成功 = 上游出片；下载/落盘/历史记录是 bookkeeping，套时间预算降级（坑 3 教训）。

## 上游 API（Ark 火山协议）

| 项 | 值 |
|----|----|
| Base URL | `https://vvdance.yongmuai.com`（常量，不做可配置） |
| 鉴权 | `Authorization: Bearer <API Key>`（⚠️ 文档中 Node.js/Python HMAC 签名示例是另一条 `/api/open/v1` 协议路径，勿混用） |
| 创建任务 | `POST /api/v3/contents/generations/tasks` → `{ success, data: { id, status: 'queued' } }` |
| 查询任务 | `GET /api/v3/contents/generations/tasks/{taskId}` → `data.status` ∈ queued/running/succeeded/failed；成功时 `data.content.video_url` 可直接 GET 下载 |
| 模型 | `doubao-seedance-2-0-260128`（2.0）/ `doubao-seedance-2-0-fast-260128`（2.0 Fast） |
| 输入 | `content[]`：text + image_url/video_url/audio_url（role: first_frame/last_frame/reference_image/...）；`data:` URL 单字段约 5MB 上限 |
| 计费 | 按 `usage.completion_tokens`；fast 480p/720p 无视频输入 0.037 元/千 tokens |

## 架构

任务状态机放**主进程**（渲染进程刷新不丢任务、net.fetch 免 CORS、长轮询易实现）：

```
codex ──MCP(stdio桥)──► videoTools (main, server-per-connection 工厂内注册)
                          │ router.call → registerMain handler
                          ▼
                  SeedanceTaskManager (main)
                  ├─ submit → POST tasks (Bearer)
                  ├─ 后台轮询循环 (每 6s GET)
                  ├─ succeeded → net.fetch 下载 mp4 → attachmentService.ingest 落盘(线程 uploads 目录)
                  └─ 状态变化 → win.webContents.send('seedance:task-update') ──► 渲染进程气泡
```

## MCP 工具（`src/main/mcp/tools/videoTools.ts`）

### `generate_video`（秒回）

参数：

- `prompt`（必填）
- `model`: `'2.0' | '2.0-fast'`，默认 `2.0-fast`；描述指引 codex：用户要质量/复杂运动时选 `2.0`
- `resolution`: `480p | 720p | 1080p`，默认 `720p`；`1080p` 仅 2.0（校验报错）
- `ratio`: `16:9 | 9:16 | 4:3 | 3:4 | 1:1 | 21:9`，默认 `16:9`
- `duration`: 整数 3~12 秒，默认 5
- `generateAudio`: 默认 true
- `firstFrame?` / `lastFrame?` / `referenceImages?[]` / `referenceVideo?` / `referenceAudio?`：本地路径 / dataURL / https URL；本地路径在主进程 fs 读成 `data:` URL，**单文件 >4.5MB 报明确错误**（v1 不接素材导入接口——其鉴权方式文档自相矛盾）

返回（立即）：`🎬 task created — taskId / status queued` banner，显式指示 codex「每 ~15s 调一次 check_video_task；典型 1-3 分钟；用户已在聊天里看到进度气泡，不要重复提交」。

### `check_video_task`（长轮询 ≤25s）

参数：`taskId`。服务端 `waitForChange(taskId, 25_000)`：状态一变立即返回，否则 25s 后返回当前快照。

- 运行中：`status + 已耗时 + "call check_video_task again in ~10s"`
- 成功：对齐 `generate_image` DONE banner —— 本地 mp4 路径 + 📁 目录 + 「不要重找文件/任务已完成」提示；若下载落盘未完成 → 立即返回成功 + `persistencePending: true`（远程 video_url 兜底），后台落盘完成后气泡经 IPC 自动翻转（复用 SaveStatusBanner 模式）
- 失败：透出上游 `error.code/message`
- 未知 taskId：明确报错（任务可能因应用重启丢失 → 告知重新 generate_video）

## 主进程服务（`src/main/services/seedance/`）

- `credentials.ts` — 照 `tencent/credentials.ts` 的 safeStorage 模式存 API Key；IPC `seedance:get-config` / `seedance:set-config`
- `client.ts` — `createTask` / `queryTask` / `downloadVideo`（net.fetch + Bearer）
- `taskManager.ts` —
  - `Map<taskId, TaskState>`；TaskState: { taskId, threadId?, prompt, model, status, createdAt, updatedAt, videoUrl?, localPath?, historyMeta, error?, persistence: 'idle'|'running'|'done'|'failed' }
  - submit 后启动每 6s 轮询；终态停止；任务完成/失败 30 分钟后清理
  - `waitForChange(taskId, ms)`：Promise 挂在状态变更事件上
  - succeeded → 下载 mp4 → `attachmentService.ingest(threadId, ...)`（mp4 在附件白名单内）→ 广播 update
  - 每次状态变化广播 `seedance:task-update`（含 threadId，沿用并行聊天防串台路由）

## ToolRouter 小改

`MainToolHandler` 签名加可选 `codexThreadId`，`call()` 对 main handler 也透传 —— `generate_video` 需要它换算 db threadId 给气泡路由（和 `generate_image` 同机制）。

## 渲染进程

- `useAgentChatStore` 新增视频气泡 actions：`beginVideoGeneration / updateVideoGeneration(status, elapsed) / resolveVideoGeneration(artifact kind:'video', localPath) / failVideoGeneration`；气泡：「排队中」→「生成中 · 已 xx 秒」→ 内联 `<video>`（Lightbox 已支持 kind:'video'）
- 新增 `seedance:task-update` IPC 监听（挂在 AgentToolExecutor 同级），驱动气泡状态
- 持久化：历史记录（type `codex-video`，存本地文件路径，不依赖远程 URL 有效期）+ `recordCodexArtifact`；历史页缩略图按 `.mp4` 扩展名走 MediaThumbnail video 分支（小改判定）

## 设置页

「Seedance 视频生成」区块：API Key 输入 + 保存（IPC → safeStorage）。无 Key 时 `generate_video` 返回明确错误指引用户去设置页。

## 测试

- `taskManager.test.ts`：mock fetch 状态流转（queued→running→succeeded / failed）、长轮询提前返回、下载落盘降级、30min 清理
- `videoTools.test.ts`：banner 文案（created / running / done / pending / failed / 未知 task）
- store 视频气泡 reducer 单测
- 实机冒烟：真实 Key 提交一个 480p/4s fast 任务跑通全链路

## 风险与对策

| 风险 | 对策 |
|------|------|
| 文档鉴权矛盾（Bearer vs HMAC） | Ark 路径两处示例均 Bearer，按 Bearer 实现 + 实机冒烟验证 |
| `video_url` 有效期未知 | 历史与气泡都锚定本地落盘路径 |
| codex 忘记轮询 | banner 显式轮询指令；主进程自轮询，UI 不依赖 codex |
| 应用重启任务丢失 | v1 接受（任务 Map 不持久化）；check 对未知 taskId 给明确指引 |
| 多连接并发（坑 2） | 工具注册走既有 server-per-connection 工厂，状态全在 ToolRouter/TaskManager 单例侧，天然安全 |
