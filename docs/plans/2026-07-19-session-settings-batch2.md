# 会话设置第二批:持久化 / Plan 推理强度 / 通知 / 连接方式 / verbosity / feature flags

> 状态:批次 1 已落地(2026-07-19,见文末「批次 1 实施记录」);其余批次待实施。
> 前置:第一批(personality / reasoningSummary / showRawReasoning / webSearch indexed + 聊天栏齿轮设置)已落地。

## 〇、Context7 复核修订(2026-07-19 晚)

对照 learn.chatgpt.com + developers.openai.com 官方文档复核后的修订:

1. **reasoning effort 取值集合以冒烟为准,不以文档为准**——新版文档的 agent 配置
   已出现 `ultra` / `max` 两档(`ultra|max|xhigh|high|medium|low|minimal|none`),
   与 sample config 的 `none..xhigh` 六档不一致(按版本/模型漂移)。
   批次 1 的「Plan 推理强度」选项列表**必须由冒烟脚本对 bundled 0.144.6 binary
   逐值探测 serde 接受集合后再定**,UI 只放实测通过的档位。
2. **官方确认 `turn/start` 有 per-turn 顶层覆盖**:`effort` / `summary` /
   `personality` / `model` 均可按回合覆盖(learn.chatgpt.com turn/start 文档)。
   这为将来「按线程微调」提供了比 collaborationMode 更细的原语——记入批次 4
   观察项;Plan 推理强度本批仍走 collaborationMode.settings(与既有展开逻辑同路)。
3. **传输选项全集**:官方 CLI reference 确认 `stdio://`(或 `--stdio`,默认)、
   `ws://IP:PORT`(experimental)、`unix://`、`off` 四种;Windows 下 unix socket
   不适用,批次 3 只做 stdio|websocket 两档,维持原计划。
4. **stdio 默认 + ws loopback 豁免 auth 双重确认**(developers.openai.com
   app-server 页):与原调研一致,批次排序不变。
5. 实现细节修订:持久化注入点写明「**backend 首次 spawn 前**读 store」
   (AgentManager 构造同步读或 ensureStarted 前异步读均可,不得晚于 spawn);
   electron-store 键带版本号(`agentSessionConfig:v1`)以便将来 schema 演进;
   store 白名单按键过滤,批次 2 的通知开关字段预留在同一 schema。

## 一、上游调研结论(Codex GitHub issues + 官方文档)

### 1. 设置持久化 —— 官方路径 vs 客户端自持久化

**上游事实**:
- app-server 提供 `config/read`、`config/value/write`、`config/batchWrite` RPC,但**只能写
  `$CODEX_HOME/config.toml`(user 层)**,项目层只读(issue #11728,`configLayerReadonly`)。
- `config/batchWrite` 支持 `reloadUserConfig: true`,写完可热重载到已加载线程。

**为什么不走官方 config RPC(方案 B 否决)**:
1. 我们的 `CODEX_HOME` pin 在 `~/.codex` —— 写 config.toml 会污染用户终端里
   codex CLI 的全局配置(用户自己在终端跑 codex 也读同一个文件)。
2. 我们所有会话配置走启动 `-c` CLI overrides,**优先级高于 config.toml**;
   写了 config.toml 也会被自己的 `-c` 盖掉,除非把 `-c` 全部撤掉改为依赖
   config.toml,牵动 launch 关键路径,风险不成比例。

**采纳:方案 A —— 客户端自持久化(electron-store)**
- 主进程已有延迟加载的 `electron-store`(`src/main/index.ts`)。新增
  `agentSessionConfig` 存储键,只存与默认值的差异(diff),字段白名单校验
  (复用 `validateSessionConfigPatch`)。
- 启动链:`AgentManager` 构造时读 store → `resolveCodexSessionConfig(persisted)`
  → 注入 backend 启动参数。损坏/非法值 → 静默回退默认(fail-safe)。
- **用户确认交互(用户拍板:确认才保存,否则默认)**:
  - 齿轮/Permissions 面板的「应用设置」行为不变 = 内存态即时生效,重启回默认。
  - Apply 按钮旁新增复选框「☐ 保存为默认(重启后仍生效)」,**默认不勾**;
    勾选后 Apply 才把 patch 写入 electron-store。
  - 面板底部新增「恢复出厂默认」链接:清除持久化 + 重置内存态为
    `DEFAULT_CODEX_SESSION_CONFIG`(需要确认,复用两步 ConfirmButton 模式)。
  - 已有持久化时面板显示一条 subtle 提示「当前默认值来自你保存的设置」。
- 安全边界不变:`sandboxMode: 'danger-full-access'` / `approvalPolicy: 'never'`
  等高权限项即使持久化,启动注入时仍然只是当前既有默认(本来就是这两个值);
  未来若默认收紧,持久化恢复高权限项时要走一次主进程确认弹窗
  (`confirmUnsafeSessionConfigChange` 已有,启动路径豁免当前默认值)。

### 2. 连接方式(stdio / WebSocket)—— 不紧迫,批次 3

**上游事实**(developers.openai.com/codex/app-server + PR #22404 / commit 22d51ec):
- 官方口径:`stdio` 是默认且 supported;`--listen ws://` 「experimental and
  unsupported」。
- **强制 auth 只针对 non-loopback**:`ws://0.0.0.0` 之类无 auth 会启动失败;
  `ws://127.0.0.1`(我们的形态)明确豁免——"Loopback listeners remain
  available for local and SSH-forwarding workflows"。此前担心的「token 强制
  认证 break 我们」在 loopback 场景不成立,紧迫性降级。
- 冒烟 `scripts/smoke-stdio-transport.ts` 已证 bundled binary 支持 stdio JSONL。

**方案**:设置「连接方式」`websocket`(默认,= 现状)| `stdio`;改动需重启
codex(挂 configDirty 机制)。实现在 `CodexLocalBackend`:
- 抽 transport 接口:`WsTransport`(现有)+ `StdioTransport`(spawn 不带
  `--listen`,stdin/stdout 按行 JSONL 编解码,复用现有 JSON-RPC 路由)。
- `CodexProtocolClient` 只依赖 transport 接口收发,不感知底层。
- 卖点:去掉本地端口占用/防火墙弹窗问题;对齐官方 supported 路径。

### 3. 通知(回合完成)—— 不依赖上游,纯 Electron

**上游事实**:
- top-level `notify` 只支持 `agent-turn-complete` 且**官方明确将废弃**
  (issue #19921 维护者答复);`[tui].notifications` 只作用于官方 TUI,对
  app-server 客户端无效;approval-requested 外部通知上游还没做(#11808/#14813
  挂在 hooks 大计划下)。
- **结论:上游没有给 app-server 客户端的通知原语,也不需要——我们自己就是
  UI**,事件流里已有回合完成(`turn/completed`)和审批请求
  (`onApprovalRequest`)。

**方案**:主进程 `new Notification()`(Electron 原生)。
**核对结果**:`electron-builder.yml` 有 `appId: com.catimation.cyberpunk-master`,
但主进程**没有调用 `app.setAppUserModelId`**——Windows 上(尤其 dev 未打包
运行)通知不设 AUMID 会不显示或归属错误,批次 2 第一步补
`app.setAppUserModelId('com.catimation.cyberpunk-master')`。触发点:
- 触发点:`AgentManager.forwardEvents` 观察到 turn 终态(completed/failed)
  → 发「回合完成」;approval request 转发处 → 发「等待你的审批」。
- 仅在**主窗口失焦**时发(聚焦时不打扰);点击通知聚焦窗口并展开聊天面板。
- 设置:齿轮里「桌面通知」组 —— 回合完成 ☐ / 审批请求 ☐(默认都关),
  存进同一份 sessionConfig(可随批次 1 一起持久化)。
- 注:这是客户端功能,不进 Codex sessionConfig 校验白名单的 codex 键集合,
  单独 `clientPrefs` 分支或 sessionConfig 客户端段,实现时定。

### 4. Plan 推理强度 / model_verbosity / feature flags / 细粒度 approval

**上游配置键**(官方 config 文档 + sample config):
- `plan_mode_reasoning_effort`:`none|minimal|low|medium|high|xhigh`;unset =
  preset 内置(当前 medium)。我们已有更顺手的路径:**不用配置键**,
  `AgentManager` 展开 `collaborationModeKind: 'plan'` 时本来就构造
  `settings.reasoning_effort`(现取自 `collaborationMode/list` 的 Plan mask,
  见 `planPresetReasoningEffort()`)——直接用用户设置覆盖该字段即可,
  **零重启、零 -c**。UI:齿轮里「Plan 推理强度」单选(默认 = 跟随官方 preset)。
- `model_verbosity`:`low|medium|high`(GPT-5 Responses API 文本输出长度)。
  root key,先冒烟确认 `thread/start.config` overlay 接受(与第一批
  personality 同法);接受则新会话即时生效,否则退化为 `-c` + 重启生效。
- feature flags `[features]`:`memories` / `multi_agent` / `undo` / `apps` /
  `personality` 等布尔开关。进程级,改动必须重启 codex(挂 configDirty)。
  注意与我们既有的 memories 集成(codexLaunch 已配 memories 相关)互斥检查。
- 细粒度 approval:上游 `requirements.toml` 的 `allowed_approval_policies` 是
  管理员面;客户端侧无新原语。**继续观望,不排批**。

## 二、分批实施计划

### 批次 1:持久化 + Plan 推理强度 + model_verbosity(推荐先做)
量级:中。全 TDD,先冒烟。
1. 冒烟 `scripts/smoke-batch2-overlay.ts`:验证 `-c model_verbosity` +
   `thread/start.config.model_verbosity`、`turn/start.collaborationMode.settings.reasoning_effort`
   自定义值被 serde 接受;**并逐值探测 reasoning effort 接受集合**
   (none/minimal/low/medium/high/xhigh/ultra/max)——UI 选项只放实测通过的档位。
2. 类型/校验:`CodexSessionConfig` 加 `modelVerbosity`('default'|'low'|'medium'|'high',
   default=不发键)+ `planReasoningEffort`('default'|'none'|...|'xhigh');
   `sessionConfigValidation` 白名单扩展。
3. 主进程:
   - `sessionConfigStore.ts`(electron-store 包装):`load()` 启动读+校验,
     `save(diff)` / `clear()`;`AgentManager` 构造注入;
   - `setSessionConfigPatch` 加可选 `persist: boolean` 入参(IPC 透传);
   - Plan 展开:`planPresetReasoningEffort()` 前插用户覆盖;
   - `model_verbosity` 进 `buildCodexLaunchArgs`(非 default 才发)+
     `thread/start.config` overlay。
4. 渲染层:齿轮面板加「Plan 推理强度」「输出详略」两组;Apply 旁
   「保存为默认」复选框(默认不勾);「恢复出厂默认」两步确认;
   持久化来源提示条。
5. 回归:codexLaunch / sessionConfigValidation / CodexProtocolClient.sessionConfig /
   AgentManager.collaborationMode / CodexPermissionsPanel / AgentChatPanel.slim
   全套 + build + lint。

### 批次 2:桌面通知
量级:小-中,纯客户端。
1. 主进程补 `app.setAppUserModelId('com.catimation.cyberpunk-master')`
   (Windows AUMID,当前缺失,不设则 dev 模式通知不显示);
   新建 `agentNotifications.ts`:turn 终态 + 审批请求 → Electron
   Notification(失焦才发,点击聚焦+打开面板);设置开关默认关。
2. 齿轮面板「桌面通知」组;开关持久化搭批次 1 的 store。
3. 测试:AgentManager 通知触发单测(mock Notification)+ 面板测试。

### 批次 3:连接方式(stdio / WebSocket)
量级:中-大,动 transport 关键路径,单独批次防回归。
1. `CodexLocalBackend` 抽 transport 接口;新增 `StdioTransport`(JSONL 帧,
   背压/半包处理);WebSocket 保持默认。
2. 设置「连接方式」+ configDirty 重启提示;冒烟脚本双传输对拍
   (initialize/thread/turn 全链路)。
3. 稳定几个版本后再讨论是否把默认切到 stdio。

### 批次 4(观望,不排期)
- feature flags 开关(memories/multi_agent/undo/apps,需重启,先等真实需求);
- 细粒度 approval(等上游 hooks/requirements 面稳定);
- `thread/settings/update`(experimental)替代部分重启场景;
- `turn/start` 顶层 per-turn 覆盖(`effort`/`summary`/`personality`,官方文档
  已确认)——「按线程/按回合微调」的更细原语,等有真实需求再接。

## 三、关键决策记录
| 决策 | 结论 | 依据 |
|------|------|------|
| 持久化载体 | electron-store 客户端自持久化 | config RPC 只能写 ~/.codex/config.toml,会污染用户全局 CLI 配置,且被我们 `-c` 覆盖 |
| 保存交互 | Apply=内存态;勾「保存为默认」才落盘;可恢复出厂 | 用户拍板「要用户确认保存不然默认」 |
| Plan 推理强度 | **撤出 sessionConfig,不做**(实施中改判) | `CollabModeControl` 已有 per-turn Plan 推理强度选择器(auto/low/…/max,含 provider 能力校验),`buildCollaborationMode` 已消费 `payload.planReasoningEffort`;再加会话级默认会出现两个入口打架 |
| 通知机制 | Electron Notification + 既有事件流 | 上游 notify 将废弃且只覆盖 turn-complete;app-server 客户端本来就该自己发 |
| stdio 紧迫性 | 降级为批次 3 | loopback ws 明确豁免强制 auth(PR #22404),不会被 break |

## 四、批次 1 实施记录(2026-07-19)

- **冒烟**(`scripts/smoke-batch2-overlay.ts`,对 bundled 0.144.6 实测):
  `model_verbosity` 是闭集 `low|medium|high`,launch `-c` 与
  `thread/start.config` overlay 均严格校验;
  `turn/start.collaborationMode.settings.reasoning_effort` 是**开放字符串**
  (bogus 值也被接受),故该字段的守门只能在客户端——现有
  `CollabModeControl` 的能力校验(supportedPlanEfforts)正是这个守门。
- **modelVerbosity**:`CodexSessionConfig.modelVerbosity`
  ('default'=不发键)→ `buildCodexLaunchArgs` 条件 `-c` +
  `thread/start.config.model_verbosity` overlay(新会话零重启生效);
  齿轮面板「输出详略」单选。
- **Plan 推理强度**:按上表决策撤出 sessionConfig(实施中发现
  per-turn 控件已存在),批次 1 范围缩为 持久化 + verbosity。
- **持久化**:`SessionConfigStore`(`<userData>/agent-session-config.json`,
  只存与出厂默认的 diff,`writableRoots` 永不落盘);
  `setSessionConfigPatch(patch, { persist: true })` 快照**全量当前配置**;
  `resetSessionConfigToFactory()` 清盘+回出厂(豁免高危确认框);
  `CodexSessionStatus.persistedDefaults` 驱动面板提示条与「恢复出厂设置」按钮。
- **IPC/preload**:`agent:set-session-config` 加 options 入参、
  新增 `agent:reset-session-config`;preload 对应 `setSessionConfig(patch, options?)`
  / `resetSessionConfig()`。
- **验收**:main/agent 92 套件 1063 用例全绿;agent-chat + agent-workspace +
  preload 127 套件 1016 用例全绿;`build:vite` 通过;新改文件零 lint。
