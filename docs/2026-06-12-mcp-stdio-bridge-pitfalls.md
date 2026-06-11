# 踩坑复盘：Codex「生成成功了没有反应」— MCP 传输层三连坑（v4.3.36）

> 日期：2026-06-12
> 症状：在 Codex 聊天里调 `generate_image`，**图片在 UI 上生成并显示成功，但 Codex 永远收不到工具结果**——turn 卡住、不回复、最终超时或被用户打断。
> 影响版本：v4.3.31 ~ v4.3.35（streamable HTTP 传输时代）。
> 修复版本：v4.3.36。

本次一共踩了 **三个独立的坑**，叠加在同一条症状上，逐层排查（`systematic-debugging`）才全部钉死。任何一个坑单独存在都能复现「生成成功了没有反应」。

---

## 坑 1：codex 的 rmcp streamable-HTTP 客户端在长工具调用上不可靠

### 现象

`generate_image` 一次要跑 30s~3min。codex 端的 rmcp HTTP 客户端在长连接上有 keep-alive / session 管理的失败模式：SSE 流断开后 codex 不会把 in-flight 的 tool call 关联回来，结果就是我们这边明明把 result 发出去了，codex 那边的 turn 永远等不到。

### 排查要点

- 我们的 MCP 服务器日志显示 result 已写出（`onMessage` → transport.send 成功）。
- codex 端日志（`%USERPROFILE%\.codex\log\codex-tui.log`）里看不到对应的 response 到达。
- 中间没有任何报错——**字节就是没回去**。这种「两端都觉得自己没错」的静默丢失是 HTTP+SSE 会话恢复机制的典型失败模式。

### 修复：stdio 桥（bridge）

放弃让 codex 直连 HTTP，改为 codex spawn 一个**零依赖的 stdio 桥进程**：

```
codex ⇄ (stdio) ⇄ resources/catimation-bridge/index.js ⇄ (loopback TCP) ⇄ Electron 主进程
```

- 桥是一个纯 Node 脚本（`resources/catimation-bridge/index.js`），不需要 build、不需要 node_modules，逐字节转发 stdin/stdout ↔ TCP socket。
- Electron 侧 `src/main/mcp/bridge.ts` 起 loopback TCP listener（带 token 鉴权），每个连接挂一个 `SocketServerTransport`。
- `codexLaunch.ts` 把 catimation MCP server 配置从 `url = http://...` 改成 `command = node, args = [bridge脚本], env = { PORT, TOKEN }`。
- 桥脚本路径解析（dev vs packaged）走 `getCatimationBridgeEntryPath`；packaged 场景靠 `electron-builder.yml` 的 `extraResources` 带入。
- HTTP 入口保留为 fallback（桥脚本缺失或 listener 起不来时回退）。

stdio 是 codex 最久经考验的 MCP 传输（它自己所有内置 MCP server 都走 stdio），把不可靠的网络层从关键路径上摘掉。

### 教训

- **长耗时工具 + streamable HTTP 是高危组合**。MCP 生态里 stdio 至今是兼容性最好的传输，跨进程通信宁可自己写桥也别赌客户端的 HTTP 会话恢复实现。
- 排查跨进程「没反应」时，先在两端各打一个字节级日志，确认「字节到底有没有过去」，再谈协议层。

---

## 坑 2（根因核心）：`McpServer` 共享实例的 `_transport` 被后续连接覆盖

### 现象

上了 stdio 桥之后**问题依旧**。更诡异：单独测桥（一个连接）一切正常；真实场景必挂。

### 根因

`@modelcontextprotocol/server` SDK 的 `Protocol` 基类只有**一个** `_transport` 字段：

```js
// node_modules/@modelcontextprotocol/server 内部（简化）
async connect(transport) {
  this._transport = transport   // ← 每次 connect 直接覆盖！
  ...
}
```

我们原来的写法是：**一个共享的 `McpServer` 实例**，谁连进来就 `server.connect(newTransport)`。而 codex 实际会开**多条连接**（主 agent 一条、每个 subagent 各一条、甚至重连）。时序：

1. 连接 A 进来 → `connect(transportA)` → `_transport = A`
2. A 发起 `generate_image`（要跑 1 分钟）
3. 连接 B 进来（subagent / 重连）→ `connect(transportB)` → **`_transport = B`**
4. A 的工具跑完 → SDK 用 `this._transport.send(result)` → **结果发给了 B**
5. A 永远等不到回包 → 「生成成功了没有反应」

这解释了为什么单连接测试永远复现不了——必须有第二条连接在 in-flight 期间插进来。

### 修复

工厂模式：**每条连接（每个 socket、每个 HTTP session）都创建一个全新的 `McpServer` 实例**，工具注册逻辑抽成 `createServerInstance()` 工厂（`src/main/mcp/server.ts`），`bridge.ts` 和 HTTP 入口都改为按连接调用工厂。

回归测试钉死这个场景（`src/main/mcp/__tests__/bridge.test.ts`）：

> `routes an in-flight tool result back to ITS OWN connection even after a second bridge connects (the 2026-06-12 hang)`

### 教训

- **`McpServer`（及底层 `Protocol`）是单传输设计，一个实例只能服务一条连接。** SDK 文档对此没有显眼警告，`connect()` 也不抛错，纯静默覆盖。
- 任何「N 个客户端连同一个 server 实例」的 MCP 写法都是错的，必须 server-per-connection（参考 SDK 官方 streamableHttp 示例，其实每个 session 也是新建 server，我们当初为了「共享工具注册」抄歪了）。
- 多连接并发是 codex 的**常态**（subagents、重连），不是边缘场景。并发回归测试必须模拟「第二条连接在第一条 in-flight 时插入」。

---

## 坑 3：收尾持久化阻塞回包 —— 成功判定标准错位

### 现象

修完坑 2 后大多数情况正常了，但偶发：图已经在聊天里显示出来，codex 还要再等很久（甚至遇上 Prisma `P1017 Server has closed the connection` 时**无限等**）。

### 根因

`generateImage` 的旧流程是：生成 → 渲染气泡 → **await 历史落库 + 文件面板存盘** → 才返回工具结果。也就是说，**给 codex 的回包被「记账」绑架了**。本地 DB（PGlite/Prisma）一旦抽风挂起，用户眼睁睁看着图在屏幕上，codex 却以为还没完成。

### 修复：成功 = 渲染完成，持久化限时降级

- 成功判定标准重新定义：**图片渲染上屏即成功**。后面的历史记录、文件存盘只是 bookkeeping。
- 持久化套 10 秒预算（`Promise.race`）：预算内完成 → 返回完整 `paths`/`historyId`；超时 → **立即返回成功** + `persistencePending: true`，持久化继续在后台跑。
- 给 codex 的完成横幅（`imageTools.ts` `buildCompletionBanner`）按 pending 状态给出不同文案，明确告诉模型「已生成、文件还在保存、不要重试也不要等」。
- 聊天 UI 同步增加醒目的保存状态横幅气泡（`ArtifactCard` 的 `SaveStatusBanner`）：琥珀色「后台保存中…」→ 翠绿色「已保存 + 📁 目录」，同一气泡原地翻转。

### 教训

- **工具的成功语义要对齐用户感知**：用户看到图就是成功了，任何后置 bookkeeping 都不配阻塞回包。
- 所有「生成后收尾」的异步操作都应该有时间预算 + 降级路径，本地 DB 也会挂（Prisma P1017 不是稀罕事）。

---

## 验证清单（v4.3.36 发版前全部通过）

| 验证 | 方式 | 结果 |
|------|------|------|
| 桥多连接路由 | `bridge.test.ts` 回归测试（双连接 in-flight 插入） | ✅ |
| HTTP session 隔离 | `server.transport.test.ts` | ✅ |
| 实机双连接 | 临时脚本对 dev 实例开 A/B 两条 TCP，A 发 `tools/list` / `query_history`，断言回包只回 A | ✅ |
| 持久化挂起不阻塞 | `AgentToolExecutor.generateImage.test.ts`（mock 永挂的 addToHistory，fake timers 烧完预算） | ✅ |
| pending → saved 气泡翻转 | 同上 + `ArtifactCard.saveBanner.test.tsx` | ✅ |
| 横幅文案 | `imageTools.test.ts`（单图 pending / 批量部分 pending） | ✅ |

## 快速索引（下次再遇到「没反应」）

1. 先确认字节有没有过去（两端字节级日志）。
2. 多连接场景？检查是不是共享了 `McpServer` 实例（`_transport` 覆盖）。
3. 工具逻辑本身完成了吗？检查有没有 await 在收尾持久化上（DB 挂起 = 无限等）。
