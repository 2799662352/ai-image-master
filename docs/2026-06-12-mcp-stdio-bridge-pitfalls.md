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

### 后续（2026-06-13）：视频落盘宽限从 30s → 8s + 短轮询

`generate_video` 是「阻塞到完成」模式，成功后 `waitForTerminal` 还要等落盘（下载 mp4 + COS 上传）才把本地路径塞进回包。原 `PERSISTENCE_GRACE_MS=30_000` 配合 `check_video_task` 的 25s 长轮询，**慢落盘会把回合拖到 25–50s**——视频明明已在聊天里播放，模型却干等。

- 把 `PERSISTENCE_GRACE_MS` 降到 8s，并新增 `PERSISTENCE_POLL_MS=2_000`。
- `check_video_task` 主处理器接受可选 `pollMs`；`waitForTerminal` 在「已成功、落盘仍在跑」时改用 2s 短轮询，慢落盘最多等 ~8s 即带 `persistencePending` 返回（落盘完成会立即唤醒 waiter，快落盘仍能抢回本地路径）。
- `catimation-video` 技能 Notes 明确写入「Background saving never blocks you」。
- 教训补充：**「成功后等 bookkeeping」的等待粒度要 ≤ 预算**，否则长轮询窗口会让「限时降级」名存实亡。

---

## 坑 4：人像库工具的「大库」渐进式披露 —— 跨页筛选 / 输出截断 / 工具超时

> 日期：2026-06-13（人像库 MCP 工具上线时的预防性整改，非线上事故）。
> 背景：给 agent 加了 `list/add/edit/download_portrait_library` 四个工具。人像库素材**可能成千上万**，照「小库」写法在大库下会暴露三连问题。逐条用 `systematic-debugging` + context7（MCP spec）+ codex GitHub issues 证据钉死，不是拍脑袋。

### 4a：本地元数据筛选 + 上游分页 = 跨页漏数据（正确性 bug）

**根因**：筛选有**两个真相源**——上游素材接口(`q`/`kind`/分页)与本地叠加层(`group`/`hidden`，存在 `portrait-library-overlay.json`)。原写法把分页**完全委托上游**，再在「上游返回的那一页」里本地筛 `group`：

```ts
// ❌ 错：上游只返回第 1 页全部素材，本地再筛分组 → 其它页的同组素材永远看不到
const result = await listSeedanceAssets({ page, pageSize, q, kind })
let enriched = result.items.map(enrich)
if (group) enriched = enriched.filter(it => it.group === group)  // 只筛了这一页！
```

`list_portrait_library({group:'主角'})` 会返回近乎随机的子集，**库越大漏得越多**。`hidden` 过滤同理：页内被筛掉后实际项数 < pageSize，但返回的 `total/totalPages` 仍是上游未过滤的数，agent 翻页会困惑。

**修复**：分组是本地元数据，上游不认识，无法靠上游分页 → `group` 筛选走**有界扫描**：

```ts
// ✅ 先从叠加层拿到该组的目标 assetId 集合（为空直接返回，零上游调用）
const targetIds = new Set(Object.keys(overlay.entries).filter(id => overlay.entries[id]?.group === group))
if (targetIds.size === 0) return { items: [], total: 0, hasMore: false, ... }
// 扫上游若干页凑齐这些 id 的详情：页数上限(30) + 时间预算(40s, < codex 60s)，凑齐即停
for (let pg = 1; pg <= MAX_SCAN_PAGES; pg++) {
  const res = await listSeedanceAssets({ page: pg, pageSize: 50, q, kind })
  for (const it of res.items) if (targetIds.has(it.assetId)) matched.push(it)
  if (seen.size >= targetIds.size || pg >= res.totalPages) break
  if (pg >= MAX_SCAN_PAGES || Date.now() > deadline) { scanCapped = true; break }
}
// 再本地分页，返回准确的 total/totalPages/hasMore（扫描触顶给 scanCapped 提示结果可能不全）
```

无分组的常见路径仍走上游分页（每次只取一页，大库低开销）。**教训**：凡是「本地元数据筛选」叠在「上游分页」之上，分页就不能委托给上游——要么本地凑齐再分页，要么把筛选下推到上游（本例上游不支持）。

### 4b：codex 默认把工具输出截断到 ~10K tokens（输出别重复序列化）

**证据**（codex GitHub issues #6544 / #14206 / #16664 + `example-config.md`）：codex 默认 `tool_output_token_limit = 10000`，**超了静默截断**（插 `…N tokens truncated…`），模型可能拿半截数据照样行动。社区缓解：**返回精简结构化 JSON，别堆原始文本**（实测省 60-92%）。

原 `list` 输出「逐项 bullet 人类行 + 完整 JSON items」= 同一份数据序列化两遍（违反 Vercel 的 avoid-duplicate-serialization）。

**修复**：1 行人类摘要 + 1 行**最小字段** JSON（只留 `assetId/name/kind/assetUrl/group?/sourceUrl?/hidden?`，去掉 `upstreamName/sizeBytes`）；默认 `pageSize` 24→12；返回 `page/totalPages/hasMore`，`hasMore` 时摘要提示「翻页用 page:N+1」。MCP spec 本身也是 cursor 分页 + `nextCursor`/`hasMore` 信号（消费者把 cursor 当不透明 token）。

### 4c：codex 默认 `tool_timeout_sec = 60`，长工具无超时 = 被砍 = 「没反应」

**证据**：codex 对每个工具调用有默认 60s 超时，超了直接砍掉——表现又是「生成成功了没有反应」（与坑 3 同症状，不同成因）。`download_portrait_asset` 原本用 `net.fetch` **无超时**，大视频/卡连接必撞这条线。

**修复**：`AbortController` **45s 主动超时**（< codex 60s，主动返回可读错误而非被静默砍）+ `content-length`/实际字节双重 **300MB 上限**，杜绝无限等 / 撑爆内存。**教训**：任何可能 >10s 的工具，自己的超时必须**严格小于** codex 的 `tool_timeout_sec`（默认 60s），否则错误归因会丢失。

### 教训汇总（写 MCP 工具前先自问）

- 工具返回**列表**？→ 必须分页 + `hasMore`，默认 pageSize 要小，输出走精简 JSON 不要重复序列化（codex ~10K 截断）。
- 有**本地元数据**叠加在上游分页上？→ 分页不能直接委托上游（4a）。
- 工具可能**跑得久**？→ 自己的超时 < codex 60s，且给体积/页数上限（4c）。

---

## 坑 5：first-party skill 的 `description` 过长（渐进式披露 = 触发信号，不是文档）

**证据**（openai/codex `docs/skills.md` + `codex-rs/skills` skill-creator，2026-06-13 核对 main）：codex skill 是三层渐进式披露 —— **① `name`+`description`（启动即注入，唯一触发信号）→ ② SKILL.md body（触发后才读）→ ③ `references/`/`scripts/`/`assets/`（按需）**。硬规则：`name` ≤64 字符；`description` 是「1–2 行、含具体触发线索」，**所有「何时使用」写 description，机制/步骤写 body**（body 里的 "When to use" 对触发无效，因为触发时还没读 body）。`docs/skills.md` 旧 commit 写 `description` ≤500 字符，超长 → invalid skill → **启动阻塞弹窗**。

我们的 first-party skills（`firstPartySkills.ts`）投递机制是**合规**的：写到磁盘 `$HOME/.agents/skills/<name>/SKILL.md`，codex 原生发现、只注入 name+description+路径、body 留盘按需读。

**坑**：三个 skill 的 `description` 都 ~520–700 字符（image/video ~700、portrait ~520），超「1–2 行/≤500」，还塞了**机制细节**（`gpt-image-2-vip` 渠道、ATTACHMENTS 面板、历史页、「阻塞 1–3 分钟」、进度气泡、落盘）。这些不是触发线索：description **每次会话始终注入** → 过长既膨胀上下文，又在严格 codex 构建上触发 invalid 弹窗。

**修复**：三个 description 收紧到 ~460–490 字符，**保留全部触发词** + 关键导向（「优先于内置 image_gen / 内置在 Windows 不可用」），机制全部移回 body（本就有）；顺手给视频补 `视频编辑 / 视频延长 / 全能参考` 触发词。skill 带 sha256 marker，下次启动 `installFirstPartySkills` 自动以 updated 重写到磁盘。

**教训**：description 只装「是什么 + 何时用（触发词）」；任何「怎么做/走哪个渠道/产物存哪」都属于 body（甚至 `references/`）。body 逼近 500 行再拆 `references/`，引用要从 SKILL.md 一级直达并说明何时读。

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
4. 工具跑了 >60s？codex 默认 `tool_timeout_sec=60` 会砍掉调用——给工具加 <60s 的自超时（坑 4c）。
5. 工具输出很大却像「只处理了一半」？codex 默认 ~10K token 截断，精简 JSON + 分页（坑 4b）。
