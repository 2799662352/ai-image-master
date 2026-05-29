# apiyi-mcp-server 集成 设计文档

**Date**: 2026-05-22
**Status**: Brainstorming complete, awaiting user sign-off
**Branch**: `feature/apiyi-mcp-integration`(off `origin/main` after v4.3.15)
**Estimated**: 3 PRs (~150 + ~250 + ~120 行)

## 目的

把 `apiyi-mcp-server`(https://github.com/2799662352/apiyi-mcp-server)内嵌到 Codex 页,让用户在不切出 app、不装 Docker、不跑 npm 的前提下,把 `理解图片/视频/音频/PDF`(Gemini/GPT 系列多模态)直接接入 Codex agent loop。

具体三件事:

1. **Vendor 进 app**: `resources/apiyi-mcp/` 跟 app 一起打包,免装 Docker / 免装 npm 依赖,Node 子进程跑 stdio MCP。
2. **Codex chat 新增 picker**: 独立"🎥 视频理解"模型选择器,放在现有 Agent picker 旁,紧凑 dropdown。
3. **设置弹窗新增字段**: "🎥 视频理解 API Key (api.apiyi.com)" 独立 input,保存后自动启用 MCP server + 热加载。

## 当前状态(已有 vs 缺失)

| 组件 | 已有 | 缺失 |
|---|---|---|
| Codex MCP 配置层 | `mcp_servers` TOML merge ✅(`codexConfigMerge.ts`);`enabled: false/true` 字段 ✅;workspace 覆盖 personal ✅;`docker-mcp-gateway` 已经有 supervisor ✅ | apiyi entry 写入 + hot-reload trigger |
| Resource bundle | `resources/codex/${platform}-${arch}/codex.exe` ✅(`paths.ts:getCodexResourceRoot`);electron-builder `extraResources` ✅;`process.resourcesPath` 解析 ✅ | `resources/apiyi-mcp/` 目录 + vendor 脚本 |
| Vision 模型 catalog | `vision-models.json` 12 条 ✅;`defaultModel: 'gemini-3-flash-preview'` ✅ | `gemini-3-5-flash` 缺;`supportsVideo` 字段缺;`defaultVideoModel` 缺 |
| Settings 弹窗 | `#settingsModal`(HTML 外壳)+ `#settings-react-root`(React 接管)✅;`SettingsPage.tsx` ✅;`ApiKeyInput` 组件 ✅;"图像理解 API Key" 字段 ✅ | "视频理解 API Key" 字段 + IPC |
| Agent chat | `ModelPicker.tsx`(Agent 模型选择)✅;footer 布局 ✅ | "🎥 视频理解" picker 组件;`useAgentChatStore.videoModel` 字段 |

## 设计

### Task A — vendor `apiyi-mcp-server` 进 `resources/`

**目标**: app 打包时把 `apiyi-mcp-server` 的 production artifacts(`dist/` + `package.json` + `node_modules/`)放进 `resources/apiyi-mcp/`,运行时主进程 `spawn(process.execPath, ['resources/apiyi-mcp/dist/index.js'], { env: { APIYI_API_KEY } })`。

**子任务**:

1. **Vendor 脚本** `scripts/vendor-apiyi-mcp.mjs`:
   - 输入: 目标 commit hash(写在 `scripts/vendor-apiyi-mcp.lock.json`)
   - 行为: shallow `git clone --depth=1 --branch=<tag>` → `npm ci --production --no-audit` → 把 `dist/` + `package.json` + `node_modules/` rsync 到 `resources/apiyi-mcp/` → 写 `version.json`(含 commit、build time、SHA256 of dist)
   - 失败 → exit 1(让 `prebuild` 中止打包)
   - 幂等: 检测 `version.json` 已存在且 commit 匹配则跳过

2. **`package.json` hook**:
   - `"prebuild:vendor": "node scripts/vendor-apiyi-mcp.mjs"`
   - `"build"` / `"release:cn"` 前置依赖 `prebuild:vendor`
   - `.gitignore` 加 `resources/apiyi-mcp/`(产物不入 git,只入 release tag)

3. **`electron-builder.yml`**:
   - `extraResources` 添加 `resources/apiyi-mcp/**`,确保 packaged app 含此目录
   - 现有 `resources/codex/**` 模式不变,新增条目跟它平级

4. **新模块** `src/main/agent/apiyiMcpLauncher.ts`(~90 行):
   ```ts
   export function getApiyiMcpEntryPath(opts: {
     appPath: string
     isPackaged: boolean
     resourcesPath?: string
   }): string {
     const root = getCodexResourceRoot(opts) // 复用 paths.ts
     return path.join(root, 'apiyi-mcp', 'dist', 'index.js')
   }

   export function buildApiyiMcpConfigEntry(opts: {
     entryPath: string
     enabled: boolean
   }): Record<string, unknown> {
     return {
       command: process.execPath, // Electron 自带 Node
       args: [opts.entryPath],
       enabled: opts.enabled,
       env: {} // APIYI_API_KEY 由 codex 通过 mcp env 注入,主进程读 keychain 后填充
     }
   }
   ```

5. **首启 seed** `src/main/agent/codexConfigStore.ts` 扩展:
   - 检测 `mcp_servers.apiyi` 不存在 → 写入 `enabled: false` 占位条目(用 `buildApiyiMcpConfigEntry({ enabled: false })`)
   - 已存在则不动(尊重用户手改)

**为何不用 Docker / npm 即装**:
- Docker: 国内用户安装率不到 10%,免装是杀手特性
- npm install: 用户机无 npm / 网络受限(国内 GitHub 慢)
- Vendor: 增加 ~50MB 打包体积,但零运行时依赖,适合"打开即用"产品定位

### Task B — settings 新增"🎥 视频理解 API Key"字段

**文件**: `src/renderer/src/pages-react/SettingsPage.tsx`(~30 行 + i18n)

**位置**: 紧接现有 `👁️ 图像理解 API Key(可选)` ApiKeyInput 之后,共用一个 "API Key" section。

```tsx
<ApiKeyInput
  label="🎥 视频理解 API Key (api.apiyi.com)"
  description="用于视频 / 音频 / PDF 理解(apiyi-mcp-server),需在 https://api.apiyi.com 申请"
  placeholder="sk-..."
  testId="apiyi-video-api-key"
  onSave={async (key) => {
    await window.electronAPI.saveApiyiVideoKey(key)
  }}
  initialMaskedValue={maskedApiyiVideoKey}
/>
```

**新 IPC** `agent:save-apiyi-key(apiKey: string)`(`src/main/agent/ipc.ts`):

1. **持久化**: 写到 `userData/codex-providers.json`(沿用 `CodexProviderStore` 同款明文 JSON,与现有 codex provider key 一致)。新增字段 `apiyiVideoKey?: string` 到 `PersistedProvidersV1`,版本号 bump 到 2;`load()` 走升级路径兼容 v1。
   - **不另起新存储**: 跟现有 codex key 同 file,审计 / 备份 / 清理统一
   - **不明文 localStorage**: 现有 `vision_api_key_${site}` 在 localStorage 是历史包袱,新字段不再沿用这条线 —— 避免 XSS / DevTools leak
   - **不做加密**: 这是项目当前安全模型(`codex-providers.json` 即明文);加密升级是独立 PR,新字段一起跟随
2. **localStorage 副本**: `apiyi_video_api_key_mask`(`'sk-***xxxx'`,末 4 位)供 UI 渲染初值用;**不存完整 key**
3. **TOML 写入**: 把 `mcp_servers.apiyi.enabled` 设为 `true`,`env.APIYI_API_KEY` 设占位 `${APIYI_API_KEY}`(实际值由主进程 spawn child 时从 `codex-providers.json` 读取后注入 `process.env`,**不写明文进 TOML**)
4. **热加载**: 调用 `AgentManager.reloadMcpConfig()`(已有方法),复用 docker gateway 同款机制

**Key 删除**: 同 IPC 传空串 `agent:save-apiyi-key('')`:清 `apiyiVideoKey` + `enabled: false` + reload + 清 mask。

**Masked 初值来源**: React 启动 `agent:get-apiyi-key-mask()` IPC → 主进程读 `codex-providers.json.apiyiVideoKey` → 返回 masked 给 React。

### Task C — Codex chat 新增"🎥 视频理解"picker

**新增文件** `src/renderer/src/features/agent-chat/VideoModelPicker.tsx`(~80 行)

**修改文件**:
- `src/renderer/src/features/agent-chat/AgentChatPanel.tsx`(集成,~10 行)
- `src/renderer/src/features/agent-chat/store.ts`(`videoModel` 字段,~5 行)
- `src/renderer/public/data/vision-models.json`(数据,~25 行)

#### `vision-models.json` 改动

1. **新增条目** `gemini-3-5-flash`(参考 https://docs.apiyi.com/news/gemini-3-5-flash-launch):
   ```json
   {
     "id": "gemini-3-5-flash",
     "name": "Gemini 3.5 Flash",
     "displayName": "Gemini 3.5 Flash",
     "shortName": "G3.5 Flash",
     "description": "Google 新一代多模态轻量旗舰,原生支持视频/音频/PDF 理解",
     "features": ["视频原生", "极速响应", "多模态融合"],
     "price": "$0.18/$0.72 per 1M tokens",
     "icon": "🎥",
     "recommended": true,
     "supportsVideo": true
   }
   ```

2. **`supportsVideo: boolean`** 字段加到每条 model;以下 5-6 条标 `true`:
   - `gemini-3-5-flash`(新)
   - `gemini-3-pro-preview`
   - `gemini-3-flash-preview-thinking`
   - `gemini-3-flash-preview`
   - `gemini-2.5-flash-preview-09-2025`
   - `gpt-5.2`(GPT 系列旗舰也支持 video frame analysis)

3. **顶层新增** `"defaultVideoModel": "gemini-3-5-flash"`

#### `VideoModelPicker.tsx` 行为

- 紧凑 dropdown,触发按钮 `🎥 [shortName]` 占位 ~120px;关闭时只显示 icon `🎥`
- 打开时 fetch `vision-models.json` → `models.filter(m => m.supportsVideo)` → 渲染:
  ```
  ┌─────────────────────────────────┐
  │ 🔑 设置 API Key       (未配置)  │  ← 缺 key 时高亮
  ├─────────────────────────────────┤
  │ 🎥 Gemini 3.5 Flash      ✓     │
  │ 💎 Gemini 3 Pro                 │
  │ 🤔 Gemini 3 Flash Thinking      │
  │ ⚡ Gemini 3 Flash                │
  │ ⚡ Gemini 2.5 Flash              │
  │ 🚀 GPT-5.2                      │
  └─────────────────────────────────┘
  ```
- 头部"🔑 设置 API Key"行为:
  - `localStorage['apiyi_video_api_key_mask']` 缺失 → 显示红色 dot + "(未配置)"
  - 点击 → `window.dispatchEvent(new Event('open-settings-modal'))`(沿用现有事件)→ 滚到 vision section
- 选中模型 → `useAgentChatStore.setVideoModel(id)` + localStorage `'codex_video_model'`
- 缺 key 状态下选中模型 → 显示 inline toast "未配置 API Key,点击设置后生效"(不阻塞选择,允许用户先选)

#### `AgentChatPanel.tsx` 集成

`ModelPicker`(Agent 模型)紧接其右插入 `<VideoModelPicker />`,中间 4px 分隔。footer 总宽度允许;移动端两个 picker 折叠为 icon-only(沿用 ModelPicker 已有响应式)。

#### MCP 工具暴露

`apiyi-mcp-server` 默认导出 4 个 stdio tool:
- `understand_image(image_url | image_base64)`
- `understand_video(video_url | video_path)`
- `understand_audio(audio_url | audio_path)`
- `understand_pdf(pdf_url | pdf_path)`

Codex agent loop 在 MCP load 后自动发现这些 tool。**app 端不需要 schema 声明** —— `mcp_servers.apiyi` enabled 后,codex 通过 `mcp/list_tools` 拉到。

`VideoModelPicker` 选择的 model 通过 `mcp_servers.apiyi.env.APIYI_MODEL` 传给子进程;子进程在 `understand_video` 调用时优先读这个 env(若 apiyi-mcp-server 上游不支持,做一层 thin wrapper)。

## 决策快照(brainstorm 冻结)

| 决策点 | 选择 |
|---|---|
| MCP 跑法 | Vendor 仓库 → `resources/apiyi-mcp/` → `spawn(process.execPath, [dist/index.js])`,stdio |
| Default-on 语义 | 首启 seed `enabled: false`;key 保存后 `enabled: true` + reload |
| Key 存储位置 | `userData/codex-providers.json`(沿用 `CodexProviderStore` 同 file,明文,与项目现状一致);localStorage 只存 masked |
| Key 作用域 | 全局(`apiyi_video_api_key`),跨"API 站点"独立,与 image gen key / vision key 解耦 |
| Picker UI | 紧凑 dropdown,与现有 `ModelPicker` 一致;头部"🔑 设置 API Key"指向设置页 |
| Picker 位置 | Chat footer,Agent picker 紧右侧 |
| Model catalog | 复用 `vision-models.json` + 新增 `supportsVideo` 字段过滤 |
| 默认视频模型 | `gemini-3-5-flash`(新增) |
| 子进程 IO | stdio JSON-RPC(MCP 标准) |
| 失败恢复 | 子进程 crash → AgentManager 自动重启(沿用 docker gateway supervisor) |
| Key 删除 | 同 IPC 传空串;清 keychain + `enabled: false` + reload |
| PR 拆分 | A(vendor + spawn,无 UI 影响)→ B(settings + IPC)→ C(picker + catalog) |

## Out of scope(明确推迟)

- **Docker fallback**: 用户不需要 Docker 即可用,Docker 模式留给 power-user 单独 PR
- **通用 vendor 框架**: 本 PR 只 vendor apiyi 一个;后续若要 vendor 第二个 MCP server,再抽通用层
- **视频文件拖入 chat input**: 沿用现有附件管线(`@video file.mp4`),无需特殊处理
- **视频理解结果在 chat message 的结构化解析**: codex agent 自己处理 tool response,UI 不预解析
- **多账号 / 多 key 切换**: YAGNI,单 key
- **计费 / 用量 UI**: apiyi 自带 dashboard,不复刻
- **Picker 显示价格 / features**: 紧凑 dropdown 不放;若需要详细信息,用 `#visionModelModal` 大卡片(独立功能)
- **图像理解 key 与视频理解 key 自动同步**: 不做;两个独立字段,用户自决

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| `apiyi-mcp-server` 仓库被删除 / 不维护 | Vendor 进 app,锁 commit hash;`scripts/vendor-apiyi-mcp.lock.json` 记录确定性快照;断网时 fallback 到本地 cache |
| `npm ci --production` 平台差异(Win/Mac/Linux 原生模块) | Vendor 在 CI 跑(GitHub Actions matrix);失败时 prebuild exit 1;若有原生模块,改用 `--platform` flag 跨平台预编译 |
| Node 子进程内存爆炸(大视频) | 一开始 stream input;不 buffer 整个文件;主进程 watchdog 50 GB 上限 → `process.kill` |
| 用户 vision key vs apiyi key 混淆 | UI label 加 `(api.apiyi.com)` 后缀;tooltip 说明"视频 / 音频 / PDF 走 apiyi";设置页两字段并列时加视觉分组 |
| `codex-providers.json` 损坏 / 写失败 | `CodexProviderStore.load()` 已有 fallback 到 `DEFAULT_STATE`;写失败 → toast"保存失败,请检查磁盘空间";新字段同款 |
| Codex agent 不熟悉 MCP tool naming | 在系统 prompt 末尾追加"📎 You also have access to apiyi MCP for video/audio/PDF understanding"(由 `AgentManager` 注入) |
| 打包体积 +50MB | 接受;比起强制 Docker 依赖小得多 |

## 测试

**Task A**:
- `apiyiMcpLauncher.test.ts`: `getApiyiMcpEntryPath` 在 packaged(`isPackaged=true`)/dev(`isPackaged=false`)两种模式下路径正确(参照 `resolveCodexBinary.test.ts`)
- `codexConfigMerge.test.ts` 扩展: seed `apiyi` entry(personal `enabled:false`)+ workspace 升 `true` → merge 后启用
- `codexConfigStore.test.ts` 扩展: 首启写入占位 entry;已有则不覆盖

**Task B**:
- `SettingsPage.test.tsx`: 渲染层断言新 `ApiKeyInput` 出现;`onSave` 调用 `electronAPI.saveApiyiVideoKey`
- IPC mock: `agent:save-apiyi-key('sk-test')` → `mcp_servers.apiyi.enabled === true` + `reloadMcpConfig` 被调用
- 空串 → 清 keychain + `enabled: false`

**Task C**:
- `VideoModelPicker.test.tsx`: dropdown 展开后只显示 `supportsVideo:true` 条目;计数 = 6
- localStorage 没 mask 时,头部红 dot + "(未配置)" 渲染
- 选中 `gemini-3-5-flash` → `useAgentChatStore.videoModel === 'gemini-3-5-flash'` + localStorage write
- `gemini-3-5-flash.supportsVideo === true` JSON 静态断言

## PR 推进顺序

1. **PR-1**(Task A,~150 行,后端): vendor 脚本 + `apiyiMcpLauncher` + seed `enabled:false`。**不动 UI**,旧用户完全无感;独立可 review。
2. **PR-2**(Task B,~250 行,设置 + IPC): settings 新字段 + `agent:save-apiyi-key` IPC + key 保存→enable→reload 闭环。**有 key 即可工作**,但 Codex 还没 picker —— 用户需在 chat 里手动 @apiyi 才能用上;过渡阶段可用。
3. **PR-3**(Task C,~120 行,Codex UI): `VideoModelPicker` + catalog 加 `gemini-3-5-flash` + `supportsVideo`。完整 UX 闭环 + 热更新发布。

每个 PR 独立可 deploy,失败 / 回滚不互相影响。

## 用户验收点(deployed to v4.3.16 hot update)

1. 全新装的 v4.3.16 → 打开设置弹窗 → 看到"🎥 视频理解 API Key (api.apiyi.com)"字段
2. 填入 apiyi key → 保存 → toast"已启用视频理解"
3. 打开 Codex 页 chat → footer 看到"🎥 视频理解"picker → 默认选中 `Gemini 3.5 Flash`
4. 拖一个 mp4 进 chat,问"这个视频在干什么" → agent 调用 `understand_video` MCP tool → 返回中文描述
5. 删除 key → picker 头部"(未配置)"红色提示 → 选中模型给 inline hint
