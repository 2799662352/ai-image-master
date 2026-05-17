# v4.3.0 — Codex 多 Provider 支持（API易 / Right Code / 自定义）

**Status:** Shipped
**Date:** 2026-05-17
**Bundled Codex CLI:** `@openai/codex@0.130.0`（latest stable，0.131.0 仍是 alpha）

---

## 背景

v4.2.x 把 Codex Agent 写死成 OpenAI 直连 / API易（`api.apiyi.com/v1`）。但实际部署中遇到两个问题：

1. **API易号池架构本身不支持 prompt cache**。来自 API易 [docs/faq/cache-billing](https://docs.apiyi.com/faq/cache-billing) 的官方说明：「中转站的号池机制与缓存的账号绑定特性存在冲突 ——
 第 1 次请求可能分配到上游账号 A 并建立缓存，第 2 次相同请求可能分配到上游账号 B，
 导致缓存未命中。」对开 Codex Agent 这种长会话来说损失是几倍。
2. Codex CLI 0.130 + GPT-5.5 的 prompt cache hit rate 在官方仓库被多次报告（[issue #20301](https://github.com/openai/codex/issues/20301)）也很低，社区建议要么回退到 5.4，要么走支持缓存的中转。

[Right Code](https://www.right.codes) 提供 `https://right.codes/codex/v1`（"Codex 日抛plus"，
计费倍率 **0.2x**），所有 gpt-5.x 模型都开了 cache：cache_create $0/M、
cache_read $0.035–0.1/M（约为 input 的 1/10）。配 `model_reasoning_effort = "xhigh"` +
`model_verbosity = "high"` 后是目前性价比最高的 Codex 中转通道。

为此 v4.3.0 把 provider 改成可切换、可扩展的体系，并保留"添加自定义"通道兜底。

## 目标

- 设置页提供 **3 个内置 preset + 「+ 添加自定义」**：
  - `apiyi` — `https://api.apiyi.com/v1`（默认；现有用户零迁移）
  - `rightcode` — `https://right.codes/codex/v1`（"日抛plus"，0.2x 计费倍率，model=gpt-5.2、
 reasoning_effort=xhigh、verbosity=high、disable_response_storage、windows_wsl_setup_acknowledged、
 requires_openai_auth）。**注意：此端点只接受 `/v1/responses`，不接受 `/v1/chat/completions`** ——
 我们的 Codex CLI 用 `wire_api="responses"` 所以兼容，但用户若把这个 base_url 套到 cursor 等
 默认走 chat/completions 的工具会全错。
  - `rightcode-pro` — `https://right.codes/codex-pro/v1`（"正价"，0.4x 计费倍率）作为高稳定性
 兜底；当 `/codex` 日抛池被限流或上游波动（Right Code 首页公告会提示）时一键切换。
 缓存策略与 `rightcode` 相同（cache_create $0/M、cache_read $0.07/M = input 的 1/10），
 只是输入价格翻倍。
- 每个 provider **独立保存 API Key**（切换时自动 swap，永不混淆）
- 自定义 provider 暴露 `baseUrl` / `envKey` / `model` / `reasoningEffort` / `verbosity` /
 `requiresOpenaiAuth` / 任意 `extraTopLevelConfig`（JSON 顶层 TOML 键值，给将来需要的 flag 留口子）
- 切换 provider / 编辑 / 删除自定义 provider 后**自动重启 Codex `app-server`**

## 架构

### 主进程

- `src/main/agent/codexProviders.ts`（新）— 内置 preset 数据 + helpers。常量
 `BUILTIN_PROVIDER_PRESETS`、`DEFAULT_PROVIDER_ID = 'apiyi'`、`isBuiltinProviderId(id)`、
 `findProviderById(id, customProviders)`、`resolveActiveProvider(id, customProviders)`。
- `src/main/agent/CodexProviderStore.ts`（新）— 持久化层。文件路径
 `<userData>/codex-providers.json`，原子写入 + 版本字段（`version: 1`）。
 - `loadSync()` 在 AgentManager 构造期被调用：若新文件不存在，**只读回退**到旧
 `codex-agent.json` 的 `openaiApiKey`，写到 `apiKeys[DEFAULT_PROVIDER_ID]`，
 这样首次启动 UI 不会拿到空 key。
 - `load()` 异步：完整迁移并落盘新文件。
 - 每个自定义 provider id 通过 `slugify(name) + '-' + nanoid(6)` 生成，唯一性校验。
- `codexLaunch.ts`/`CodexProviderConfig` 扩展 `model`、`reasoningEffort`、`verbosity`、
 `requiresOpenaiAuth`、`extraTopLevelConfig`，全部转成 `-c key=value` 注入 Codex CLI。
- `AgentManager` 把所有 provider 操作集中：
 - `getProvidersSnapshot()`、`setActiveProvider(id)`、`setProviderApiKey(id, key)`、
 `addCustomProvider(input)`、`updateCustomProvider(id, patch)`、`removeCustomProvider(id)`
 - 切换 / 编辑 / 删除（如果触及 active）后调 `backend.restartCodex()`。

### IPC + Preload

新增 6 个 channel（`agent:get-providers` / `agent:set-active-provider` /
`agent:set-provider-api-key` / `agent:add-custom-provider` /
`agent:update-custom-provider` / `agent:remove-custom-provider`），
全部走 `validateWorkspaceId` + `validateCustomProviderInput` / `validateCustomProviderPatch` /
`validateExtraTopLevelConfig`，拒绝任何非 scalar 的 TOML 值。

`preload/index.ts` 暴露 `electronAPI.agent.getProviders/...`，并定义 renderer 用的
`CodexProviderRecord` / `CodexCustomProviderInput` 类型镜像（避免渲染端 import 主进程文件）。

### Renderer

- `useSettingsStore` 加 `providers: { builtins, custom, activeId, apiKeys, loaded, loadError }` slice +
 `loadProviders` / `selectProvider` / `saveProviderKey` / `addProvider` / `updateProvider` /
 `removeProvider` 等 actions。`loadFromService` 末尾自动触发 `loadProviders()`。
- `setCodexApiKey` 现在同步更新 `providers.apiKeys[activeId]`，老 UI 路径仍然可用。
- 新组件 `pages-react/settings/CodexProviderManager.tsx`：grid 列出 builtins + customs
 + 「+ 添加自定义」卡片；自定义卡显示「编辑/删除」按钮；底部显示当前 provider 的
 API Key 输入框 + 保存按钮；`ProviderEditModal` 实现完整的 add/edit 表单（包括 JSON 形式的
 `extraTopLevelConfig`，前端做了 scalar 校验）。
- `SettingsPage.tsx` 把原来"CODEX AGENT API KEY"区替换为 `<CodexProviderManager />`，
 测试连接按钮保留。

## 缓存策略说明（写在 doc 里供用户决策）

| Provider | 缓存 | gpt-5.2 input | gpt-5.2 cache read | 适合 |
|---|---|---|---|---|
| API易 (`api.apiyi.com/v1`) | ❌ 不支持 | $0.35/M（无优惠） | n/a | 临时实验、低频任务 |
| Right Code `/codex` (Codex 日抛plus 0.2x) | ✅ | $0.35/M | **$0.035/M（1/10）** | 长会话 / Codex Agent 主力 |
| Right Code `/codex-pro` (正价 0.4x) | ✅ | $0.7/M | $0.07/M（1/10） | 日抛被限流时的兜底 |
| OpenAI 直连 | ✅ | 官方 5x 价 | 1/10 input | 不计成本 / 数据敏感 |

> 实测：Right Code `/codex` 端点对 `gpt-5.2`、`gpt-5.3-codex`、`gpt-5.4`、`gpt-5.5`
> 全系 reasoning_effort 变体（low/medium/high/xhigh）都开启 cache_read，价格统一为 input 的 10%。

## 测试

- 后端 4 套件 + 1 集成总计 **46 个新测试** 全部通过：
 - `codexProviders.test.ts`（6）— 内置 preset、id 校验、resolve helpers
 - `CodexProviderStore.test.ts`（9）— 持久化、迁移、CRUD、原子写、loadSync 回退
 - `codexLaunch.test.ts`（16）— `-c` 参数注入（含 model/reasoning_effort/verbosity/extra）
 - `ipc.test.ts`（15）— 全部 6 个新 channel 的成功/失败/校验/error wrapping 路径
 - `AgentManager.test.ts` — 现有 setCodexApiKey 测试已迁移到读 `codex-providers.json`
- 完整 `npx vitest run` 共 **1305 passed / 17 failed**；17 个失败 100% 是 pre-existing
 （storyboard pipeline、smartErase、AgentChatPanel 等无关模块），git stash 验证一致。
- `npx tsc --noEmit` 在新增的 `useSettingsStore.ts` / `SettingsPage.tsx` /
 `CodexProviderManager.tsx` / 主进程文件上零错误，其它报错全为 pre-existing。

## 迁移

- v4.2.x 用户的 `<userData>/codex-agent.json` 会在 v4.3.0 首次启动时被读到内存，
 然后通过 `CodexProviderStore.load()` 写入 `codex-providers.json` 的 `apiKeys.apiyi`。
- 旧文件保留不动，新文件成为权威源。
- `localStorage["codex_api_key"]` 仍同步写入一次，方便回滚到 v4.2.x（不会丢 key）。

## 引用

- API易缓存政策：[https://docs.apiyi.com/faq/cache-billing](https://docs.apiyi.com/faq/cache-billing)
- Right Code Codex 配置：[https://docs.right.codes/docs/rc_cli_config/codex.html](https://docs.right.codes/docs/rc_cli_config/codex.html)
- Right Code 模型/价格表（登录后）：[https://www.right.codes/models](https://www.right.codes/models)
- Codex CLI cache hit issue：[openai/codex#20301](https://github.com/openai/codex/issues/20301)
- 扩展缓存保留请求：[openai/codex#18130](https://github.com/openai/codex/issues/18130)
