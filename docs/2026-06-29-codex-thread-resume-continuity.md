# Codex 对话崩溃续聊（thread/resume）修复

> 2026-06-29 · 关键词：codex 闪退、上下文丢失、同一对话无法连续、thread/resume、crash self-heal

## TL;DR

修复了「**codex 对话有时候闪退后，同一个对话里无法继续连续对话**」的问题。

- **现象**：`codex app-server` 子进程崩溃（或因切换模型/配置而重启）后，旧进程内存里的会话线程随之消失。再在**同一个 UI 对话**里发消息时，旧的 codex 线程 id 已失效，`turn/start` 会 404，把对话卡死。
- **修复**：双层兜底——
  - **Fix A（即时止血）**：用「世代（epoch）」给每个 codex 线程 id 打标签；codex 一旦重启 epoch 自增，发现 id 是上个世代的就**不再盲目复用**，避免 404 卡死。
  - **Fix B（真正续聊）**：在判定 id 过期时，先尝试 `thread/resume` 从磁盘 rollout 把**同一条线程**重新载入新世代，**保留上下文继续聊**；resume 不可用/失败才退回开新线程并提示用户。
- **验证**：单测 + 离线协议冒烟 + 在线「真实回忆」端到端测试，全部通过。在线测试实测：崩溃前埋入 `SECRET=BANANA-42`，杀掉 app-server，新进程 `thread/resume` 后追问，模型答出 `BANANA-42` —— 上下文确实跨重启保住了。

---

## 续集：整个 App 重启后仍然失忆（2026-06-29 追加修复）

> 关键词：重启之后对话又没有记忆了、app restart、持久化 codexThreadId、hydrate-on-load

### 现象与漏网根因

上面的 Fix A/B 只覆盖了**同一次 app 运行内** `app-server` 子进程的重启（崩溃自愈 / 切 provider）—— 因为那时 `AgentManager` 进程还活着，内存里的 `codexThreadIdByDbThreadId` 映射还在，epoch 一变就能 resume。

但**把整个桌面 App 关掉再打开**是另一回事：整个 Electron 主进程连同那张内存映射表被**完全清空**。重开后在老对话里发消息时：

- `resolveCodexThreadForSend` 在空映射里查不到任何 codex id → 返回 `undefined` → `backend.send(undefined, …)` → 直接 `thread/start` **开了一条全新的 codex 线程**；
- 磁盘上那条老线程的 rollout 其实还在（`CODEX_HOME` = `<userData>/codex-runtime`，跨重启稳定），但 App **从没记下「这个 DB 对话对应哪条 codex 线程 id」**，所以无从 resume。

直接证据：重开后追问「我们之前讨论了什么」，模型只能复述仓库 `AGENTS.md`，对真正的历史对话一无所知 —— 典型的「换了个全新线程」。这与官方文档完全一致：

> *codex app-server README*：“To continue a stored session, call `thread/resume` with the `thread.id` you previously recorded.”

我们之前**没有 record（持久化）那个 thread.id**，所以重启后无可恢复。（另见 openai/codex#28068：直接按 id `thread/resume` 是比 sidebar 索引更可靠的真相源；rollout 文件本身即有效。）

### 修复：持久化 codexThreadId + 重启首发时 hydrate-and-resume

1. **新增持久列** `AgentThread.codexThreadId`（`prisma/schema.prisma`），并在 `ensureSchema.ts` 的 `INIT_SQL`（新库）与 `ALIGN_SCHEMA_SQL`（**老用户库热更新时**幂等 `ADD COLUMN IF NOT EXISTS`）双写，保证存量用户升级即获得该列。

2. **铸造即落盘**：`rememberCodexThread` 在记内存的同时 best-effort 写库（与 `updateLastMessageAt` 同一姿态，不阻塞流式热路径）：

```1442:1442:src/main/agent/AgentManager.ts
    const persist = this.store?.setCodexThreadId?.(dbThreadId, codexThreadId)
```

3. **重启后首发时水合**：映射为空（重启后的常态）不再直接放弃，而是从库里取回持久 id，先 `thread/resume` 把磁盘 rollout 载回当前世代，成功就复用同一 id（记忆保住），失败/无 id/后端不支持才开新线程并提示：

```1476:1476:src/main/agent/AgentManager.ts
    if (!id) return this.hydrateCodexThreadAfterRestart(dbThreadId)
```

   水合每条线程每进程最多尝试一次（`codexThreadHydrationAttempted`），避免每次发送都打库；被 `forgetCodexThread` 判死的线程也不再被水合复活。

### 裁决矩阵（补充「整个 App 重启」一行）

| 情形 | 行为 |
| --- | --- |
| 同一次运行内、app-server 重启（跨 epoch） | Fix A/B：内存映射在，`thread/resume` 复用同 id |
| **整个 App 重启（内存映射清空）** | **从库取回持久 codexThreadId → `thread/resume` → 复用同 id，保上下文**（本次修复） |
| 重启后无持久 id（全新对话） / resume 失败 | 开全新线程；失败时推送「上下文已重置」提示 |

### 验证（本次新增）

- `src/main/agent/__tests__/AgentManager.test.ts` —— 新增「**整个 app restart（内存映射清空）后，从库 hydrate 持久 codexThreadId 并 resume**」用例：构造第二个 `AgentManager` 实例（= 全新空内存，复用同一持久 store）模拟重启，断言 `resumeThread([CODEX_UUID])` 被调用、`backend.send` 收到的是同一 id、且**没有**「上下文重置」提示。
- `src/main/agent/__tests__/ensureSchema.test.ts` —— 在「老库对齐」用例里加断言：`codexThreadId` 列被 `ALIGN_SCHEMA_SQL` 补上且可写读往返（覆盖存量用户的热更新升级路径）。
- 结果：`ensureSchema + AgentManager + ThreadStore` 三套件 **37 passed**；`tsc --noEmit` 无新增类型错误（仅两条既有基线）。

> 同样保持安全：没有持久 id、后端不支持 resume、或 resume 失败 → 自动开新线程 + 明确提示，绝不卡死。

---

## 症状

用户在一个对话里聊到一半，codex 引擎闪退（崩溃自愈）或因为改了模型/网关而重启。重启后用户继续在**同一个对话**输入，结果：

- 消息发不出去 / 一直转圈 / 报错；
- 即使勉强能发，AI 也完全「失忆」，等于换了个对话。

## 根因

三点叠加：

1. **DB 线程 → codex 线程 id 的映射只在内存里**。`AgentManager` 用 `codexThreadIdByDbThreadId` 把 UI/DB 线程映射到 codex app-server 的 UUID 线程 id（codex 只认 UUID，不能把 DB cuid 塞进 `turn/start`）。
2. **app-server 是有「世代」的**。每次成功 spawn（崩溃自愈 `start()` 或切换 provider 的 `restartCodex()`）都会产生一个**全新进程**，它的内存线程从空开始 —— 上个世代的线程 id 在新进程里**不可用**。见 `CodexLocalBackend` 的 `epoch` 字段：

```210:210:src/main/agent/CodexLocalBackend.ts
  private epoch = 0
```

3. **此前没有「跨世代续聊」机制**。重启后还拿旧 id 去 `turn/start`，必然 404，把对话彻底卡死 —— 这就是「闪退后同一对话无法连续对话」的直接原因。

---

## 修复设计（三层）

### 1) 后端：世代标记 + thread/resume RPC

`CodexLocalBackend` 每次 spawn 自增 `epoch`，并暴露 `currentEpoch()` 与 `resumeThread()`：

```518:520:src/main/agent/CodexLocalBackend.ts
  currentEpoch(): number {
    return this.epoch
  }
```

```481:484:src/main/agent/CodexLocalBackend.ts
  async resumeThread(threadId: string): Promise<void> {
    if (!this.client) throw new Error('CodexLocalBackend.resumeThread called before start')
    return this.client.resumeThread(threadId)
  }
```

`CodexProtocolClient.resumeThread` 直接打 app-server v2 的 `thread/resume`，把磁盘上的 rollout 载入当前世代；失败往上抛，交给上层回退：

```309:311:src/main/agent/CodexProtocolClient.ts
  async resumeThread(threadId: string): Promise<void> {
    await this.rpc<unknown>('thread/resume', { threadId })
  }
```

### 2) 编排：AgentManager 的世代失效 + 续聊 + 安全回退

每条 codex 线程 id 都记录它被铸造时的世代 (`codexThreadEpochByDbThreadId`)。发送前由 `resolveCodexThreadForSend` 统一裁决：

```1450:1474:src/main/agent/AgentManager.ts
  private async resolveCodexThreadForSend(dbThreadId: string): Promise<string | undefined> {
    const id = this.codexThreadIdByDbThreadId.get(dbThreadId)
    if (!id) return undefined
    const current = this.backend.currentEpoch?.()
    if (current === undefined) return id
    const stored = this.codexThreadEpochByDbThreadId.get(dbThreadId)
    if (stored === undefined || stored === current) return id

    // Stale generation: attempt to reload the persisted thread so the user keeps
    // their conversation context across the respawn.
    if (this.backend.resumeThread) {
      try {
        await this.backend.resumeThread(id)
        // Same id is now live in the current generation — re-tag and reuse it.
        this.codexThreadEpochByDbThreadId.set(dbThreadId, current)
        return id
      } catch (err) {
        console.warn('[AgentManager] thread/resume failed, starting fresh thread:', err)
      }
    }

    this.forgetCodexThread(dbThreadId)
    this.notifyThreadContextReset(dbThreadId, 'codex_restarted')
    return undefined
  }
```

裁决矩阵：

| 情形 | 行为 |
| --- | --- |
| 同世代（或 backend 无 epoch 能力） | 直接复用旧 id |
| 跨世代 + `thread/resume` 成功 | **重载同一线程，保上下文**，重打世代标签后复用 id（Fix B） |
| 跨世代 + resume 不可用/失败 | 丢弃映射、提示用户、返回 `undefined` → 调用方开**全新线程**（Fix A 兜底） |

### 3) 面向用户：上下文被重置时明确告知

当只能退回新线程时，给对话推一条说明，避免用户莫名其妙「AI 怎么突然失忆了」：

```1403:1405:src/main/agent/AgentManager.ts
    const message = reason === 'codex_restarted'
      ? 'Codex 引擎刚刚重启（崩溃自愈或切换了模型/配置），上一段对话的引擎侧记忆已随旧进程释放，已自动在全新上下文中继续——本条消息正常处理，但 AI 不再记得此前的对话内容。建议把关键结论重新粘贴给它。'
      : '上一段对话上下文已超出网关限制，已自动在全新上下文中继续——本条消息正常处理，但 AI 不再记得此前的对话内容。建议把关键结论重新粘贴给它。'
```

---

## 关键发现：rollout 在「第一回合」才落盘

实测 `codex app-server 0.142.2`：

- **`thread/start` 单独并不会把线程写到磁盘**（`$CODEX_HOME/sessions/**/rollout-*.jsonl`）。rollout 是在**第一回合（turn）跑完后**才落盘。
- 因此一个「零回合」线程崩溃后是无法 resume 的 —— 此时 `thread/resume` 会返回 **graceful 域错误**（如 `no rollout found for thread id ...`），而**不是** "method not found" 或卡死。这正好命中 Fix B 设计的安全回退：resume 失败就开新线程，对话照常工作。
- 对真实用户几乎无影响：用户能「聊到一半崩溃」说明至少已经有过一回合，rollout 一定已落盘，`thread/resume` 能真正恢复上下文。

---

## 顺带修复：ipc.ts 热重载重复注册

`canvas:edit-queue-status` 之前没被纳入 dev-reload 的反注册清单，热重载时会因重复 `handle()` 抛 "Attempted to register a second handler"。同时把所有 `ipcMain.on` 监听器也统一在每次注册前清掉，避免重复路由：

```128:133:src/main/agent/ipc.ts
  for (const channel of AGENT_HANDLE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of AGENT_ON_CHANNELS) {
    ipcMain.removeAllListeners(channel)
  }
```

---

## 验证

### A. 单元测试（离线，无需 key）

- `src/main/agent/__tests__/AgentManager.test.ts` —— `resolveCodexThreadForSend` 的世代失效 / resume 成功重用 / resume 失败回退三条分支。
- `src/main/agent/__tests__/ipc.test.ts` —— 强化「dev reload 后可重复注册」用例，断言 `canvas:edit-queue-status` 仍是 function、各 `on` 监听器计数恒为 1。

### B. 端到端冒烟（真实 codex 二进制）

把已验证的「raw WebSocket JSON-RPC」资源抽到共享 harness `evals/harness/resumeClient.ts`（单一真相源），由两处复用：

1. **独立 CLI**：`scripts/smoke-codex-resume.ts`

   ```bash
   # 仅 CORE（离线，验证 thread/resume 已接线 + 优雅回退）
   npm run codex:smoke:resume

   # CORE + MEMORY（在线，验证真实跨重启回忆）
   $env:OPENAI_API_KEY="<key>"; $env:SMOKE_CODEX_BASE_URL="https://api.apiyi.com/v1"
   $env:SMOKE_CODEX_MODEL="gpt-5.5"; npm run codex:smoke:resume
   ```

2. **可重复的 eval 场景**（集成进既有 agent/codex 测试框架，自动复用 app 已保存的 provider key）：`evals/scenarios/thread_resume_recall.eval.ts`

   ```bash
   # 自动用 app 设置里保存的 key；或显式指定一个 eval key：
   $env:CODEX_EVAL_API_KEY="<key>"
   npx vitest run -c vitest.evals.config.ts evals/scenarios/thread_resume_recall.eval.ts
   ```

   - **CORE（离线）**：仅需打包的 codex 二进制，证明 `thread/resume` 是已接线的 RPC 且对未落盘线程优雅失败（safe-fallback）。
   - **MEMORY（在线）**：turn1 埋入 `SECRET=BANANA-42` → 杀掉 app-server（模拟闪退）→ 新 app-server `thread/resume` 同一线程 → turn2 追问 → **答案须回显该 token**。

### C. 实测结果（2026-06-29，apiyi / gpt-5.5）

```
[resume-smoke] B: thread/resume RESOLVED → conversation reloaded from disk
[resume-smoke] B: recall answer = "BANANA-42"
[resume-smoke] MEMORY ✅ PASS — model recalled BANANA-42 after restart+resume (context preserved end-to-end)
```

eval：`Test Files 1 passed (1) · Tests 2 passed (2)`（CORE + MEMORY 均跑、均通过）。harness 单测：`51 passed`。

> 设计上即便最坏情况也安全：`thread/resume` 不可用/失败 → 自动开新线程 + 明确提示，对话永不卡死。

---

## 续集二：`CODEX_HOME` 没被钉死 → resume 找错目录（2026-06-29 再追加修复）

### 症状

打了「续集一」（持久化 `codexThreadId` + 重启后 `thread/resume`）的包之后，用户反馈**重启仍然失忆**。`systematic-debugging` 头脑风暴排除了「主动抛弃记忆」与「根本没存储」两条假设（`stop()`/`killProcessInstance()` 只是 `SIGTERM`→`SIGKILL`，不删 rollout；`thread/start` 也没传任何 `ephemeral`/禁持久化标志），却挖出**第三个、独立的**根因。

### 根因：会话目录在「跨启动 / 切 provider」之间漂移

codex 把会话 rollout 存在 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`，`CODEX_HOME` 默认 `~/.codex`（见 openai/codex `find_codex_home`：`codex-rs/utils/home-dir`，非空环境变量优先，否则回退 `~/.codex`）。本 app 历史实现里这个 home **没钉死**：

- **首次 spawn**（`CodexLocalBackend` 构造后 `start()`）：`this.codexHome` 为 `undefined` → `buildCodexSpawnEnv` 不设 `CODEX_HOME` → codex 落到默认 `~/.codex`。
- **切 provider 触发 `restartCodex()`**：曾执行 `this.codexHome = path.dirname(paths.runtimeConfigToml)` → 翻成 `<userData>/codex-runtime`，此后 rollout 写到 `codex-runtime/sessions`。
- **下次冷启动**：`this.codexHome` 又回 `undefined` → codex 回看 `~/.codex`。

于是：切过 provider 后写的对话躺在 `codex-runtime/sessions`，而新进程的第一个 app-server 在 `~/.codex/sessions` 找——**即便我们持久化了 `codexThreadId`，`thread/resume` 也因为 home 指错而找不到 rollout → 仍然失忆**。

> 官方佐证：openai/codex#5247 / #5412（`CODEX_HOME` 被 `.gitignore` 覆盖 → 会话不被索引 / resume 失败，PR #5311 修）说明 resume 强依赖「写与读用同一个、且可索引的 `CODEX_HOME`」；Windows 上还有 #20517（`\\?\` 扩展前缀路径比对导致 resume 失败）。因此**钉死一个规范、非 gitignore 的 home** 是前提。

### 修复

1. **钉死单一 home（`resolveStableCodexHome`）**：镜像 codex 自己的 `find_codex_home`——非空 `CODEX_HOME` 环境变量优先，否则 `~/.codex`。在 `CodexLocalBackend` **构造函数**里一次性写入 `this.codexHome`（改为 `readonly`），**每次 spawn（首发 + restart）都用同一个**。
2. **`restartCodex` 不再翻 home**：删掉 `this.codexHome = path.dirname(paths.runtimeConfigToml)`。新 provider 仍通过 respawn 的 `-c model_provider*` 启动参数生效（`-c` 本就 outrank `config.toml`），所以放弃「把 `CODEX_HOME` 指向合并后的 `codex-runtime/config.toml`」这条已基本失效的机制（正常启动早就读 `~/.codex/config.toml`）零损失。
3. **为何选 `~/.codex` 而非 `codex-runtime`**：它是 codex 规范默认（非 gitignore、用户的 `config.toml`/auth 都在此），且**绝大多数既有记忆**（所有未切 provider 的正常启动）本就写在这里——零迁移即保住。唯一孤儿是切过 provider 后写进 `codex-runtime/sessions` 的少量 rollout（100% 由本 app 产生）。
4. **一次性迁移（`codexSessionMigration.ts`）**：开机首个 spawn **之前**（`AgentManager.ensureBackendStarted` 内、置于单飞 `startInFlight` Promise 中以保留并发去重），best-effort 把 `<userData>/codex-runtime/sessions/**/rollout-*.jsonl` 按 `YYYY/MM/DD` 结构拷进 `~/.codex/sessions`，用 `COPYFILE_EXCL` 绝不覆盖已存在的；`codex-runtime` 是纯 app 数据，拷出安全（不碰用户个人 `~/.codex` CLI 历史）。失败只吞不抛，最坏退化为「那条切过 provider 的旧对话开新线程 + 提示」。

### 验证

- `src/main/agent/__tests__/CodexLocalBackend.test.ts`：新增/重写「首发 + restart 钉同一个 `CODEX_HOME`，且不再翻向 `codex-runtime`」，以及 `resolveStableCodexHome` 默认 `~/.codex` / 尊重环境变量 / 空白回退三例。
- `src/main/agent/__tests__/codexSessionMigration.test.ts`：保结构拷贝 / 不覆盖既有 / 忽略非 rollout 与缺目录 no-op / 同目录 no-op，共 4 例。
- 回归：`AgentManager.test.ts` 31/31（含并发去重——迁移挪进 `startInFlight` Promise 内，`startInFlight` 仍同步赋值，去重不破）。全量 `src/main/agent` 503/507；剩 4 失败为既有 `AgentManager.sessionConfig.test` 陈旧默认（`on-request`/`read-only` vs 实现 `never`/`danger-full-access`），与本次无关。`tsc` 无新增错误（`codexSessionMigration.ts` / `CodexLocalBackend.ts` 零报错）。
