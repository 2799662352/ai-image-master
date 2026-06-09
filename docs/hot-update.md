# CATIMATION 热更新发布指南

## 架构概览

应用采用 **COS 优先 + GitHub 兜底** 的双源热更新机制：

```
用户客户端启动
  │
  ├─① 检查腾讯云 COS（国内加速）
  │    https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
  │
  ├─ 成功 → 提示更新 / 下载安装
  │
  └─ 失败 → ② 自动切换 GitHub Releases（海外 / 备用）
       https://github.com/2799662352/ai-image-master/releases
```

核心文件：

| 文件 | 作用 |
|------|------|
| `src/main/updater.ts` | AutoUpdater 类，封装 electron-updater，支持 `switchProvider` 和 `fallback` |
| `src/main/index.ts` | 初始化 updater，配置 COS 主源 + GitHub fallback |
| `electron-builder.yml` | 构建配置，`publish` 段声明 COS + GitHub 双发布目标 |
| `scripts/upload-cos.js` | COS 上传脚本（exe + blockmap + latest.yml） |
| `cos-credentials.json` | 腾讯云 COS 内置凭据（gitignored，打包时通过 extraResources 带入） |

## 发布新版本

### 1. 修改版本号

```bash
# package.json → "version": "x.y.z"
```

### 2. 构建

```bash
npm run build:win
```

产物在 `release/` 目录下：
- `catimation-cyberpunk-master-{version}-setup.exe` — 安装包
- `catimation-cyberpunk-master-{version}-setup.exe.blockmap` — 差分更新数据
- `latest.yml` — 版本元数据（electron-updater 靠它判断是否有新版）

### 3. 上传到 COS（国内用户）

```bash
npm run upload:cos
```

需要 `.env` 文件中配置：
```
COS_SECRET_ID=你的SecretId
COS_SECRET_KEY=你的SecretKey
COS_BUCKET=map-tiles-bucket-1345773498
COS_REGION=ap-guangzhou
```

或一步到位（构建 + 上传）：
```bash
npm run release:cn
```

### 4. 上传到 GitHub（海外 / 备用）

手动上传：
1. 到 https://github.com/2799662352/ai-image-master/releases 创建新 Release
2. Tag 填 `v{version}`（如 `v4.1.16`）
3. 上传 `release/` 下的三个文件

或用 CLI：
```bash
gh release create v4.1.16 --title "v4.1.16" --notes "更新说明" \
  release/catimation-cyberpunk-master-4.1.16-setup.exe \
  release/catimation-cyberpunk-master-4.1.16-setup.exe.blockmap \
  release/latest.yml
```

## Fallback 机制

在 `updater.ts` 中实现：

```typescript
// 初始化时配置 fallback
const updater = getAutoUpdaterInstance({
  provider: 'generic',
  url: 'https://...cos.../releases/',
  fallback: {
    provider: 'github',
    owner: '2799662352',
    repo: 'ai-image-master'
  }
})
```

当 COS 检查更新失败（网络超时、DNS 错误等），`autoUpdater.on('error')` 触发后：
1. 如果还没 fallback 过 → 自动调用 `switchProvider()` 切换到 GitHub
2. 用 GitHub 源重新 `checkForUpdates()`
3. 如果 GitHub 也失败 → 向用户显示错误

## 差分更新

`electron-builder` 的 NSIS 差分更新（blockmap）已启用：

```yaml
# electron-builder.yml
nsis:
  differentialPackage: true
```

用户更新时只下载变化的部分，而非整个 250MB 安装包。前提是 COS / GitHub 上同时存在：
- 新版 `.exe` + `.blockmap`
- `latest.yml`

## 常见问题

### Q: 老版本客户端检测不到 COS 上的更新？

老版本（< v4.1.15）在代码中硬编码了 `provider: 'github'`，只会检查 GitHub。用户需要先手动安装 v4.1.15+，之后的热更新才会走 COS。

### Q: COS 和 GitHub 的 latest.yml 版本不一致？

两边独立上传，可能短暂不一致。建议每次发版都同时上传两边。COS 用 `npm run upload:cos`，GitHub 手动上传或用 `gh` CLI。

### Q: 上传 COS 时 ECONNRESET？

通常是代理/VPN 干扰了 TLS 握手。切换直连或换节点后重试。

### Q: latest.yml 在 COS 上缓存了旧版本？

腾讯云 COS 默认不缓存，上传即生效。如果用了 CDN 加速，需要刷新缓存：
```
https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml
```

## Changelog

### v4.3.28 (2026-06-09) — Codex 多对话并行 + 图像归属修复 + subagent 一等公民 + 侧栏/工作区持久化

围绕 Codex 聊天的「多对话并行」补齐一整套:开新对话/切换不再打断或污染其它对话,生成的图片永远落在发起它的对话里,并把 subagent 做成内置能力。全部按 `systematic-debugging` 取证到根因(含 codex 源码/官方 issue + 运行时 `_meta` 实测)。

**A. 多对话并行(渲染层 store 重构,零后端改动)**

根因:后端 / Codex / `CodexProtocolClient` 早支持并发 turn,卡点只在渲染层一个全局 store(单 `messages`/`isRunning`/`threadId`,`applyEvent` 丢弃非活动线程事件)。

| 改动 | 文件 | 说明 |
|------|------|------|
| 按线程分桶 + 纯函数 reducer | `src/renderer/src/features/agent-chat/store.ts` | 抽出 `reduceThreadSlice`;新增 `threadSlices`(后台线程)+ `runningByThread`(每线程运行态);`applyEvent` 按 `event.threadId` 路由(活动→可见视图,其它→各自后台桶,不丢不漏) |
| 切换/新建不杀旧 turn | 同上 | `newThread`/`switchThread` 快照当前→恢复目标(优先用更新的后台桶),**绝不 cancel** 旧 turn;`send`/`cancel` 按线程维护运行态 |
| 新对话不串旧任务 | 同上 | adoption 仅认 `thread_created` 事件,避免后台线程的流被新空对话「领养」 |
| 侧栏可并行 | `src/renderer/src/features/agent-chat/ThreadSidebar.tsx` | 运行中也能自由切换(去掉禁用),每个对话标题前脉动蓝点表示「正在跑(可切走不中断)」 |
| 发送即刷新侧栏 | `store.ts` | 新对话 `send` 后立即 `refreshThreadList`,新行秒现(不再等 `turn_completed`) |

**B. 生成图片归属到发起对话(根因:MCP 图像路径绕过线程路由)**

`generate_image` 经 `AgentToolExecutor` 直写「活动」对话,与线程无关 → 切走后图片落到别的对话。运行时实测确认 Codex 在 **`mcpReq._meta`**(`threadId` + `x-codex-turn-metadata.thread_id`,见 openai/codex#15190/#18093)带了发起线程。

| 改动 | 文件 | 说明 |
|------|------|------|
| 提取 codex 线程 id | `src/main/mcp/tools/imageTools.ts` | `extractCodexThreadId(ctx)` 读 `mcpReq._meta` → 传给 `router.call` |
| 反查 codex→db 线程 | `ToolRouter`(`setThreadIdResolver`)+ `AgentManager.resolveDbThreadId` + `index.ts` 接线 | 把 codex UUID 反查成 db threadId,挂到 `AgentToolRequest.threadId` |
| 按线程渲染图片气泡 | `AgentToolExecutor.ts` + `store.ts`(`patchThreadMessages`、begin/resolve/fail 带 threadId) | 用权威 `request.threadId` 把生成中/完成/失败气泡定位到发起对话(缺失时回退发起时刻活动线程)。即使 5 张并发 + 快速切换也不串 |

**C. Codex subagent 一等公民**

| 改动 | 文件 | 说明 |
|------|------|------|
| 并发配置 | `src/main/agent/codexLaunch.ts` | 注入 `-c agents.max_threads=8` + `agents.max_depth=1` |
| 引导技能 | `src/main/agent/firstPartySkills.ts`(`catimation-subagents`) | 教 agent 何时/如何并行委派(多目标研究、多图分析、批处理),用 `spawn_agents_on_csv`/内置 explorer;多图生成仍走 `catimation-image` |

**D. 工作区持久化(根因:启动 reload 在同步 allowed-roots 之前 listDir)**

`fs:list-dir` 受 `assertContained` 的 allowed-roots 门控,而该门控每次启动清空。`loadWorkspaceFolders` 在 `syncAllowedRoots` 之前 listDir → 持久化的文件夹被拒 → 显示「No folder open」。修复:`loadWorkspaceFolders` 先 `await syncAllowedRootsNow(roots)` 再列目录(对齐 `pickWorkspaceFolder`)。文件:`src/renderer/src/features/file-explorer/store.ts`。

#### 用户可见行为

1. 开新对话 / 切对话,旧对话继续在后台跑、进度不丢、图片不串;右下角 Stop 只停当前这条
2. 发送新对话后侧栏立即出现该对话(脉动蓝点 = 正在跑)
3. 生成的图片永远落在发起它的对话里(含 5 张并发 + 快速切换)
4. 对 Codex 说「并行开 N 个 agent / 拆开做」即可并发子代理
5. 打开工作区文件夹后重启客户端,文件夹自动恢复(不再「No folder open」)

#### 验证

- 新增/更新单测:`store.parallel`(8)、`store.sendRefreshList`(2)、`store.loadWorkspaceFolders`(1)、`ToolRouter`(3)、`revealInExplorer`(18)、`codexLaunch`(21)、`firstPartySkills`(9)、`imageTools`(8)、`AgentToolExecutor.generateImage`(10)、`store.streaming/plan/ThreadSidebar` 等全绿;触碰文件 lint 干净、typecheck 无新增错误。

---

### v4.3.27 (2026-06-09) — Codex 生图:完成提醒+路径直达 + 聊天蓝链可点定位文件栏 + 参考图主动复用(多图)

本版本聚焦 Codex 聊天里 `catimation` 生图的「收尾体验」与「素材复用」,三条线都按 `systematic-debugging` 取证到根因(含 codex / react-markdown 源码与官方 issue)。

**A. 生图后 Codex 一定知道「完成 + 文件在哪」,不再傻等 / 搜全盘**

根因(codex 官方 issue 取证):Codex 把模型可见的 MCP 工具结果**截断到 ~10 KiB / 256 行**([openai/codex#6544](https://github.com/openai/codex/issues/6544)),并在有 `structuredContent` 时**丢弃 `content[]`/`resource_link`**([#10334](https://github.com/openai/codex/issues/10334))。于是 `generate_image` 的存盘路径被埋没、`query_history` 又因含多 MB base64 而被截断成乱码 → 模型收不到完成信号、转而 shell 搜文件系统(`exit 124` 超时)。

| 改动 | 文件 | 说明 |
|------|------|------|
| `generate_image` 返回精简「完成横幅」 | `src/main/mcp/tools/imageTools.ts` | 首个 text 块改成 `✅ generate_image DONE` + `📁 SAVED FOLDER` + `FILES:` 全路径 + 紧凑 `{…,dir}` JSON,<2KB 不会被截断;路径写在**纯文本**里(不只 `resource_link`),并明确「别 query_history、别搜文件系统」 |
| `query_history` 精简去 base64 | `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` | 投影成 `{id,type,prompt,model,ratio,timestamp,imageCount,urls(≤4,仅 http/file)}`,剥离全部 data: URL;描述改为「仅用于翻旧记录,定位刚生成的图请用 generate_image 的 paths/dir」 |
| skill 写入定位规则 | `src/main/agent/firstPartySkills.ts` | 成功返回即任务完成;用返回的 paths/dir 定位,**绝不** query_history 或 shell 搜索刚生成的图 |

> 备注:Codex `PostToolUse` hook 在 Windows 上禁用,不能用来「提醒」,所以走「工具结果文本 + skill」这条可靠通道。

**B. 聊天里的蓝色链接可点击 → 在左侧 FILES 栏真实定位(图片/文档通用)**

根因:react-markdown v10 的 `defaultUrlTransform` 只放行 `http(s)/mailto/xmpp`,把 `file://` 和 `C:\…` 本地链接**清洗成空** → 点击走默认 `target=_blank` 弹浏览器;存活的 R2/COS `https` 图片链接也因「非本地」被默认外链打开。

| 改动 | 文件 | 说明 |
|------|------|------|
| 纯函数解析器 | `src/renderer/src/features/file-explorer/revealInExplorer.ts`(新) | `osPathFromHref`(支持 `file://`/`local-file://`/裸 Win/POSIX,拦截 `..`)、`isImageHref`、`isAncestorPath`;单测 18 例 |
| 保留本地链接 + 点击路由 | `src/renderer/src/features/agent-chat/MarkdownContent.tsx` | `urlTransform` 让本地路径不被清洗;`<a>` onClick:本地路径→`revealPath`(开栏+选中+滚动+右侧查看器),远程图片→聊天内灯箱,真外链→浏览器 |
| reveal 能力 | `src/renderer/src/features/file-explorer/store.ts` + `FileTreeNode.tsx` | 新增 `revealPath(absPath)`:开面板→按需展开祖先目录→选中→`openTab` 显示→派发 `file-explorer:reveal` 事件;节点监听后展开祖先 + `scrollIntoView` |
| 文档同样支持 | (既有 `classify`) | `.md/.json/.ts/.yaml…` 归为 text → `FileViewer` 渲染,本地文档链接一并可点开 |

**C. 用户给了参考图,主动复用做图生图(可多张)**

缺口:skill/工具描述没要求「用户贴了图就当 `referenceImages` 用」,模型可能忽略素材做了文生图。

| 改动 | 文件 | 说明 |
|------|------|------|
| 工具描述强约束 | `src/main/mcp/tools/imageTools.ts` | `referenceImages` 注明:用户提供/附带图(prompt 里 `[Attached files…]`/`[Referenced files…]`)或说「按这张/参考这张/edit this」时**必须**传;且**接受多张**,全部相关图一起传 |
| skill 复用规则 | `src/main/agent/firstPartySkills.ts` | 新增「Reference images」段:有素材就主动 image-to-image、不静默退回文生图;**可传多张不限一张**(角色+背景/多角度/主体+风格) |

#### 用户可见行为

1. Codex 生图完成后立即确认「已生成 + 文件夹路径」,不再卡顿空等或乱搜文件
2. 聊天里点蓝色链接:本地图片/文档在左侧 FILES 栏定位并在查看器显示;远程图片弹聊天内灯箱;真正外链才开浏览器
3. 贴了参考图说「按这张生成」,模型会主动图生图;给多张会一起参考

#### 验证

- `imageTools.test.ts` 8/8、`revealInExplorer.test.ts` 18/18、`AgentToolExecutor.generateImage.test.ts` 10/10 通过;触碰文件 lint 干净、typecheck 无新增错误

---

### v4.3.26 (2026-06-07) — 3D 导演台:撤销/重做 + 框选多选移动 + 可重映射快捷键 + 预设姿势保持高度 + 全景统一光感面板

本版本围绕 3D 导演台(Director)交互完整度与全景编辑器(PanoramaEditor)的统一光感/调色体验,补齐"专业 3D 编辑器该有的快捷键与多选"一整套能力,并修掉一个姿势预设的定位 bug。

**A. 导演台快捷键 + 多选 + 历史**

| 改动 | 文件 | 说明 |
|------|------|------|
| 撤销/重做命令栈 | `src/renderer/src/components/shared/image-editors/director/DirectorStageScene.tsx` | 命令栈(上限 60 条)记录 gizmo 变换 / 增删 / 复制 / 姿势前后快照;删除/新增的对象保活,掉出历史窗口才 dispose。`Ctrl+Z` / `Ctrl+Shift+Z` 触发 |
| 左键框选 + 多对象移动 | 同上 | `框选`工具开关禁用 OrbitControls 左拖,DOM marquee 选中包围盒中心落入框内的模型;拖动时多选对象临时挂到 pivot,松手再归位 `modelsGroup`。微小拖动回退单击选择,空白处单击取消选择 |
| 标准 3D 快捷键 | 同上 | `W/E/R` 平移/旋转/缩放、`F` 聚焦、`Q` 世界/本地坐标系、`Delete` 删除、`Ctrl+D` 复制、`Shift` 拖动吸附、`Esc` 取消选择/退出框选 |
| 可重映射快捷键(单一事实来源) | `src/renderer/src/components/shared/image-editors/director/directorShortcuts.ts`(新) | 动作与按键解耦:`SHORTCUT_DEFS` / `DEFAULT_KEYMAP` / `eventToToken` / `tokenToAction` / `tokenLabel`。UI 改键只改 token,场景按 token 匹配动作,Mac ⌘ 归一到 `ctrl` |
| 快捷键面板可视化改键 | `src/renderer/src/components/shared/image-editors/director/DirectorEditor.tsx` | 「快捷键」面板列出可改动作 + 固定交互说明;点击捕获新键(`stopImmediatePropagation` 防止误触场景)、冲突自动解绑、`usePersistentState` 持久化、「恢复默认」一键还原。工具栏新增 删除/复制/撤销/重做/框选/聚焦 按钮(撤销重做按可用性禁用) |

**B. 预设姿势保持垂直位置(bug 修复)**

用户把模型移到地面以下再点预设姿势,模型会被错误地拉回地面以上。根因是 `applyPoseToObject` 内调用了 `groundPosed` 强制归位 `y=0`。修复:改用 `lowestSkinnedY` 测量蒙皮最低点,套用姿势前先记 `prevLowY`,套用后按 `prevLowY - newLowY` 回补 `obj.position.y`,保留模型原有"脚底高度",不再强制归位。

**C. 全景编辑器统一光感/调色面板**

把导演台的光感(曝光/辉光/对比/饱和/色温/暗角/颗粒 + tonemap + IBL + 景深 DoF)抽成可复用组件,接到全景编辑器:

| 改动 | 文件 | 说明 |
|------|------|------|
| 可复用后处理 | `src/renderer/src/components/shared/image-editors/postfx/{createLightFx,lightFxConstants}.ts`(新) | UnrealBloom + Grade ShaderPass(曝光/对比/饱和/色温/暗角/颗粒)+ BokehPass DoF + PMREM IBL,导演台/全景共用 |
| 统一光感 UI | 共享 `LightFxPanel` 组件 | 两个编辑器同一套 props 驱动的面板;全景因球面 `MeshBasicMaterial` 隐藏 IBL 控件(不生效),保留 DoF 做创意效果 |
| 接线 | `src/renderer/src/components/shared/image-editors/PanoramaEditor.tsx` / `LightEditor.tsx` | 在保留全景自有超采样的前提下叠加 Bokeh + Grade pass |

#### 用户可见行为

1. 导演台支持完整快捷键(可在面板里自由改键并持久化)、左键框选多选移动、撤销/重做
2. 把模型移到地面下再套预设姿势,模型停在原垂直位置,不再弹回地面
3. 全景编辑器拥有与导演台一致的光感/调色/景深面板

---

### v4.3.25 (2026-06-06) — catimation 生图对齐 codex 原生 + 多图并发 + 生成后自动查看

**目标**:让 Codex 聊天里的 `catimation` 生图工具(`generate_image`)在「返回契约 / 多图并发 / 生成后自查」三方面对齐并超过 codex 原生 `image_gen`。

**根因调查(systematic-debugging + codex 源码取证)**

用户反馈"生成 3 张图时 UI 上感觉不到并发,是一张张来的"。逐层取证:

- `ToolRouter`(主进程,`pending` map 按 id 索引)与 `AgentToolExecutor`(渲染层,`void this.handle(request)` + 无单飞锁)**都能并发**,不是执行瓶颈。
- 决定模型「能否一轮发多个工具调用」的字段来自 **模型** 而非 MCP 服务器:`core/src/session/turn.rs:974` `parallel_tool_calls: turn_context.model_info.supports_parallel_tool_calls`。
- 未知 slug 才会走 `model_info_from_slug` 兜底(`supports_parallel_tool_calls: false`);而 `OpenAiModelsManager::new` 会用内置 `models.json` 预热(`manager.rs:204`),其中 `gpt-5.5`/`gpt-5.2` 均 `supports_parallel_tool_calls: true`。
- 结论:并发开关本就是开的,真正原因是**模型自行选择串行**(生成一张→叙述→再下一张;对照 codex issue [#14485](https://github.com/openai/codex/issues/14485) "GPT5.4 太爱并发" 印证这是模型裁量)。`ModelsManagerConfig` 没有该字段的 `-c` 覆盖入口,所以走 **提示词** 这一最有效杠杆。

**改动**

| 改动 | 文件 | 说明 |
|------|------|------|
| 返回本地路径 + `resource_link` | `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`、`src/main/mcp/tools/imageTools.ts` | `generate_image` 返回 `{ ok, count, model, historyId, paths }` 并为每个落地文件追加 `resource_link`(`file://`),与 codex 原生 `image_gen` 一样:本地存盘(返回路径)+ 历史页 + ATTACHMENTS 面板 |
| 开启 MCP 并行执行 | `src/main/agent/codexLaunch.ts` | 注入 `-c mcp_servers.catimation.supports_parallel_tool_calls=true`,让 codex 并发执行模型一轮发出的多个生图调用 |
| 技能写入「合理并发」 | `src/main/agent/firstPartySkills.ts`(`catimation-image`) | 新增一节:用户要多张图时**在同一轮一次性发出全部 `generate_image` 调用**(并行工具调用),约 4 张并发为上限、更多分批;仅当后一张依赖前一张返回路径时才串行 |
| 技能写入「生成后自查」 | 同上 | 新增步骤 4:生成后**主动用看图能力打开每个返回的 `path`** 核对(主体/数量/风格/瑕疵/错字),不符就说明并主动重生成;多图逐张查看,检查从简 |

**验证(TDD)**

- `firstPartySkills.test.ts` 9/9、`imageTools.test.ts`、`AgentToolExecutor.generateImage.test.ts` 合计 **26/26 通过**。
- 技能为 app 托管(`.catimation-managed` 哈希标记):内容变更后下次启动自动写入用户 scope `~/.agents/skills/catimation-image/SKILL.md`,用户手改过则不覆盖。

行为:在 Codex 聊天里要"生成 N 张"时,模型倾向于同一轮并发发起多张生图、各自实时进度;生成完成后逐张自查;每张都落地为本地文件并进历史 + 附件面板,路径回传给模型可继续引用。

---

### v4.3.24 (2026-06-05) — 修复:Codex 聊天里生成的图片重开软件后漂移到对话最上方

**用户报告**:在 Codex 聊天栏生成图片后,关闭客户端再打开,图片气泡**漂移到对话最上方**(本该停在它生成时所在的底部位置)。之前一版尝试用「按 `createdAt` 时间顺序插入」修过一次,但问题依旧。

**根因(systematic-debugging)**

图片气泡是渲染层合成的(锚点存在 `localStorage`),重开时要和服务器返回的真实消息合并。两个时间戳来自**不同时刻**,无法跨源排序:

- 直播时 `beginImageGeneration` 直接把图片气泡 **push 到对话末尾**(这一轮最底部)。
- 服务器的助手文字消息是在 `turn_completed` 落库的;图片锚点的 `createdAt` 是工具**生成完成**那一刻 —— 永远早于 `turn_completed`。
- 所以任何「按时间排序」的合并都会把图片排到那段助手文字**之上**;在短对话里就表现为漂到最顶。`v4.3.22` 那次是滚动位置修复,与消息排序无关,帮不上忙。

**修复**

| 改动 | 文件 | 说明 |
|------|------|------|
| 合并策略改为「追加到服务器消息之后」 | `src/renderer/src/features/agent-chat/codexArtifactPersistence.ts` | `mergeCodexArtifacts` 不再按 `createdAt` 插入服务器时间线,而是把重建的图片气泡整体追加到服务器消息**之后**(多张之间才按 `createdAt` 互相排序),还原直播时它所在的底部位置,永不漂顶。纯渲染层改动,不依赖服务器时间戳。 |
| 每条消息加时间戳 | `src/renderer/src/features/agent-chat/MessageBubble.tsx` | 用户/助手气泡头部显示相对时间(如 `5m ago`)+ 绝对本地时间 tooltip,方便用户按时间查找对话。 |
| IPC 边界归一化 createdAt | `src/main/agent/ipc.ts` + `store.ts` | `agent:open-thread` 把 `Date`/ISO 字符串统一转 epoch number 再过 contextBridge;渲染层解析失败兜底 `0`(不再误填 `Date.now()`)。 |

**验证(TDD)**

- `codexArtifactPersistence.test.ts` 9/9 通过(含时钟偏移「服务器时间反而更新」、多锚点底部排序两个回归)。
- agent-chat 相关套件 53/53 通过;时间线无其它按 `createdAt` 重排的代码路径。

行为:Codex 聊天里生成的图片重开软件后**稳定停在生成时的底部位置**,不再漂到最上方。已存对话同样生效(纯客户端合并,无需迁移)。

---

### v4.3.20 (2026-05-23) — 根因修复: packaged installer 漏打 `resources/apiyi-mcp/node_modules`(用户填了 key 也拿不到工具)

**用户报告**:v4.3.19 把"编辑器空白"问题修了之后,用户在 packaged 安装包里**填了有效 apiyi key、把 toggle 打开,但 MCP 始终返回 0 工具**。同一台机器上跑 dev workspace 一切正常,本地 → packaged 这一步出问题。截图对比:

| 字段 | 本地(图 1,正常) | packaged(图 2,坏) |
|------|------|------|
| `command` | `D:\...\temp-ai-image-master-source\node_modules\.pnpm\electron@41.6.1\node_modules\electron\dist\electron.exe` | `C:\...\CATIMATION-Cyberpunk Master.exe` |
| `args[0]` | `D:\...\resources\apiyi-mcp\dist\index.js` | `C:\...\resources\apiyi-mcp\dist\index.js` |
| `env.ELECTRON_RUN_AS_NODE` | `"1"` | `"1"` |
| `env.APIYI_API_KEY` | `sk-W9n6JToxre...`(有效) | 同一把(用户复制过去的) |
| MCP 工具数 | ✅ 返回工具列表 | ❌ 0 工具 |

`enabled: false` 是 seed 设计行为(没 API key 前不让自启动避免噪音 token 错误循环)— 这部分**不是** bug。

**Phase 1 / 根因调查 — 按 systematic-debugging 三层取证 + 一次假设作废**

立即假设 1:**vendoring 没执行**。`scripts/vendor-apiyi-mcp.mjs` 看一眼 — line 96-130 确认它把 upstream `apiyi-mcp-server/node_modules`(npm install --omit=dev 装好的生产依赖)整个 cp 到 `resources/apiyi-mcp/node_modules/`。验证 source 树:

```
PS> cmd /c "dir /s /b resources\apiyi-mcp\node_modules | find /v /c """""
4923
```

source 树**有 4923 个 node_modules 文件**(含 `@google/genai`、`@modelcontextprotocol/sdk` 及全部传递依赖)。vendoring 完全正常。

立即假设 2:**packaged installer 没把它打进去**。验证 release tree:

```
PS> cmd /c "dir /s /b release\win-unpacked\resources\apiyi-mcp | find /v /c """""
20
PS> cmd /c "dir /b release\win-unpacked\resources\apiyi-mcp"
dist
package.json
README.md
version.json
```

**`release\win-unpacked\resources\apiyi-mcp\` 里只有 20 个文件(几乎全是 `dist/` 里的 .js + 4 个元数据文件),`node_modules/` 整个目录消失**。即用户机器上 Electron-as-Node 跑 `dist/index.js` 时,第一行 `import { McpServer } from '@modelcontextprotocol/sdk/...'` 就立刻 throw `Cannot find module`,进程 0 秒内挂掉,codex 拿到 EOF → 报"0 工具"但不知道为什么。

**根因第一次假设(后被作废)** — 起初怀疑是 electron-builder 26.x 的 issue #867:`extraResources.filter` 一旦写成"枚举 include 列表"(每条都是 positive pattern),内部走 `excludePatterns` + `stat.isDirectory()` 路径误杀 `node_modules/` 目录递归。基于这个假设,尝试 attempt 1:

```yaml
# attempt 1 (didn't work):
- from: resources/apiyi-mcp
  to: apiyi-mcp
  filter:
    - "**/*"   # 单条 ["**/*"] 想走 default happy path
```

重新打包验证 — `release\win-unpacked\resources\apiyi-mcp\node_modules\` **依然为 0**。假设作废:issue #867 是相关但**不是这次的根因**。

**根因第二次假设(确认成立)** — 真正的机制是 electron-builder 的 `searchAndCopyNodeModules()` 智能路径。它的 source-tree walker 遇到名字叫 `node_modules` 的子目录,**会无条件触发"production deps 解析"路径**,而不是走 `cpRecursive()`。这个智能路径会:

1. 读取 walker 起点的 `package.json`(主项目根目录的)
2. 从那个 `package.json` 的 `dependencies` 解析需要哪些 production modules
3. 仅复制对应的 modules,**忽略 source 树里实际存在的 node_modules 内容**

主项目 `package.json` 没有 `@modelcontextprotocol/sdk`,也没有 `@google/genai`(它们是 vendored apiyi-mcp 的传递依赖),所以智能路径找到"零个需要复制的 production deps",**整个 nested node_modules 被静默忽略**。这条机制和 filter 写法**无关** — 不管你写枚举列表还是 `["**/*"]`,只要 `from:` 指向一个包含 `node_modules` 子目录的目录,智能路径都会被触发。

证据链:
- attempt 1 改成 `["**/*"]`,packaged tree 仍然 0 个 node_modules 文件 → 排除 filter 写法
- 全部其它 `extraResources` 块(`skills/**/*.md`、`codex*`、`docker-mcp*`)都 OK — 它们都是 **file-level glob 且 `from:` 下没有 nested `node_modules` 目录**
- electron-builder 日志 `searching for node modules pm=pnpm searchDir=D:\tecx\text\temp-ai-image-master-source` — 它在主项目根做 deps 解析,从来没提到 `resources/apiyi-mcp` 子树的 node_modules
- 文档 [electron.build/contents](https://www.electron.build/contents):`**/node_modules/**/*` (only production dependencies will be copied) is added to your custom in any case

**为什么 v4.3.16 → v4.3.19 都没修到这一层**:前四个版本全在 fix 上层症状 — v4.3.16 引入了 vendoring 流程(写出了完美的 source tree),v4.3.17 加 graceful degradation + 修复按钮,v4.3.18 修 `command=undefined` baseline bug + seed 自愈,v4.3.19 修 modal 0px 高度。**没人怀疑过 `electron-builder` 会对名叫 `node_modules` 的子目录无条件触发智能解析路径**,因为 vendored 树里的 `node_modules` 看起来就是一个普通目录。直到这次拿到用户机器的 packaged tree dump,数文件数对照才把机制钉死。

**Phase 2 / 修复 — 把 node_modules 拎出来做独立 from**

绕开智能路径的关键:**让 `from:` 直接指向 `node_modules` 内部**,这样它上面没有 `package.json` 可读,智能路径找不到 manifest 就回退到 plain `cpRecursive()`。`electron-builder.yml` 改动:

```yaml
- from: resources/apiyi-mcp
  to: apiyi-mcp
  filter:
    - "**/*"
    - "!node_modules"
    - "!node_modules/**/*"   # 让 walker 完全跳过 nested node_modules
- from: resources/apiyi-mcp/node_modules
  to: apiyi-mcp/node_modules
  filter:
    - "**/*"                  # 从 node_modules/ 内部启动 walker,不触发智能路径
```

两个 from 块的角色分工:
- 第一个块负责 `dist/` + `package.json` + `README.md` + `version.json`(主体内容),显式 negate `node_modules` 让 walker 知道不要碰它
- 第二个块直接从 `node_modules/` 内部启动,绕过"父级有 manifest → 触发智能路径"的判定 → 走 plain copy

验证 attempt 2 包出来的产物:

```
PS> dir /b release\win-unpacked\resources\apiyi-mcp
dist
node_modules         ← 回来了
package.json
README.md
version.json
PS> dir /s /b release\win-unpacked\resources\apiyi-mcp\node_modules | find /v /c ""
4922                 ← 4923 source 里有 1 个被默认 ignore(README.md 之类)
PS> dir /b release\win-unpacked\resources\apiyi-mcp\node_modules\@modelcontextprotocol
sdk                  ← 核心 dep 在
PS> dir /b release\win-unpacked\resources\apiyi-mcp\node_modules\@google
genai                ← 另一个核心 dep 在
```

installer 体积:**45 MB(attempt 1)→ 370 MB(attempt 2)**,差额 ~325 MB 就是 node_modules 真正进来后的 production deps + tree shake 不掉的资源。这是必要代价。

注释里把两次假设的来龙去脉、为什么必须分两个 from、智能路径触发条件全部写死,后人改这块前会看到血泪史。

**为什么不加单元测试**:这是 build-tool 配置 bug,不是应用代码 bug。jsdom / vitest 跑不起来 electron-builder 真实打包流程,测的只能是 yaml 字符串解析,等于在 assert 实现细节。真正的验证是**比较 source tree 和 release tree 的文件数**,这件事在 `release:cn` 之后用一行 PowerShell 跑:

```
cmd /c "dir /s /b release\win-unpacked\resources\apiyi-mcp\node_modules | find /v /c """""
# 期望 ≥ 4900
```

下次发版前如果想 paranoid,跑这条作 smoke test。

#### 用户可见行为

1. **从 v4.3.19 / v4.3.18 / v4.3.17 升级上来的老用户**:升到 v4.3.20 后,packaged installer 里 `resources\apiyi-mcp\node_modules\` 完整存在,Electron-as-Node 跑 `dist/index.js` 不再 `Cannot find module`,MCP 正常启动并返回工具
2. **全新装 v4.3.20 的用户**:同上,从未经历过 0 工具状态
3. **本地 dev workspace 用户**:本来就不走 packaged tree,行为完全不变
4. **`enabled: false` 默认行为不变**:用户填了 API key 才点开 toggle,符合"避免没 key 时刷错误循环"的设计

#### 影响范围

- 改的文件:`electron-builder.yml:47-86`(分两个 from 块)+ `package.json`(版本号)+ `docs/hot-update.md`(本段)
- 不动代码,不改 IPC,不改 seed 逻辑,不改 UI
- installer 体积从 45 MB(漏 node_modules 的坏版本)涨到 370 MB(完整版),后续可以考虑用 esbuild 把 apiyi-mcp 整个 bundle 成单 .js 来瘦身,但那是 v4.3.21+ 的事
### v4.3.23 (2026-06-05) — 根因修复:历史图片重开软件后消失(COS 上传在生产环境无凭据 → 存了会过期的模型直出 URL)

**根因(systematic-debugging)**

历史记录持久化在 `localStorage`,但存的是**模型直出 URL**而非永久 COS 链接 —— 因为生产环境根本传不上 COS:

1. 客户端直传 COS 需要 `cos-credentials.json`(主账号密钥),它只存在于开发机仓库根目录,**没有打进安装包**(也绝不能打:那是公开仓库的主密钥泄露)。
2. 于是绝大多数用户的 `credentials.ts` 兜底链拿不到任何密钥 → `uploadBufferToBucket` 失败 → 历史落库 `modelUrl`。
3. 模型直出 URL 有 TTL,过期后历史里的图就成了死链 → "重开软件图片消失"。
4. **导演模式更严重**:`saveToHistory` 直接落 `img.url`(模型 URL),从来没走过 COS,必过期。

**修复 —— 服务端 STS,客户端零密钥**

新增腾讯云 SCF 云函数(`serverless/sts-cos/`,Function URL 直连)用 `qcloud-cos-sts` 颁发**短时临时凭证**,作用域死锁在 `image-history/* 仅 PutObject`。主账号/子账号密钥只存在于云函数环境变量,**永不下发客户端**。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 STS 凭证提供器 | `src/main/services/tencent/stsCredentials.ts` | 从 SCF Function URL 拉临时凭证,内存缓存(提前 5min 刷新)、并发去重、10s 超时;可选 `COS_STS_APP_TOKEN` 网关 |
| image-history 上传改走 STS | `src/main/services/tencent/cosClient.ts` | 新增专用 COS 实例,SDK `getAuthorization` 回调每次取临时密钥(带 `SecurityToken`);其它桶(storyboardSplit/smartErase)仍用原永久凭证实例,互不影响 |
| 导演模式落库前先转存 COS | `src/renderer/src/react-app/hooks/useDirectorGeneration.ts` | `saveToHistory` 对每张图先 `uploadImageUrlToCos`(自限流 4 并发),成功用永久 URL、失败兜底模型 URL |

generate / batch 模式本就经 `enqueueUpload → uploadBufferToBucket`,随 STS 改造自动修复。

**验证(TDD)**

- 新增 `stsCredentials.test.ts`:缓存命中/到期刷新/并发去重/非 200 不缓存/缺凭证报错/APP_TOKEN 头 —— 6/6 通过。
- `cosClient.test.ts` 15/15 不变(mock COS 不触发 getAuthorization,断言照旧)。
- `useDirectorGeneration.nonblocking-history.test.tsx` 1/1 通过(浏览器无 bridge → 兜底模型 URL,仍非阻塞落库)。

行为:新生成的图(含导演模式)落库即**永久 COS 链接**,重开软件不再消失。已存的过期链接无法追回(URL 已死),但未来不再丢。

> 后续可硬化:给 Function URL 配 `APP_TOKEN`(服务端环境变量 + 客户端 `COS_STS_APP_TOKEN`)防止开放 URL 被滥用上传。

---

### v4.3.22 (2026-05-29) — 修复:关闭 Codex 聊天栏再打开,滚轮回到顶部(应停在离开位置)

**根因(systematic-debugging Phase 1.5 数据流)**

`AgentChatPanel` 在 `!isOpen` 时**提前 return**,只卸载内层聊天滚动 `<div ref={chatScrollRef}>`,但 `AgentChatPanel` 组件本身(及 `useChatScroll` 的所有 ref)**始终挂载**。`useChatScroll` 的 restore `useLayoutEffect` 依赖 `[containerRef, threadId]`:

- 关闭 → 聊天 div 卸载,`chatScrollRef.current = null`,但 `lastRestoredThreadIdRef` 仍 = 当前 threadId。
- 重开 → div 重新挂载(`chatScrollRef.current` = 新节点),但 deps 没变 → **restore effect 不重跑**;即便跑也被 `lastRestoredThreadIdRef === key` guard 挡住。于是新 div 停在默认 `scrollTop=0` = 顶部。

**修复**

| 改动 | 文件 | 说明 |
|------|------|------|
| hook 新增 `isOpen` 入参 | `src/renderer/src/features/agent-chat/useChatScroll.ts` | 容器(重)挂载的唯一信号——面板 open/close 时组件不卸载,只能靠 isOpen 感知 |
| 关闭时重置 restore guard | 同上 | `useLayoutEffect(() => { if (!isOpen) lastRestoredThreadIdRef.current = null }, [isOpen])`,让重开必重新恢复 |
| restore + auto-scroll effect deps 加 `isOpen` | 同上 | 重开时 restore 重跑(自由滚动→恢复离开位置;锁底→重新贴底跟随 AI) |
| 接线 | `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` | `useChatScroll({ ..., isOpen })` |

**验证(TDD,RED→GREEN)**

- 新增 `useChatScroll.reopen.test.tsx`:RED 时 reopen 后 `scrollTop=0`,修复后 **2/2 通过**(自由滚动恢复到 250 / 锁底线程重开贴底 1000)。
- `chatScroll.test.ts` 12/12 不变。
- `AgentChatPanel.bootstrap.test.tsx` 的 3 个失败为 main 既有的 jsdom `getComputedStyle` 环境问题(stash 掉本次改动后同样失败),非本次回归。

行为:关闭聊天栏再打开,**停在离开时的滚动位置**;发消息 / 锁底线程仍贴底跟随 AI 输出。

---

### v4.3.21 (2026-05-29) — 紧急修复:打包缺 sharp 原生二进制,装机启动即崩

> **严重级别:崩溃级 hotfix**。v4.3.20 安装到全新机器后,主进程启动立即弹
> `A JavaScript error occurred in the main process / Could not load the "sharp"
> module using the win32-x64 runtime`,应用无法打开。v4.3.21 仅修打包配置,无功能改动。

**根因(systematic-debugging 四阶段定位,@parcel/watcher v4.3.10→v4.3.11 同款翻版)**

- `src/main/file-explorer/mediaThumbIpc.ts` 在主进程**急切 `import sharp from 'sharp'`**(media:thumb IPC 热路径,由 PR #22 / `e8a6e1e` 引入)。
- sharp 运行时要 dlopen 平台二进制 `@img/sharp-win32-x64`(transitive optionalDependency,内含 `lib/sharp-win32-x64.node`,423KB)。
- **`sharp` 被放在 `devDependencies`**(历史上当 build-tool 用)。electron-builder 只打生产 `dependencies` 及其 optionalDependencies,**devDependencies 一律不打** → sharp 及其平台包 `@img/sharp-*` 从未进包。
- **且 sharp 不在 electron-vite 的 main `external` 列表里** → rolldown 把 sharp 的 JS **bundle 进 `dist/main/index.js`**;bundle 后的代码仍在运行时 `require('@img/sharp-win32-x64')` 去 dlopen `.node`,但该包没进包 → 报 `Could not load the "sharp" module`(报错来自 sharp 自己的 JS,正因它被 bundle 进了主入口,堆栈停在 `index.js:489`)。
- **为什么偏偏 v4.3.20 才暴露**:PR #22(sharp-in-main)在承载滚动条的 `main` 线上;线上 4.3.16–4.3.19 是另一条 apiyi-mcp 线,fork 在 PR #22 之前 → 主进程根本没有 sharp import → 不崩。v4.3.20 合并两线后,**第一次把 sharp-in-main 真正发布出去**,缺口随之暴露。
- **确凿证据**:解包 v4.3.20 的 `app.asar.unpacked/node_modules` 只有 `@electric-sql / @parcel / @prisma / jszip`,完全没有 sharp / @img。对照 `@parcel/watcher`(正常)→ 它是 `dependencies` + 在 main external 列表 + 有 asarUnpack 规则;sharp 四项里缺了前两项。

> **调试教训**:第一版修复只补了 `.npmrc` hoist + `asarUnpack`(symptom 层),重打后验证仍 MISSING —— 因为 `asarUnpack` 只能把**已被纳入打包**的文件从 asar 挪到 unpacked,不会把文件「拉进来」。回到 Phase 1 才发现 sharp 是 devDependency 且被 bundle,根因在更上游。

**修复(对齐 @parcel/watcher 的四件套,缺一不可)**

| 改动 | 文件 | 说明 |
|------|------|------|
| **sharp 从 devDependencies → dependencies** | `package.json` | electron-builder 才会把 sharp 及其 optionalDependencies `@img/sharp-*` 纳入生产依赖树 |
| **main external 加 `sharp` + `/^@img\/sharp-/`** | `electron.vite.config.ts` | 阻止 rolldown bundle sharp,改为运行时 `require()` 落到 node_modules,原生 `.node` 才能 dlopen |
| 强制 hoist sharp + 全平台 @img/sharp-* 到真实顶层 | `.npmrc` | `public-hoist-pattern[]=sharp` + `@img/sharp-*`,让 electron-builder 在顶层扫得到(否则只躺在 `.pnpm/`) |
| sharp + @img/sharp* 原生 `.node` 移出 asar | `electron-builder.yml` → `asarUnpack` | `**/node_modules/sharp/**` + `**/node_modules/@img/sharp*/**`,`.node` 只能从真实路径 dlopen,必须落在 `app.asar.unpacked` |

**验证**:重打 `build:win` 后确认 `app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node` 存在,且 `dist/main/index.js` 不再内联 sharp。

参考:`.npmrc` 与 `electron-builder.yml` 的同款 @parcel/watcher 注释(v4.3.11 教训)。

---

### v4.3.20 (2026-05-29) — Codex 聊天滚动状态机：发送锁底 + 跨进程持久化位置 + 常驻滑轮

> **版本说明**:线上 4.3.16–4.3.19 是一条独立的 apiyi-mcp 工作线(MCP 配置 enum 约束 / 优雅降级 / command=undefined 修复 / JSON 编辑器空白修复 / FastMCP 网关),曾与本地承载滚动条工作的 `main` 分叉。本次已把 `v4.3.19` 完整合并进 `main`(含全部 MCP 修复,见下方 4.3.16–4.3.19 条目),再叠加本次滚动条改动统一发布 **v4.3.20**,COS + GitHub 双源指向 4.3.20,**不回退任何 MCP 修复**。

本版本重做 Codex 聊天面板的滚动体验，根除"每次打开对话框停在顶部 / AI 输出时滑轮不跟随 / 关闭后位置丢失"三个体感痛点。摒弃上一轮(已回退的 PR #27)引入的 `react-virtuoso` + `overlayscrollbars-react` 重型依赖，改用**原生 DOM 滚动 + 纯函数状态机 + Zustand 持久化**的轻量方案。

**A. 滚动状态机三态语义(根因:原实现无"跟随意图"概念)**

**问题**: 旧版聊天区每次重渲染都不主动滚动 → 打开面板停在顶部;AI 流式输出时内容增长但滑轮不动 → 用户看不到最新进度;面板关闭再打开 / 切线程 / 重启 app 后位置全部归零。

**修复** (三文件拆分，纯逻辑与 DOM 交互解耦):

| 改动 | 文件 | 说明 |
|------|------|------|
| 纯函数状态机 + localStorage I/O | `src/renderer/src/features/agent-chat/chatScroll.ts`(新) | `distanceFromBottom`(带 clamp 防负值)/ `computeFollowBottom`(离底 ≤48px 判定锁底)/ `loadChatScrollByThread` / `persistChatScrollByThread`。`CHAT_SCROLL_UNLOCK_THRESHOLD_PX=48` 单一阈值常量。所有 localStorage 读写带 defensive try/catch + 畸形数据兜底。**12 个 RED-GREEN 单测**覆盖 clamp、阈值边界、持久化往返、解析容错 |
| React hook 接 DOM | `src/renderer/src/features/agent-chat/useChatScroll.ts`(新) | `useLayoutEffect` 做无闪烁位置恢复;新消息到达时若处于锁底态则自动滚到底;`useRef` 防"程序化滚动→onScroll→再写状态"反馈环;`onScroll` 回调按 48px 阈值翻转 follow 标志并持久化 |
| Store 状态 + 动作 + sendMessage 钩子 | `src/renderer/src/features/agent-chat/store.ts` | 新增 `chatScrollByThread` per-thread 状态、`setChatScroll` / `lockChatScrollToBottom` 动作。`sendMessage` 时(及 `threadId` 解析后)调 `lockChatScrollToBottom` —— **用户一发消息就强制锁底看回复尾巴** |
| 常驻滑轮 CSS | `src/renderer/src/styles/index.css` | `.chat-scroll` 用 `overflow-y-scroll`(常显而非 auto)+ `::-webkit-scrollbar` 细青色轨道(Webkit)+ Firefox `scrollbar-width/color` 双写。摒弃外部滚动条库 |
| 面板集成 | `src/renderer/src/features/agent-chat/AgentChatPanel.tsx` | `chatScrollRef` + `onScroll` 接到主滚动容器,接 `useChatScroll` hook |

**语义保证**: 发送消息 → 锁底跟随 AI 输出;用户手动上滑离底 >48px → 解锁自由浏览;滑回 48px 内 → 重新锁底;关面板 / 切线程 / 重启 app → 位置从 localStorage 恢复(`full_persist` 跨进程)。

#### 用户可见行为

1. **打开 Codex 对话框默认停在最新消息**(锁底),不再回到顶部从头翻
2. **AI 流式输出时滑轮自动跟随**到底部,实时看到生成进度
3. **手动上滑即解锁**,可自由向上向下浏览历史,滑回底部附近自动恢复跟随
4. **关闭面板 / 切换线程 / 重启 app 后回到上次离开的滚动位置**(localStorage 跨进程持久化)
5. **滑轮常驻可见**(细青色),不再 hover 才出现

#### 测试

- `pnpm vitest run agent-chat/__tests__/chatScroll.test.ts` → **12/12 全过**(distanceFromBottom clamp / computeFollowBottom 阈值 / localStorage 往返 + 容错)
- `AgentChatPanel.bootstrap.test.tsx` 0 regression(happy-dom 下补 stub mock 规避 getComputedStyle)

参考:
- PR #28:[per-thread scroll state machine](https://github.com/2799662352/ai-image-master/pull/28)
- 回退的重型方案:PR #27(react-virtuoso + overlayscrollbars,因 auto-follow / 滑轮可见性 / 默认位置回归被关闭)
---

### v4.3.19 (2026-05-23) — Hotfix: MCP JSON 编辑器 modal 内容区 0px 高度(点编辑/新增看上去空白)

**用户报告**:v4.3.18 顶部红 banner 消失了(boot 自愈 + banner 去重生效),但点击 ✏️「编辑」或 +「新增」按钮,modal 弹出后**中间 Monaco 编辑区是完全空白的**,只看到顶部 header(标题/保存/取消)和底部 hint(`格式: { ... } 按 Esc 关闭`)挤在一起,modal 总高度只占视口 ~30%。

**Phase 1 / 根因调查**

DOM 结构是这样的:

```tsx
<div className="flex max-h-[85vh] w-full max-w-4xl flex-col gap-3 ...">  // ← 容器
  {/* Header */}              // 自然高度 ~40px
  {/* Error (可选) */}        // 不存在
  <div className="min-h-0 flex-1 ...">
    <Editor height="100%" />  // ← Monaco
  </div>
  {/* Hint */}                // 自然高度 ~20px
</div>
```

Flex 列方向容器只设 `max-h-[85vh]`(上限)而没有 `h-...`(显式高度)。`max-h` 只规定**最大值**,实际高度由 content 决定 —— content 总和约 ~60px,**容器实际高度 ~60px**。这种"content-driven height"的 flex container 里,`flex-1` 没有任何可扩展的空间(剩余空间为 0),所以 `flex-1` 子 div 实际高度 = 0px。Monaco 拿到 `height="100%"` 计算出 0px,渲染为不可见。

回头看 git history:**这是 `61d679a` 把 inline 编辑器重构成 modal 那次就埋的雷**(v4.3.17/v4.3.18 都没动这块,所以一脉相承)。当时没暴露是因为 modal 内承载的内容多到顶到 `max-h-[85vh]`,从而 flex-1 自然撑开;现在用户配置只剩一个 apiyi,JSON 短,modal 缩到 content-driven,Editor 就被压成 0。

**Phase 2 / 修复**

`src/renderer/src/features/agent-workspace/McpJsonEditor.tsx` 两处改动:

1. 容器从 `max-h-[85vh]` 改成 `h-[85vh]` —— modal 总是占视口 85vh 的固定高度,header/hint 吃自然高度,剩余空间归 `flex-1` 子节点,Editor `height="100%"` 拿到真实像素值
2. Editor 容器额外加 `style={{ minHeight: 300 }}` 兜底 —— 这是 defense-in-depth,即使将来又有人把父级改回 content-driven,Editor 至少有 300px 可见区,不会再出现"完全空白"的故障模式

**为什么不加单元测试**:这是纯 CSS layout 问题。jsdom 没有真实 layout 引擎,`getComputedStyle().height` 拿不到 px 值,只能拿到 inline style 字符串。给 layout bug 写 unit test 测的是 className 字符串,本质上是在 assert 实现细节而不是行为 —— 收益低于成本。已存在的 43 个 renderer 测试照常 pass。

#### 用户可见行为

1. **点 ✏️ 编辑某 server**:modal 占视口 85vh,Monaco 编辑器显示该 server 的 `{ "apiyi": {...} }` 完整内容
2. **点 + 新增**:modal 占视口 85vh,Monaco 编辑器显示当前所有 servers(用户可在里面追加新条目)
3. **任何状态下,小视口/大视口**:Editor 至少 300px 可见,modal 上限 85vh
4. **保存/取消/Esc/click-outside**:行为不变(v4.3.18 已修)

---

### v4.3.18 (2026-05-23) — 根因修复: v4.3.16 引入的 `command=undefined` 回归(全新装机的 apiyi 永远 broken) + 编辑器先验校验 + banner 去重

**用户报告**:v4.3.17 给了「修复 apiyi」按钮但是问题反复出现 —— 重新装/重新启动后,顶部仍然冒出**两条重复 banner**:`Codex 拒绝加载当前 MCP 配置: invalid transport in 'mcp_servers.apiyi'` 和 `工具列表同步失败: failed to reload config: ... invalid transport(状态点不受影响,可点「刷新」重试)`。

**Phase 1 / 根因调查**

按 systematic-debugging 三层取证,顺着调用栈反推:

- **Layer 1(产物)**:`~/.codex/config.toml` 里 `[mcp_servers.apiyi]` 块**没有 `command` 字段也没有 `url` 字段**(只有 `args` / `env` / `enabled` / `tool_timeout_sec`)
- **Layer 2(校验)**:codex 0.132.0 的 `McpServerConfig` 是 `serde(untagged)` 枚举(`McpServerTransportConfig::{Stdio{command,args,env}, StreamableHttp{url,bearer_token_env_var}}`)。一旦 entry 同时缺 `command` 和 `url`,两个 variant 都匹配不上,deserializer 直接吐 `invalid transport` —— **这一层我们改不了**(上游 Rust binary)
- **Layer 3(写入)**:谁把 `command` 字段写丢的?往回追到 v4.3.16 提交 `8fb60d2`:`src/main/index.ts:809` 把旧的 `nodeBin: process.execPath` 直接换成新签名 `seedApiyiMcpEntry({ command: ..., extraEnv: ... })` 时,**漏改了 call site**,变成 `seedApiyiMcpEntry({ ...other, nodeBin: process.execPath })` —— `nodeBin` 不是 `SeedApiyiMcpInput` 的合法字段,TypeScript 没拦下来是因为 `input.command` 类型是 `string | undefined` 在写入路径上没被 narrow

- **Layer 4(放大器)**:`apiyiMcpSeed.ts` 拿到 `input.command === undefined` 后,写出的 entry 是 `{ command: undefined, args: [...], env: {...} }`。`@iarna/toml.stringify` 看到 `undefined` 字段**静默丢弃**(它不能在 TOML 里编码 `undefined`),最终落盘的就是缺 `command` 的非法 transport entry。所有 v4.3.16+ **全新装机**或**首次 seed 的用户**,机器上都生成了这条 broken entry → 进 codex → 整页报错

**为什么 v4.3.17 没修到根**:v4.3.17 的精力全花在"让 UI 别死锁 + 提供编辑入口"上(读 raw TOML、graceful degradation、修复按钮),**完全没动 seed 写入路径**。所以每次启动 boot convergence 还是写出同样的 broken entry,用户每打开一次页面就再被刷一次。

**Phase 2 / 修复(三件并行,B 是根因)**

| 代号 | 改动 | 文件 | 说明 |
|------|------|------|------|
| **B0** | 修 v4.3.16 call site 回归 | `src/main/index.ts` | 改成先 `resolveApiyiCommand(process.execPath)` 拿到 `{ command, extraEnv }`,再传给 `seedApiyiMcpEntry({ command: apiyiCmd.command, extraEnv: apiyiCmd.extraEnv, ... })`。**全新装机现在永远写出带 `command` 字段的合法 entry** |
| **B1** | seed 自愈 broken entry | `src/main/agent/apiyiMcpSeed.ts` | 加 `isBrokenApiyiEntryMissingTransport()` 检测器 + `'repaired'` 新 SeedAction。boot convergence 时如果发现现存 `apiyi` entry **同时缺 `command` 和 `url`**,**就地补回 `command`/`args`,保留 `env`/`enabled`/`tool_timeout_sec` 等用户字段**;`extraEnv` 走 mergeEnvWithScaffold(永不覆盖用户已设的值)。**老用户从 v4.3.16/v4.3.17 升上来,首次启动就被自动修好,不用点任何按钮** |
| **A** | banner 去重 | `src/renderer/src/features/agent-workspace/useMcpStore.ts` | `syncTools` 失败时,如果 `codexConfigError` 已经在显示同根因错误(`/invalid transport/i` 或 `/reload config/i`),**直接吞掉 `syncError`**,只留一条 banner。RPC 调用本身不变 —— 仍然会调,只是不再渲染重复消息 |
| **C** | JSON 编辑器先验校验 | `src/renderer/src/features/agent-workspace/mcpEntryValidator.ts`(新) + `McpJsonEditor.tsx` | 抽出 `validateMcpServerEntry()` —— 在前端**复刻** codex 的 `McpServerTransportConfig::{Stdio, StreamableHttp}` 判定逻辑(`command` 必须是非空 string,或 `url` 必须是非空 string,且两者类型正确)。保存按钮调 `batchWriteConfig` 之前,对每条 entry 跑一遍,任何一条不合法直接 `throw new Error('mcp_servers.xxx: ...')` 阻断写入,在 modal 顶部红条提示 —— **用户在编辑器里手编出一份缺 `command` 的配置,在写盘之前就被拦下,不会重蹈 v4.3.16 覆辙** |

**Phase 3 / 测试覆盖**

- `apiyiMcpSeed.test.ts`:加 3 个新 case,17/17 全过
  - `'returns repaired when existing apiyi entry is missing both command and url'`:从 broken entry 自愈到合法 stdio,验证 `env` / `enabled` 等用户字段被保留
  - `'returns repaired with extraEnv merged additively, never overwriting existing env values'`:验证 `extraEnv` 仅补缺,从不覆盖已存在的 key
  - `'does NOT touch entries that have an explicit url'`(防回归):URL 型 entry 不应被识别成 broken
- `useMcpStore.test.ts`:加 3 个新 case
  - `'syncTools suppresses syncError when codexConfigError already covers the same invalid-transport root cause'`
  - `'syncTools still reports unrelated sync errors even when codexConfigError is set'`(防过度抑制)
  - `'syncTools reports ok=false errors normally when codexConfigError is NOT set'`(健康路径)
- `mcpEntryValidator.test.ts`(新):覆盖 valid stdio / valid http / missing-transport / empty command / wrong-typed command / null entry / array entry / `formatValidationError` 输出文案

**总计**:6 个测试文件 / 94 个测试全过。

#### 用户可见行为

1. **从 v4.3.16/v4.3.17 升级到 v4.3.18,机器上有 broken apiyi 块的用户**:启动那一刻 `seedApiyiMcpEntry` 直接 `'repaired'`,console 日志 `[apiyi-mcp] boot convergence: repaired (command=...)`,**用户进 MCP 页面看到的就是已经修好的状态**,没有 banner,无需点任何按钮
2. **全新装 v4.3.18 的用户**:`'created'` 路径写出的 entry **第一次就带 `command` 字段**,永远不会触发 `invalid transport`
3. **JSON 编辑器手编场景**:用户在 modal 里把 `command` 删掉或写成空串 → 点保存 → 红条提示 `mcp_servers.xxx: missing transport: either 'command' (stdio) or 'url' (streamable-http) is required`,写盘动作被阻断
4. **同根因 + 不同根因的 banner 区分**:同根因(invalid transport)只留 `codexConfigError` 一条;不同根因(比如 RPC 网络挂了 / 工具列表里某个 server 启不来)`syncError` 该报还报,不会被过度吞

#### 不修的部分(deliberately scoped out)

- **codex 0.132.0 自己的 `McpServerConfig` 校验逻辑**:不动,这条线我们尊重上游
- **autoFixApiyiBroken 一键修复按钮的独立 IPC**:v4.3.17 那个「修复 apiyi」按钮目前是直接打开 JSON 编辑器,工作良好;v4.3.18 已经把根因从 boot path 治了,**绝大多数用户根本走不到那个按钮**,所以暂不加独立 RPC

---

### v4.3.17 (2026-05-23) — Hotfix: codex 拒绝 MCP 配置时整页死锁(用户无路径修复)

**用户报告**:升级到 v4.3.16 后打开 Agent Workspace → MCP Servers,整页变成一条红色错误:

```
invalid configuration: invalid transport in `mcp_servers.apiyi`
```

下方只有一个「重试」按钮 —— 点击仍然挂同样的错。**用户无路径打开 JSON 编辑器修复出错的那一段**,MCP 页面被完全屏蔽。

**根因(`/systematic-debugging` Phase 1)**:错误字符串不在我们仓库任何位置,grep 全 0 命中 → 由 codex Rust 二进制(`codex-rs`)在响应 `config/read` RPC 时抛出。完整链路:

```
useMcpStore.fetchServers
  → electronAPI.agent.readConfig
  → AgentManager.readConfigRpc
  → CodexLocalBackend.readConfig
  → CodexProtocolClient.rpc('config/read')
  → codex.exe ← parse ~/.codex/config.toml
                ← schema 校验拒绝 [mcp_servers.apiyi] 块(可能 transport 字段值不在白名单 / 旧版本残留 / 用户曾在 JSON 编辑器手编错)
```

我们 seed/backfill 的代码路径**从不写 `transport` 字段**(stdio 是默认),所以最可能的成因是用户 config.toml 在某条历史路径上被写入了非法 transport,codex 后续版本收紧了校验,把整个 `config/read` 调用一并拒绝。

**真问题(架构层)**:`McpServerList` 拿到 `error` 时把整页换成红色错误屏蔽,**编辑器入口被该屏蔽 div 覆盖**,而编辑器本身又走同一个 `readConfig`,即使能进去也会触发同样错误 → 一旦 codex 挑剔,整个 MCP 页就废了。这是比"用户配置错了"更严重的设计漏洞。

#### 修复:三层加固

**A. 主进程:新增 codex-bypass 的 raw TOML 读取路径**

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 `readRawCodexConfig(configPath)` | `src/main/agent/codexConfigDiscovery.ts` (+62) | `fs.readFile` + `toml.parse`,**完全不经过 codex 二进制**。返回 `{ config, raw, parseError }`:ENOENT → `{ config: {}, raw: null }`(空配置);TOML 损坏 → `{ config: null, raw, parseError }`(保留 raw 字节供 UI 显示);成功 → 完整 parsed config,包括 codex 会拒绝的 `transport: "bogus"` 这类字段(**这正是要的:让用户看到 / 编辑出错的那一段**) |
| 新增 `AgentManager.readRawConfigRpc()` | `src/main/agent/AgentManager.ts` (+27) | 暴露上面的函数为 RPC;走的是 `path.join(os.homedir(), '.codex', 'config.toml')` 这个 codex 同款路径 |
| 注册新 IPC channel `agent:mcp-read-raw-config` | `src/main/agent/ipc.ts` (+2) | 加入 `AGENT_HANDLE_CHANNELS` 数组,跟现有 channels 一样在 dev-reload 时被 `removeHandler` 清理 |
| preload 暴露 `readRawConfig` | `src/preload/index.ts` (+15) | API 形如 `electronAPI.agent.readRawConfig() → Promise<{ ok, config?, raw?, parseError? }>` |

**B. 渲染层:graceful degrade — codex schema 拒绝从 fatal 降级为 banner**

| 改动 | 文件 | 说明 |
|------|------|------|
| `McpStore` 加 `codexConfigError: string \| null` | `src/renderer/src/features/agent-workspace/useMcpStore.ts` (+40 -8) | 跟 fatal `error` 严格区分:**`error` 只有"任何形式的 config 都读不到"才设**(codex RPC 失败 AND raw 读也失败,或 MCP API 整个不可用);**`codexConfigError` 才是 codex 拒绝 schema 这种"配置坏但文件能读到"** |
| `fetchServers` fallback 逻辑 | 同文件 | codex `readConfig` 失败 → 自动调 `readRawConfig` 回退;成功就用 raw 的 `mcp_servers` map 喂给 `buildServersFromConfig`,卡片照常渲染 |
| `McpServerList` 删整页屏蔽,改顶部 banner | `src/renderer/src/features/agent-workspace/McpServerList.tsx` (+45 -3) | `error` 分支保留(真 fatal 才落到这里);新增 `codexConfigError` banner:红色横条 + 错误原文(`whitespace-pre-wrap`,不裁断)+ 正则提取出错的 `mcp_servers.X` 名字 + **「修复 X」按钮 deep-link 到 JSON 编辑器**。卡片继续在下方正常显示(数据从 raw TOML 来) |
| `McpJsonEditor` **优先** `readRawConfig` | `src/renderer/src/features/agent-workspace/McpJsonEditor.tsx` (+25 -7) | 编辑器存在的全部意义就是修复 codex parse 失败的配置 —— 如果它也走 `readConfig` 会触发同样错误把自己锁出来。**改为先尝试 `readRawConfig`,仅当 raw 也失败才退回 `readConfig`**。保存路径走 `batchWriteConfig` 不变(写入照常,codex 看到合法 TOML 就能重新加载) |

**C. 测试覆盖(+159 lines)**

| 测试文件 | 新增 case | 验证 |
|---------|----------|------|
| `codexConfigDiscovery.test.ts` | +3 case 在新 `describe('readRawCodexConfig')` 块下 | (1) 接受 codex 会拒绝的 `transport = "bogus-transport-value"` 块,完整 surface 给 caller;(2) 文件缺失 → `{ config: {}, raw: null }`;(3) TOML 损坏 → 保留 raw 字节 + parseError |
| `useMcpStore.test.ts` | +3 case + 1 老 case 改写 | (1) codex readConfig 失败 + readRawConfig 成功 → `codexConfigError` 设置 / `error` 为 null / 卡片正常渲染;(2) 两条路径都死 → 升级为 fatal `error`;(3) happy path 不调 `readRawConfig`(避免多余 IO);(4) 原"readConfig 失败 → fatal" case 改写成"`readRawConfig` 不可用时才 fatal" |

#### 用户可见行为

1. **从 v4.3.16(或更早)升级到 v4.3.17 后,config.toml 已经被 codex 拒绝的用户**:打开 MCP 页面**看到卡片正常列出**(包括出错的 apiyi),顶部红色 banner 提示"Codex 拒绝加载当前 MCP 配置:<原错误信息>";banner 右侧有「修复 apiyi」按钮 → 点击直接打开 JSON 编辑器加载 apiyi 那一段,用户改完保存 → 点「刷新」让 codex 重新加载 → banner 消失,绿/灰状态点回归
2. **config.toml 全新 / 健康的用户**:零差异,`readRawConfig` 在 happy path 上根本不会被调到
3. **TOML 文件本身损坏到无法 parse**(极端情况,比如手编时把括号写漏):banner 显示 codex 原错误 + 提示"(原始 TOML 也解析失败:...)",JSON 编辑器会渲染空对象;用户至少不会被锁死,可以从 `{}` 起步重写一个合法块

#### 验证

- `codexConfigDiscovery.test.ts`:8/8 通过(原 5 + 新增 3)
- `useMcpStore.test.ts`:21/21 通过
- `ipc.test.ts` + `ipc.workspace.test.ts`:dev-reload 清理列表已包含新 channel,两条 reload 路径测试通过
- 我所有触碰的测试文件:**48/48 全过**
- `AgentManager.sessionConfig.test.ts`(4 个 approvalPolicy 失败)和 `preload/index.ts:995 uploadImageFromUrl` lint error 已用 `git stash` 隔离验证为 **baseline 失败**,与本次修复无关

#### 不修的部分(deliberately scoped out)

- **为什么用户的 config.toml 当初被写入了非法 transport**:成因可能是 v4.3.15 之前的 seed 路径、用户手编、或 codex 版本升级收紧校验 —— 三条都查不到当前用户机器上的真实 history。修这条的成本远高于直接打开"用户能自己改"的路径
- **codex 校验本身**:不在我们控制范围,不动

参考:
- 调试方法论:`superpowers:systematic-debugging` skill(Phase 1-4 完整走完,Phase 1 grep 定位错误来源 → Phase 2 找到 UX 死锁的真问题 → Phase 3-4 codex-bypass 路径方案 + 验证)

---

### v4.3.16 (2026-05-23) — 内嵌 apiyi-mcp 模型选择硬约束 + 老用户 env 配置自动 backfill

本版本针对 v4.3.15 已嵌入的 apiyi-mcp(用 Gemini 多模态分析图像/视频/PDF)做两件事:**让 LLM 客户端不再"自作主张"地往工具调用里塞 `gemini-2.5-pro` 这个过气模型**,以及**让老用户升级时自动补齐缺失的 env scaffold 字段(但永不动用户已设的值)**。

**问题背景**:v4.3.15 把 apiyi-mcp 默认模型设成了 `gemini-3.1-pro-preview-thinking`,但有用户反馈:打开 Codex/Claude agent 让它"分析这个视频",日志里看到工具调用参数仍然是 `{"model":"gemini-2.5-pro", ...}` —— **客户端 LLM 把 default 配置覆盖掉了**。原因是 apiyi-mcp 的 tool inputSchema 里 `model` 字段 description 只有空泛一句 `'Gemini model to use'`,没有任何枚举或推荐,LLM(尤其是 OpenAI o-series)就凭训练数据偏好填 `gemini-2.5-pro` —— 那是他们见得最多的"视频理解能用的模型"。

**A. tool inputSchema 加 enum + 强 description(`apiyi-mcp-server` 上游 + vendored dist)**

| 改动 | 文件 | 说明 |
|------|------|------|
| `generate_content.inputSchema.model` 加 enum | `apiyi-mcp-server@c0856f4 src/index.ts` + vendored `resources/apiyi-mcp/dist/index.js` | 三档枚举:`gemini-3.5-flash`(默认,综合性价比最高,适合 99% 任务)/`gemini-3.1-pro-preview-thinking`(深度推理 / `thinking_budget`,贵且慢)/`gemini-3-flash-preview`(最便宜,适合大批量简单任务)。`description` 改写成多行表格式说明,显式标注"NEVER pass legacy 2.x ids (gemini-2.5-pro, gemini-2.5-flash, ...) — they are DEPRECATED" |
| `generate_content_batch` 同步 | 同上 | 批量工具的 per-request `model` override 走同款 enum + description |
| `DEFAULT_CONFIG.MODEL` 切换 | `apiyi-mcp-server src/constants.ts` | `gemini-3.1-pro-preview-thinking` → `gemini-3.5-flash`;LLM 不显式传 model 时直接走 3.5-flash |
| Docker 镜像同步 | `Dockerfile` + `Dockerfile.sse` + `docker-compose.yml` | `ENV GEMINI_MODEL=gemini-3.5-flash`,注释列出三档推荐模型 |
| 上游文档 | `apiyi-mcp-server CLAUDE.md` | 加"推荐模型"表 + 2.x 弃用说明 |
| Vendor lock 更新 | `scripts/vendor-apiyi-mcp.lock.json` `a7062b2` → `c0856f4` | 通过 `npm run vendor:apiyi-mcp:update` 重建 `resources/apiyi-mcp/`,确保 fresh clone / CI build 拿到带 enum 的 dist |

**为什么 enum + description 比"加 default + 文档说明"更硬**:JSON Schema enum 是 LLM 工具调用层的 hard constraint,大多数客户端(Cursor、Codex、Claude.app)在生成 args 时会严格遵循。即使 LLM 想填 `gemini-2.5-pro`,schema 校验会拒绝;**fallback 是落到服务端 default = gemini-3.5-flash**,双重保险。

**B. apiyi-mcp env scaffold backfill(`src/main/agent/apiyiMcpSeed.ts`)**

老用户的 `~/.codex/config.toml` 里 `[mcp_servers.apiyi]` 块如果已经存在(v4.3.15 装过),原来的 seed 逻辑是 **'skipped'**(只要存在就完全不动),导致他们的 env 块永远停留在老 scaffold —— **新的默认 `GEMINI_MODEL=gemini-3.5-flash` 永远到不了他们机器**。

| 改动 | 文件 | 说明 |
|------|------|------|
| `SeedAction` 加 `'backfilled'` 第三状态 | `src/main/agent/apiyiMcpSeed.ts` (+90 -21) | 三种结果:`seeded`(新写)/`backfilled`(已有但缺 scaffold key → 补)/`skipped`(已有且完整 → 不动) |
| `mergeEnvWithScaffold(existingEnv)` 纯函数 | 同文件 | 遍历 `APIYI_MCP_ENV_SCAFFOLD`,**只补 missing key**;用户已设的值原样保留 —— 包括 `GEMINI_MODEL=gemini-2.5-pro` 这种"看起来不对"的值,**用户拥有 source of truth**。enum 约束在 LLM 调用层兜底就够了 |
| 测试 +12 个 case | `src/main/agent/__tests__/apiyiMcpSeed.test.ts` (+128 -12) | 覆盖 backfill 添加缺失 key / 保留 user 值 / 三状态分支 / 幂等(连跑两次第二次必 'skipped') |
| `SeedApiyiMcpInput` 改 `nodeBin` → `command` + `extraEnv` | 同文件 | 解耦"用哪个 binary 启动 apiyi-mcp"和 seed 自身的纯函数语义。caller(`resolveApiyiCommand` in `apiyiMcpLauncher.ts`)决定走 system node 还是 Electron-as-node(打包 app 内置 Electron 兼作 node runtime) |

**C. apiyi-mcp launcher 扩展(`src/main/agent/apiyiMcpLauncher.ts` +142 -36)**

| 改动 | 说明 |
|------|------|
| `APIYI_MCP_ENV_SCAFFOLD` 默认 `GEMINI_MODEL` | 改成 `gemini-3.5-flash`;`GEMINI_MAX_OUTPUT_TOKENS` `8192` → `65536`,`GEMINI_TIMEOUT` 加 `1800000`(30min)默认值 |
| 新增 `resolveApiyiCommand()` 导出 | `src/main/index.ts` import 改成 `import { getApiyiMcpEntryPath, resolveApiyiCommand } from './agent/apiyiMcpLauncher'`。统一 dev/prod 启动路径:dev 走 system `node`,packaged 走 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` |
| `buildApiyiMcpConfigEntry` 签名重构 | 接受 `command` + `extraEnv` 而非 `nodeBin`,跟 seed 保持一致 |
| JSDoc 详尽化 | 加表格式三档模型推荐;明确"白名单仅 LLM 调用层,env JSON 用户可填任意值";测试同步 (`+4 -4` line 期望更新) |

**D. 远端 FastMCP BYOK 网关同步(`deploy/apiyi-fastmcp/`)**

| 改动 | 文件 | 说明 |
|------|------|------|
| Python 默认模型 | `deploy/apiyi-fastmcp/server.py` | `DEFAULT_MODEL = 'gemini-3.5-flash'` |
| Docker 配置同步 | `deploy/apiyi-fastmcp/Dockerfile` + `deploy/docker-compose.yml` | `ENV GEMINI_MODEL=gemini-3.5-flash` |
| 部署文档 | `deploy/README.md` + `deploy/apiyi-fastmcp/.dockerignore` + `pyproject.toml` | 同步;EdgeOne 长请求 + 大文件场景的反代配置说明 |

#### 用户可见行为

1. **Codex / Claude / Cursor agent 用 apiyi-mcp 跑视频/图像/PDF 分析**:工具调用参数里 `model` 字段被 enum 约束在三档 3.x 模型,不再蹦 `gemini-2.5-pro`(LLM 看到 schema 会自己选 `gemini-3.5-flash` 默认档)
2. **v4.3.15 老用户升级到 v4.3.16**:启动时 `~/.codex/config.toml` 的 `[mcp_servers.apiyi]` env 块自动补齐新的 scaffold key(`GEMINI_MAX_OUTPUT_TOKENS=65536` 等),**已设的 `APIYI_API_KEY` / `GEMINI_MODEL` 等值原封不动**;首次启动会在 console 看到 `seedApiyiMcpEntry → backfilled` 日志,后续启动全部 `skipped`
3. **MCP JSON 编辑器**(Agent Workspace → MCP Servers → apiyi → 配置)**不强制白名单**:用户在 env 块里填 `GEMINI_MODEL=gemini-2.5-pro`(不推荐但兼容)或任何其它 apiyi 支持的模型 id 都生效。约束只在 LLM 自动选择层,不在 env 配置层
4. **fresh clone / CI build**:`npm run vendor:apiyi-mcp` 拉到 upstream `c0856f4` 的带 enum 版本,产出的 installer 内置正确的 schema

#### 验证

- 上游 `apiyi-mcp-server@c0856f4` 已 push 到 `https://github.com/2799662352/apiyi-mcp-server/commit/c0856f4`
- 主项目 `npm run vendor:apiyi-mcp:update` → lock 更新到 `c0856f4126501615a067f9d8b0e7758d0d2d74c0`,`resources/apiyi-mcp/dist/index.js` 重新 build 包含 enum
- `node --check resources/apiyi-mcp/dist/index.js` → 语法合法
- `apiyiMcpSeed.test.ts` 全部 backfill / 保留 / 幂等 case 通过

参考:
- 上游 commit: <https://github.com/2799662352/apiyi-mcp-server/commit/c0856f4>
- 远端 BYOK 网关部署: `deploy/apiyi-fastmcp/README.md`

---

### v4.3.15 (2026-05-22) — 三件套：图片解码卡顿根除 + 批量闭包覆盖 bug + gpt-image-2-vip 分辨率对齐

本版本解决三个独立的图像生成痛点：(A) `<img src="data:image/...">` 同步解码阻塞主线程导致的"生成完那一下卡顿"，(B) 批量页运行中追加新 item 时参数被首次快照覆盖的 bug，(C) gpt-image-2-vip `resolutionMap` 像素值与 apiyi.com 文档不一致。

**A. 客户端 base64 → blob: URL 解码优化(根因:同步 base64 解码)**

**问题**: 单张生成完成那一瞬间 UI 仍有可感卡顿;批量页 5 张同时完成时整面网格抖动。API 返回的是 `b64_json`(数 MB base64 字符串),`<img src="data:image/png;base64,...">` 触发浏览器**同步**解码 PNG/WebP → GPU texture,这步堵在主线程上,N 张同时切 src 就是 N 倍卡顿。

**为什么不直接让 API 返回 url**: 评估过 `response_format: "url"`(走 CDN 链接),但国内用户访问 apiyi 的 CDN 不稳定,丢弃此路径,转向客户端优化。

**修复** (`src/renderer/src/hooks/useDisplaySrc.ts` 新增 + 11 处集成):

| 改动 | 说明 |
|------|------|
| 新增 `useDisplaySrc(src)` hook | 检测 `data:` 前缀 → `fetch(dataUrl).blob() → URL.createObjectURL(blob)` → `<img src={blob:...}>`。浏览器对 blob: URL 走**异步**解码 worker,主线程不卡。http/blob/undefined 透传零开销。StrictMode 安全(局部闭包持有 `createdBlobUrl` + `cancelled` flag,卸载时单独 revoke,无泄漏)。9 条单测覆盖 dataURL 转换、HTTP 透传、卸载 revoke、src 切换、并发竞态。 |
| 11 处渲染入口接入 | `pages-react/batch/{BatchItemRow,BatchResultGrid}.tsx`、`pages-react/batch-punk/PunkResultGrid.tsx`、`pages-react/generate/ResultGrid.tsx`、`pages-react/storyboard-split/SplitPreview.tsx`、`pages-react/smart-erase/EraseResultCard.tsx`、`components/donor/{DonorCard,DonorPreview}.tsx`、`components/shared/image-editors/ImageEditorModal.tsx`、`react-app/components/ResultsGallery.tsx`、`react-app/shared/RawDataModal.tsx`。`.map()` 里的 `<img>` 抽 cell 子组件(`GalleryImage` / `PreviewImage` / `SplitImage` / `ChoiceThumb`)让钩子能在循环里安全使用,每张 cell 独立持有 blob URL 生命周期。 |
| **只换 `<img src>`,保留原始 url 给其它消费者** | `downloadImage(url, ...)`、`fetch(url).blob()` (DonorPreview handleSave)、`openImageViewer(allUrls, idx)`、WebGL editor `imageUrl={currentUrl}`、`setCurrentUrl(ch.url)` 全部**继续用原 url**。理由:blob: URL 跨进程/canvas/`a.href` fallback 不一定可读,原 url 是兜底真理。`item.cosUrl` / `item.resultUrl` 在 store 中完全不变,COS 上传 / 历史持久化 / 重新编辑 三条路径零影响。 |
| 已走 blob URL 的入口跳过 | `agent-chat/Lightbox.tsx`、`file-explorer/ImageViewer.tsx` 早已用 `useResolvedMediaSrc` / `useFileUrl` 产 blob:,不重复叠加。冷路径(UnderstandPage 单图预览、参考图 thumb、MentionChips)不做改动避免范围爆炸。 |

**B. 批量页运行中追加 item 被首次快照覆盖 bug(根因:`runBatch` 闭包捕获)**

**问题**: 用户在批量任务跑到一半时,改 prompt / 换参考图 / 切比例 → 点"加入队列" → 新 item 拿到的仍是**首次启动批次时的旧参考图和比例**,用户的中途修改被覆盖。

**根因**: `runBatch` 入口处一次性闭包捕获 `ratio` / `referenceImages`,整个 batch 生命周期内所有 worker 共享这份快照。用户运行中追加的 item,worker claim 时调 `api.generateImage(...)` 传的仍是这份首次快照。

**修复** (`src/renderer/src/stores/useBatchStore.ts` + `src/renderer/src/pages-react/BatchPage.tsx`):

| 改动 | 说明 |
|------|------|
| `BatchItem` 扩展可选字段 | 新增 `referenceImages?: string[]` + `ratio?` 两个 item-level 字段,允许每个 item 自带参数 |
| `addItem` 签名扩展 | `addItem(prompt, opts?: { referenceImages?, ratio? })`,入队时把 opts 锁定到 item 上 |
| `claimNextPending` / `runOne` 优先级 | `itemRatio = next.ratio ?? runSnapshotBase.ratio`、`itemRefs = next.referenceImages ?? runSnapshotBase.referenceImages` —— item 自带值优先,无则 fallback 到首次快照(保持向后兼容) |
| `pendingBatchHistoryContext` 同步 | history 持久化也用 item-level 值,确保历史记录与实际生成参数一致 |
| `BatchPage.handleGenerate` 显式传参 | `addItem(p, { referenceImages: currentRefs, ratio })`,把当前表单状态锁进 item |

**语义保证**: 首次启动 batch 的 items 没自带 opts(因为老调用点不传)→ fallback 到 `runSnapshotBase` → 行为不变。运行中追加的新 items 入队时锁定当前表单值 → worker 用 item 自身值 → **修改生效**。

**C. gpt-image-2-vip 分辨率对齐 apiyi.com 文档(根因:`resolutionMap` 像素值脱节)**

**问题**: gpt-image-2-vip 模型的 `resolutionMap`(在 `ApiService.ts` 内)定义的像素维度与 apiyi.com 官方文档 30 档常见尺寸表不一致,导致 `size` 参数被 API 拒绝或返回非预期比例的图片。

**修复** (`src/renderer/src/services/api/ApiService.ts` + `__tests__/ApiService.gptImage2Vip.test.ts`):

| 改动 | 说明 |
|------|------|
| `resolutionMap` 重写 | 严格按 apiyi.com [text-to-image](https://docs.apiyi.com/api-capabilities/gpt-image-2-vip/text-to-image) / [image-edit](https://docs.apiyi.com/api-capabilities/gpt-image-2-vip/image-edit) 文档 30 档尺寸表逐档对齐,`宽x高` 半角小写 x 写法 |
| 测试覆盖 | `ApiService.gptImage2Vip.test.ts` 新增 177 行 case 覆盖文生图 JSON 路径、图编辑 FormData 路径、各 ratio 档 size 输出。jsdom 环境下 patch `convertToBlob` 让 FormData 能 append mock Blob,绕过 `fetch(dataURL)` 被全局 fetchMock 拦截后 `Response.blob()` 在 jsdom 里不是 native Blob 的问题 |

#### 用户可见行为

1. **生图完成那一瞬间 UI 不再卡顿**,无论是单张 generate 还是批量 5+ 张同时完成,主线程保持响应,"开始生成"按钮立即可点
2. **历史记录页(HistoryPage)滚动顺滑**,几十甚至上百张老 dataURL 历史卡片不再让滚动条卡顿;点开 lightbox 主图秒出
3. **批量页运行中改 prompt / 改参考图 / 改比例后追加的新 item 真正生效**,不再被首次启动时的快照覆盖
4. **gpt-image-2-vip 模型生图比例准确**,按 apiyi.com 30 档尺寸表精确匹配,不再出现 size 被拒或比例错位

#### 测试

- `pnpm vitest run useDisplaySrc.test.ts` → **9/9 全过**(dataURL 转换、HTTP 透传、卸载 revoke、src 切换 5 场景)
- `pnpm vitest run ApiService.gptImage2Vip.test.ts` → 文生图 + 图编辑全路径覆盖
- 全量 `pnpm vitest run` → 1531 pass / 25 fail,fail 全部是预存的 ZodError / agent / pipeline 老问题(逐一核对失败文件均未触及本次改动)
- lint 7 个新接入文件 0 错误

---

### v4.3.14 (2026-05-21) — 批量完成卡顿根除 + COS 上传事件驱动重构

**A. 批量页完成瞬间卡顿修复(根因 #1)**

**问题**: 5 张图批量生成完成时，UI 卡顿 150-750ms,"开始生成"按钮无法及时回到可点击状态。

**根因**: `runBatch` finally 里串行 `await historyService.addToHistory(...)` × N，每次都触发 `historyManager.add() → await this.save() → IPC 序列化整个 history 数组 → fs.writeFile(history.json)`。5 张图 = 5 次串行 IPC + 5 次整文件写入，期间 `running=true` 不能切换 → UI 状态卡住。

**修复** (`src/renderer/src/stores/useBatchStore.ts`):

| 改动 | 说明 |
|------|------|
| 删除 finally 里的串行 history 循环 | `runBatch` 末尾不再写 history，立即 `set({running: false})` |
| History 写入下放到 `batch:` COS 事件 handler | 每张图 COS 上传完成时各自异步写一条 history，不阻塞 UI 关键路径 |
| `pendingBatchHistoryContext` Map | 暂存 prompt/ratio/refRaw/modelKey/modelUrl 等闭包变量，event handler 按 itemId 查表后 delete 防泄漏 |
| `removeItem` / `clearAll` 清理 context | 保持"删除/清空后不进 history"语义 |

**额外收益**: History 持久化用 **cosUrl** 而不是会过期的 modelUrl。旧版批量结束时 cosUrl 大概率没回来 → 只能 fallback modelUrl → 几小时后 history 失效。新版在 COS 上传成功后才写，写的就是永久 cosUrl，失败才 fallback。

**B. COS 上传从"预测返回"重构为"事件回推"(根因 #2)**

**v4.3.13 遗留问题**: 立即返回预测 URL + `setImmediate` 延迟实际上传，导致 thumbnail 在 COS 上传完成前就被浏览器请求 → 缓存 404 → 略缩图不显示。

**修复** (`src/main/index.ts` + `src/preload/index.ts`):

| 改动 | 说明 |
|------|------|
| 新 IPC `cos:enqueue-upload-from-url` | 立即返回 `{queued: true}`，主进程后台 fetch URL → buffer → 上传 |
| 新事件 `cos:upload-result` | 主进程通过 `webContents.send` 广播上传结果给所有窗口 |
| `cos:upload-image-history` 恢复 await | 旧 IPC 改回真正 await `enqueueUpload` 完成才 return → 修复 thumbnail 404 |
| `enqueueUpload` 主进程并发门 | 4-wide gate 保留，未 settle 的 `Promise` 收集到 `inflightUploads`，`before-quit` 5s 内 drain |
| `cos:upload-image-from-url` (await 版本) | 保留给需要同步拿到 URL 的调用点 |

**C. 渲染端真 fire-and-forget(根因 #3)**

**问题**: 渲染端 batch / generate 路径每张图都 `void uploadImageUrlToCos().then(set + history)`，N 张图同时完成时 = N 个 pending promise + N 个 .then 微任务 + N 次 React 重渲染，UI 感知卡顿。

**修复**:

| 文件 | 改动 |
|------|------|
| `src/renderer/src/utils/cosUploadDispatcher.ts` (新) | 全局事件路由器，按 `prefix:` 前缀分发到各 store; `enqueueCosUpload(itemId, url, metadata)` 同步入队 0 promise |
| `src/renderer/src/stores/useBatchStore.ts` | 模块底部注册 `batch:` handler，runOne 改用 `enqueueCosUpload` |
| `src/renderer/src/stores/useGenerateStore.ts` | 模块底部注册 `generate:` handler，generate() 改用 `enqueueCosUpload`，删除 N 个并行 `await uploadImageUrlToCos().then()` |

**D. 结果卡显示优先级修复**

**问题**: COS 上传完成后切 `src={cosUrl}`，浏览器要重新下载 + 解码同一张图，N 张同时切 = 主线程卡顿 + thumbnail 闪烁。

**修复** (`src/renderer/src/pages-react/batch/BatchResultGrid.tsx`, `BatchItemRow.tsx`, `batch-punk/PunkResultGrid.tsx`, `useGenerateStore.ts`):

| 改动 | 说明 |
|------|------|
| `pickDisplayUrl: resultUrl ?? cosUrl` | 优先用已加载的模型 URL 展示，避免重新下载/解码 |
| 删除 `useGenerateStore` 里的 `nextUrls[idx] = res.url` 热切 | cosUrl 只通过 resultMeta 暴露给持久化层，live view 继续吃 modelUrl 直到 session 结束 |

**E. 历史页云端徽章修复**

**问题**: `inferStatus` 用 `r2Storage` 字段判断"是否云端"，但新 COS 上传不写 r2Storage → 5 张云端图只有 1 张显示云端徽章。

**修复** (`src/renderer/src/hooks/useHistoryData.ts`):

- 新增 `isCosUrl(url)` helper 检测 `*.cos.*.myqcloud.com` 模式
- `inferStatus` 兜底: `r2Storage` 优先 → `urls` 含 cosUrl → 视为 'ok-cloud'

#### 用户可见行为

1. **批量 5 张生成完成那一刻 UI 不再卡顿**，"开始生成"按钮立刻回到可点击状态
2. **生成多张同时完成不再卡顿**，渲染端零 pending promise 0 .then 微任务
3. **历史页所有云端图都显示 COS 徽章**，不再"只显示一个"
4. **批量历史用 cosUrl 持久化**，不再因 modelUrl 过期失效
5. Thumbnail / 略缩图 100% 显示（修复 v4.3.13 的 use-before-upload race regression）

---

### v4.3.13 (2026-05-21) — COS 图片上传异步化 + 新增 21 个 Storyboard 技能

**A. COS 图片上传性能优化**

**问题**: 用户在生图后触发 COS 历史图片上传时 UI 卡顿，主进程被 `uploadBufferToBucket` 的网络 I/O 阻塞。

**修复** (`src/main/index.ts`):

| 改动 | 说明 |
|------|------|
| Fire-and-forget 返回 | IPC handler 立即返回预测 URL（`https://{bucket}.cos.{region}.myqcloud.com/{key}`），不再 await 上传完成。渲染进程零等待 |
| 主进程并发控制 | 新增 `enqueueUpload()` + `inflightUploads: Set<Promise>`，最多 4 个并发上传。因 IPC 瞬间返回，渲染侧 semaphore 不再有效约束实际并发，改在主进程侧兜底 |
| 优雅退出 drain | `before-quit` handler 中等待 `inflightUploads` settle（最多 5 秒超时），防止关闭 app 时丢上传 |
| 输入验证保留 | `Buffer.from(base64)` + `byteLength === 0` 检查保留在返回之前，无效 payload 仍返回 `{ success: false }` |

**B. 新增 21 个 Storyboard/Director 技能**

从 super-i.cn 提取并创建 21 个中文 SKILL.md 文件，覆盖伪透视、鲁棒性破坏、负面控制、特征坍缩、时间词、导演思维、角色表演、动机驱动、色彩分级、创意想象、情感蒙太奇、前景遮挡、运动学逆向工程、光线重建、真人角色写实、多角色控制、场景拆解、镜头情绪匹配、风格提取逻辑、视频提示词优化、声音控制等方向。已全部注册到 `skill-versions.json` 并更新 `codex-research-grounded-prompting` 母 skill 的 companion 路由表。

#### 用户可见行为

1. 生图后 COS 上传不再卡顿 UI，图片 URL 即时可用
2. Skill Marketplace 新增 21 个可安装技能

---

### v4.3.12 (2026-05-21) — F11 全屏回归(因 `Menu.setApplicationMenu(null)` 副作用丢失多版本)

**问题**: 用户按 F11 完全没反应,既不进全屏也不退。窗口右上角"最大化"按钮还在工作,但 F11 这条全键盘党的标准 affordance 失效。

**根因**: Electron 的 F11 全屏切换不是平台原生的,是 default application menu 上 `role: 'togglefullscreen'` 注册的 accelerator —— menu 在,F11 就能用;menu 没了,F11 也跟着没。

`src/main/index.ts:167` 长期有这一行(为了不让原生菜单栏出现在窗口顶部影响视觉):

```typescript
// 性能优化:禁用默认应用菜单
Menu.setApplicationMenu(null)
```

这条调用把整个 application menu 拆掉,**副作用**是 togglefullscreen 的 accelerator 同时被剥除。同一文件 line 420-444 的 `before-input-event` handler 里覆盖了 F12 (devtools)、F5 / Ctrl-R / Ctrl-Shift-R (reload) 四种快捷键,**唯独没有 F11**。F11 键下放到 webContents → 没人处理 → no-op。

这条 regression 至少从 v4.3.6 切到 pnpm 那波之后就一直存在(或更早,具体哪个版本开始 set null 的还能再考古),v4.3.12 才有用户反馈出来。

**修复** (`src/main/keyboardShortcuts.ts` 新文件 + `src/main/index.ts` wire-in):

| 改动 | 文件 | 说明 |
|------|------|------|
| 抽 pure helper `resolveMainWindowShortcut(input)` | `src/main/keyboardShortcuts.ts`(新增 53 行) | 把 5 条快捷键(F12 / F5 / Ctrl-R / Ctrl-Shift-R / F11)的判定逻辑从 inline closure 抽到独立纯函数。输入 `{key, type, control, meta, shift}`,输出 `{type: 'toggleDevTools' \| 'reload' \| 'reloadIgnoringCache' \| 'toggleFullScreen'} \| null`。**显式过滤 keyDown** —— Electron `before-input-event` 同时报 keyDown 和 keyUp,toggle 类动作(devtools / fullscreen)若 keyUp 也响应会 net 到 no-op,这条防御性约束之前没有,顺便补上。**保留 Ctrl+Shift+R 必须先于 Ctrl+R 的判定顺序约束** —— 这是 v4.2.x 的老坑,反过来强刷会闪两次 |
| Wire-in 到 inline handler | `src/main/index.ts:420-444 → 22 行` | 24 行 if-else 链 → 10 行 switch over 解析结果。行为与旧版 1:1 等价,只多了 F11 这条新分支 |
| 单测覆盖 | `src/main/__tests__/keyboardShortcuts.test.ts`(新增 10 cases) | F12 / F5 / Ctrl-R / Cmd-R / Ctrl-Shift-R(覆盖 Cmd-Shift-R 同款)/ F11 各自一条,加 keyUp 忽略、大写 R 容忍(caps lock)、无 modifier 字母不抢、其他 fn 键 fallthrough 等防御性 case。**4 条已存在的快捷键之前从未有单测**,这次顺手补齐 |

**为什么不用别的方案**:

- ❌ **`Menu.setApplicationMenu(new Menu({...togglefullscreen}))`**: 想保留菜单加速键但让菜单栏不可见。macOS 上 application menu 是顶部菜单栏,空 menu 也会显示 app 名字,跟"性能优化不要菜单"的原意冲突。Windows 上 `setMenuBarVisibility(false)` 可隐藏但 macOS 不行。统一用 `before-input-event` 更跨平台干净。
- ❌ **`globalShortcut.register('F11', ...)`**: 全局热键会"抢"系统其他程序的 F11,用户在浏览器或视频播放器里按 F11 也会触发本 app,违反最小权限。
- ✅ **`before-input-event`**: 只在 app 聚焦时生效,Electron 官方推荐,与现有 4 条快捷键同款 pattern。零迁移成本。

**用户可见行为**: 升 v4.3.12 后,任何视图下按 F11 → 切换到无边框全屏(Windows / Linux),再按 F11 → 退出全屏。窗口右上角 traffic light / max-restore 按钮、`F12` devtools、`Ctrl/Cmd+R` 刷新、`Ctrl/Cmd+Shift+R` 强刷全部保持原行为不变。

---

### v4.3.11 (2026-05-21) — Hotfix: v4.3.10 installer 启动崩溃(缺 @parcel/watcher prebuilt)

**问题**: 用户装上 v4.3.10 双击启动 → 立刻弹白底红 X 错误窗:

```
A JavaScript error occurred in the main process
Error: No prebuild or local build of @parcel/watcher found.
Tried @parcel/watcher-win32-x64. Please ensure it is installed...
  at C:\Users\...\CATIMATION-Cyberpunk Master\resources\app.asar\
     node_modules\@parcel\watcher\index.js:27:13
```

主进程根本没起来。

**根因**: v4.2.9 引入 `@parcel/watcher` 做 ATTACHMENTS 面板的原生 FS watcher,通过 `optionalDependencies` 拉对应平台 prebuilt 子包(`@parcel/watcher-win32-x64` / `-darwin-arm64` / `-linux-x64-glibc` 等),里面装着 `watcher.node` C++ 原生二进制。v4.2.9 当时仓库还在用 npm,npm 默认 hoist 一切到顶层 `node_modules/`,electron-builder 扫顶层就能找到 `node_modules/@parcel/watcher-win32-x64/` 把它复制进 `app.asar.unpacked`,user 装上之后 `require('@parcel/watcher-win32-x64')` 解析正常。

v4.3.6 仓库切到 **pnpm**(`pnpm bootstrap` 脚本,`packageManager: pnpm@10.12.4`)。pnpm 默认 **传递性 optionalDependencies 不 hoist**(只 hoist 直接 dependencies),平台 prebuilt 包躺在 `node_modules/.pnpm/@parcel+watcher-win32-x64@2.5.6/node_modules/@parcel/watcher-win32-x64/`,顶层 `node_modules/@parcel/` 下只有 `watcher/`(JS wrapper)没有 `watcher-win32-x64/`。

electron-builder packaging 阶段 `searching for node modules pm=pnpm searchDir=...` 已经检测出 pnpm,但 walking 仍然只看顶层 `node_modules`,不递归 `.pnpm/`。结果 `app.asar.unpacked\node_modules\@parcel\` 下面只有 `watcher/` 一个目录,**`watcher-win32-x64/` 整个缺失**。装上电脑后 `@parcel/watcher/index.js:27` 的 `require('@parcel/watcher-win32-x64')` 必然失败,主进程 crash。

v4.3.6 ~ v4.3.10 五个版本本质上都中招了 —— 只是 v4.3.6 之前的 build pipeline 还在 npm,问题没暴露;切到 pnpm 后第一波打的安装包就是 v4.3.10。

**修复** (`.npmrc`):

```
public-hoist-pattern[]=@parcel/watcher-*
```

强制 pnpm 把 `@parcel/watcher-win32-x64` / `-darwin-*` / `-linux-*` 等所有平台 prebuilt 子包 hoist 到顶层 `node_modules/@parcel/`,electron-builder 一扫即中。`pnpm install` 一次 reinstall 后 verify:`node_modules/@parcel/watcher-win32-x64/watcher.node` 已经存在(就是缺的那个 .node)。

**为什么不一开始 hoist 全部 6 个平台 prebuilt**: 仓库 `.pnpm/` 里另外 5 个平台 prebuilt(`@esbuild/win32-x64`、`@rolldown/binding-win32-x64-msvc`、`@tailwindcss/oxide-*`、`lightningcss-*`、`@img/sharp-win32-x64`)都是 build-tool 自用,vite / rolldown / tailwind 自己会通过 `.pnpm/` 真实路径 resolve,electron-builder 也不需要把它们打进 app(它们不是 runtime 依赖)。只有 `@parcel/watcher` 是主进程 `import` 的 runtime 依赖,这条 hoist 规则只对它需要。

**预防回归**: 这条 `.npmrc` 进入仓库,后续在新机器、新 worktree 上 `pnpm install` 都会自动 hoist。还在 `.npmrc` 注释里把这次踩坑历史写进去防止后续被无意删掉。

**版本号**: v4.3.10 已上 COS 但不可用。**直接 bump 到 v4.3.11 重发**,electron-updater 看到 v4.3.11 > 已装的 v4.3.9(老用户)就会拉新版;v4.3.10 用户已经 crash 起不来,只能手动重下 v4.3.11 安装包。

**用户操作**: 已经下了 v4.3.10 的人请到 https://map-tiles-bucket-1345773498.cos.ap-guangzhou.myqcloud.com/releases/latest.yml 看到的就是 v4.3.11,从 COS 重新下载安装即可。v4.3.10 之前的版本(<=v4.3.9)正常自动更新无需手工干预。

---

### v4.3.10 (2026-05-21) — Codex 聊天 + 文件管理栏接受拖入桌面文件

本版本把"从桌面/Downloads/Finder/Explorer 拖一张图或一个文件进 app"这条体感最低门槛的交互打通到 Codex agent 链路上，分两条主线 + 一条仓库工具链改善：

**A. Codex 聊天输入框接受外部 OS 文件拖入（PR #14）**

老路径：用户把外部 OS 路径(`C:\Users\...\Downloads\foo.png`)拖进对话框 → renderer 调 `fsApi.stat(filePath)` → 主进程 `assertContained` 把任何不在 `allowedRoots` 里的路径直接拒绝 → 提示"已跳过 1 个：xxx（无法读取）"。即使越过 stat 这关，再点 Send 也会撞到 `mapReferencesToInputItems` 这道二级闸 → `agent:send-message` 抛 `Reference path is outside allowed roots`。两道闸 + 一道符号错位，外部拖入完全跑不通。

| 改动 | 文件 | 说明 |
|------|------|------|
| Tier 3 外部拖入分支 | `src/renderer/src/features/agent-chat/MentionInput.tsx` | `onDrop` 增加 Tier 3:`dataTransfer.files` 走 `electronAPI.getFilePath`(Electron 32+ `webUtils.getPathForFile`)拿真实 OS 路径,**File 对象自带 size+type**,跳过 `fsApi.stat` 这道带 `assertContained` 的闸(主进程 `AttachmentService.ingest` 用 `createReadStream` 直接读源路径,不需要 stat) |
| 解耦 attachment vs reference | `MentionInput.tsx` | 外部拖入只 `addAttachment`,**不再** `addPendingReference`。Reference 走 `mapReferencesToInputItems` 时会 `fs.realpath + assertContained` 验证 → 外部路径必拒。文件拣选器(`onFileChange`)从 v4.2.4 起就遵守这条 invariant,这次 onDrop 对齐它 |
| 完整 send-time pipeline | (无代码改动,行为变化) | 外部 file → renderer `addAttachment(rawOSPath)` → main `AttachmentService.ingest` `createReadStream` 流式读外部源 → 写到 `<userData>/agent/uploads/<sha>.<ext>`(canonical 路径,在 allowedRoots 内)→ Codex 收到 `localImage.path` 是 in-root canonical → 后端可读 → `result.userMessageItems` 把乐观消息 patch 成 canonical 路径,attachment chip 点击直达 file viewer |
| Tests | `src/renderer/src/features/agent-chat/__tests__/MentionInput.externalDrop.test.tsx` | 4 个新 case:外部拖入 attachment-only(no reference)/合成 File 无路径忽略/`fs.stat` 失败时仍能 attach(锁定不走 stat 这条 invariant)/内部 MIME 仍 push reference(锁定 Tier 2 vs Tier 3 非对称) |

**B. 文件管理栏接受外部 OS 文件拖入(PR #17 替换被自动关闭的 #15)**

工作流的另一半:用户也希望把外部文件直接 **导入** workspace,而不是只把它附到一次对话上。文件管理栏需要一条独立的 IPC + UI hook,跟 chat attach 的 path-only 模式不同 —— 这边是真复制进 workspace。

| 改动 | 文件 | 说明 |
|------|------|------|
| 主进程 IPC `fs:import-external` | `src/main/file-explorer/fsIpc.ts` + `__tests__/fsIpc.importExternal.test.ts` | `handleImportExternal({ sources, destDir })` 复制外部 OS 路径到 workspace destDir。**destDir 走 `assertContained` 拒绝 workspace 外目标,sources 故意不走**(drag-drop 本身就是用户授权面)。拒绝目录源 / 单文件 >200MB / 不可读源,通过 `written: string[]` 暴露 partial-success 状态。8 个单元测试 |
| Preload bridge | `src/preload/index.ts` + `api.d.ts` | `electronAPI.fs.importExternal(sources, destDir)` 复用现有 `safeInvoke` |
| Renderer store action | `src/renderer/src/features/file-explorer/store.ts` + `__tests__/store.importExternal.test.ts` | `importExternalByDnd(sources, destDir)` 镜像 `moveByDnd`:转发到 main,无论 ok/partial 都 `expandDir` + `selectNode` 最后一个 `written`(防 chokidar 落后 + 视图不刷)。API guard + partial-failure-still-refresh 各自有回归测试。7 个测试 |
| FileTreeNode 外部拖入 | `src/renderer/src/features/file-explorer/FileTreeNode.tsx` + `dragHelpers.ts` + `__tests__/FileTreeNode.externalDrop.test.tsx` | `onDragOver/onDrop` 识别外部 `Files` MIME,`dropEffect` 区分 `copy`(外部)/ `move`(内部)。`resolveDropDestDir` 显式拒绝 `ATTACHMENTS_ROOT` 自身 + attachment 子节点(workspace-tree-only invariant,有两个针对性回归)。`resolveExternalPaths` 抽到 `dragHelpers.ts` 给 MentionInput/FileExplorerPanel/FileTreeNode 三处复用,bridge 缺失时 console.warn。5 个测试 |
| FileExplorerPanel root 拖入 | `FileExplorerPanel.tsx` | 树底下的空白区域也接 drop,目标默认 `workspaceRoot`,不再让用户必须精确瞄准某个子目录 |

**C. 仓库工具链:`pnpm bootstrap`(PR #16)**

`.gitignore` 排除 `resources/codex/`(239MB Codex CLI 不入仓)。`git clone` / `git worktree add` 之后默认没有这个二进制 → app 启动时 `AgentRuntime` 拼一个 `spawn .../codex.exe` 直接 ENOENT → backend `start()` 抛错 → `this.client` 永远 null → 任何 chat 操作都报 `CodexLocalBackend.send called before start`。这条隐性陷阱原 README 没文档化,本版本一站式补上。

| 改动 | 文件 | 说明 |
|------|------|------|
| 一站式初始化脚本 | `package.json` `bootstrap = pnpm install && pnpm codex:fetch` | fresh clone 或新建 worktree 后跑一遍即可(`pnpm install` 自动触发 `postinstall = prisma generate && electron-builder install-app-deps`,串联 codex 二进制下载) |
| README 升级 | `README.md` | Quick Start 把首条命令换成 `pnpm bootstrap`,新增一段解释 worktree 陷阱 + 给出从兄弟 worktree `Copy-Item` 的 fast-path(239MB 不必重下) |

#### 用户可见行为

1. 在 Codex 聊天框,从桌面/下载/任意盘符 拖一张图进来 → 立即出现 attachment chip(以前固定报"无法读取")。点 Send → Codex 收到图 → 正常回复(以前报"Reference path is outside allowed roots"卡 send)。
2. 在 ATTACHMENTS / WORKSPACE 文件管理栏,从桌面拖文件/图进来 → 自动复制进当前选中的文件夹(或 workspace root),tree 即刻刷出新节点。拖到 ATTACHMENTS 树里安全降级为 no-op(`ATTACHMENTS_ROOT` 不再 fall-through 到 workspace root)。
3. fresh clone 或 `git worktree add` 之后:跑 `pnpm bootstrap` → install + 拉 Codex 二进制一次到位,启动不再卡在 `send called before start` 这条隐性错误。

#### 测试

- `pnpm vitest run agent-chat/__tests__/MentionInput.externalDrop.test.tsx` → **4/4**
- `pnpm vitest run file-explorer/__tests__/{fsIpc.importExternal,store.importExternal,FileTreeNode.externalDrop}.test.{ts,tsx}` → **20/20**(8 + 7 + 5)
- `pnpm vitest run agent-chat` → 305 测试中 294 pass,11 fail 全在 `Lightbox.video.test.tsx`(自 PR #10 起未动过,与本次无关)
- 三轮人工 smoke(包含 ATTACHMENTS_ROOT fall-through、attachment-children 误投递、partial-failure UI 不刷新三个边界 bug)

参考:
- PR #14:[2799662352/ai-image-master#14](https://github.com/2799662352/ai-image-master/pull/14)(chat 拖入,含 `3c48116 bypass fs:stat` + `303437f drop external-drop reference` 两条 fix)
- PR #17:[#17](https://github.com/2799662352/ai-image-master/pull/17)(文件管理栏,替换被关闭的 #15)
- PR #16:[#16](https://github.com/2799662352/ai-image-master/pull/16)(`pnpm bootstrap`)
- Codex `localImage.path` 协议沙箱模型:`src/main/agent/codexUserInput.ts` + `AttachmentService.ts`

---

### v4.3.9 (2026-05-20) — Hotfix: 快速点击 tab 闪屏

**问题**: 用户连续快速点击不同 tab(例如 BATCH → AGENT → BATCH),会看到大约 16ms 的旧页面内容闪现,即使最终落点正确。DevTools 控制台还会冒出 Chrome 的 `Throttling navigation to prevent the browser from hanging` 警告。

**根因**: `TabManager.switchTab` 把 `onTabChange` 回调放在两层 `requestAnimationFrame` 之后才触发,闭包里 `newTab` 是 stale 的;再叠加 `ServiceBridge` 里的双向同步 (`tabManager.onTabChange` ↔ `useTabStore.subscribe`),stale 回调会把 React 状态反推回旧 tab,触发一次「面板可见性回滚 → 又被新一轮 RAF 拉回」的奇怪过山车。

**修复** (`src/renderer/src/features/tab-manager/TabManager.ts`):

| 改动 | 说明 |
|------|------|
| `onTabChange` 回调改成 **同步触发** | 与 `updateTabUI` 在同一 task 完成,React mount/unmount 的可见性切换跟 `panel.hidden` 切换原子化,既消除闪屏也消除空帧 |
| Generation counter + `cancelAnimationFrame` | 每次 `switchTab` 自增 generation,RAF 回调进门先核对,stale 的直接放弃;同时显式取消上一次还在排队的 RAF |
| `reentrancyGuard` | 回调里如果再调 `switchTab` 直接吞掉,让最外层那次 `switchTab` 决定最终状态,杜绝双向同步的回环 |
| `deactivatePage` / `activatePage` 仍走 RAF | 这两个可能跑数据加载等重活,保留延迟避免阻塞首帧 |
| `destroy()` 也清理 pending RAF | 防止 hot reload / unmount 时 RAF 漏跑 |

**测试** (`src/renderer/src/features/tab-manager/__tests__/TabManager.rapidClicks.test.ts`):

5 条新增回归用例,覆盖:
1. 快点击 `batch → agentWorkspace` 后 DOM 直接落在最终 tab,中间态不残留
2. `onTabChange` 必须同步触发,且 `newTab` 与调用顺序严格匹配
3. stale RAF 被取消:`activatePage` 只对最终 tab 跑一次
4. `reentrancyGuard` 兜住回调里再调 `switchTab` 的反向同步循环
5. 相同 tab 重复 `switchTab` 是 no-op

**影响范围**: 仅 `TabManager.switchTab` 内部时序,公共 API 完全不变。所有现有 `ServiceBridge` + `useTabStore` 的双向同步代码无需改动,reentrancyGuard 在 TabManager 层兜底即可。

**升级路径**: 直接覆盖安装,无破坏性变更。

---

### v4.3.8 (2026-05-20)

本次发布是一波 **批量页性能 + 系统稳定性硬化** 综合补丁,聚焦"生图过多卡顿 / 内存涨 / 自我删除"三个老用户痛点。两条主线:

**A. 批量结果页性能(BatchResultGrid)**

200+ 张卡片场景下"改一条 item 状态全网格重渲"的渲染风暴,叠加 `items.indexOf` 的 O(N²) 主线程开销 ——

| 改动 | 文件 | 说明 |
|------|------|------|
| `O(N²) indexOf → Map(O(N)) lookup` | `src/renderer/src/pages-react/batch/BatchResultGrid.tsx` | 加 `indexById = useMemo(Map<id, idx>)` 替换 `displayItems.map` 里的 `items.indexOf(item)`。200 items 时单次渲染从 ~4 万次 indexOf 降到 200+200 次 Map 操作 |
| `React.memo(ResultCard)` + 父侧 `useCallback` | `BatchResultGrid.tsx` + `pages-react/BatchPage.tsx` | 把卡片包 memo,父侧 `handleEditItem` / `handlePreview` 改 `useCallback` 引用稳定,grid 内 `handleOpenEditor` 也提到顶层。zustand `items.map` 保留未变 item 的引用 → memo 浅比较跳过未变卡片。单 item 状态翻转从触发全 N 张卡片重渲降为只重渲那 1 张 |
| `failedItems` / `doneItems` / `displayItems` / `injectPrompt` 全部 useMemo / useCallback | `BatchResultGrid.tsx` | 派生数组依赖锁死, 防御性消除 N×O(N) 重扫 |
| `<img decoding="async">` | `BatchResultGrid.tsx` | 大图解码 offload 到后台线程, 大量已完成结果同时进视口时不阻塞主线程 |
| **react-window 2.x 虚拟化** | `BatchResultGrid.tsx` + `package.json` (新增 `react-window@^2.2.7`) | 阈值化策略: `items.length < 30` 走原 CSS Grid 保留页面整体滚动 UX, `>= 30` 切到 react-window `<Grid>` 内嵌滚动只渲染视口可见 cell。`useContainerSize` 用 ResizeObserver 跟踪容器宽度 + window.innerHeight × 0.7 自适应视口高度。`cellProps` 全 useMemo 保持引用稳定 → react-window 内部跳过未变 cell。200 items 满载时 DOM 节点从 ~6000 降到 ~360, decoded image bitmap 内存从 ~800MB 降到 ~50MB |

**B. 主进程稳定性 / 资源泄漏(第五轮系统性挖洞)**

| 改动 | 文件 | 说明 |
|------|------|------|
| **修: 更新冲突自我删除** | `src/main/updater.ts` + `src/main/index.ts` | 真因不是 `before-quit` 逻辑而是 child process (codex agent / docker MCP gateway) 在 `quitAndInstall` 时仍持有文件句柄 → NSIS 装不上去。新增 `UpdaterConfig.preInstallCleanup` 钩子, `handleInstall()` 先 `await cleanup()`(带 8s 超时兜底)再 `quitAndInstall`。`index.ts` 注入 `cleanupAgentRuntime()` 作为 cleanup 实现, 解除所有 child process + 文件句柄 |
| **IPC 大 base64 入参 OOM 防护** | `src/main/index.ts` | `cos:upload-image-history` / `save-image` / `export-image` 三个 IPC 加 `MAX_IPC_BASE64_STRING_BYTES = 80MB` + `rejectOversizedBase64()` helper。超大恶意/异常调用在字符串长度校验阶段就拒掉, 不再走到 Buffer.from(base64) 把主进程 OOM |
| **修: codex agent 日志 FD 泄漏** | `src/main/agent/CodexLocalBackend.ts` | `SpawnedCodexClient` 加 `log: WriteStream \| null` 字段持有日志流引用, `start()` / `stop()` / `restartCodex()` 显式 `log.end()` 关闭。修复 provider 切换 / agent 重启时 fs.WriteStream 一个不放的累计 FD 泄漏 |
| **修: COS sliceUploadFile 异常分支 FD 泄漏** | `src/main/services/tencent/cosClient.ts` + `__tests__/cosClient.test.ts` | `uploadStream` 增加防御层: (a) 代理 `onTaskReady` 抓住 taskId; (b) `SLICE_UPLOAD_HARD_TIMEOUT_MS = 10min` 硬超时, 超时主动 `cancelUpload(taskId)`; (c) sliceUploadFile callback err 分支显式 `safeCancel()` 兜底, 不依赖 SDK 内部 TaskInfo Map 清理。用户提供的 `onTaskReady` 包 try/catch 隔离, 异常不传染 |

**C. 历史/批量页"重新编辑"功能闭环**

| 改动 | 文件 | 说明 |
|------|------|------|
| `BatchItem.snapshot` 字段 | `src/renderer/src/stores/useBatchStore.ts` | `BatchItemSnapshot { prompt, ratio, referenceImages, modelKey }`。`runBatch` 启动时 captures `runSnapshotBase`,`claimNextPending` 把"分发到 worker"的瞬间快照附到每个 BatchItem 上, pending 阶段保持 undefined |
| `restoreForEdit` mode 保留语义 | `useBatchStore.ts` | snapshot.mode 未指定时保留当前 store.mode, BatchPage 显式传 `mode: 'card'` 走单项重编辑, HistoryPage 同款。修复批量页"重编辑只塞文本不载图"的回归 |
| 历史页 + 批量页 ↺ EDIT 按钮 | `pages-react/HistoryPage.tsx` + `pages-react/BatchPage.tsx` + `pages-react/batch/BatchResultGrid.tsx` + `pages-react/generate/ResultGrid.tsx` + `pages-react/batch-punk/PunkResultGrid.tsx` + `pages-react/batch/BatchItemRow.tsx` + `components/donor/DonorCard.tsx` | `onEditPrompt(string)` → `onEditItem(item: BatchItem)` 重命名, 让父组件能拿到完整 snapshot 一起回灌。Donor 卡按钮永久可见(不再 hover 才出), title 区分有/无 snapshot 两态。BatchPage `handleEditItem` 复用 `useBatchStore.restoreForEdit` + `useModelStore.switchModel`, 跟 HistoryPage 走完全同一条 code path |

**D. 异步 COS 转存 URL 上屏**

| 改动 | 文件 | 说明 |
|------|------|------|
| 异步上传 hook | `src/renderer/src/utils/cosImageUpload.ts` (新) | `cosImageUpload(resultUrl, item)` → 返回 cosUrl + status。`useBatchStore` / `useGenerateStore` 生成成功后 fire-and-forget 触发, status 字段(`uploading` / `uploaded` / `failed`) 通过 zustand 同步到 UI |
| 卡片角标 | `BatchResultGrid.tsx` + `ResultGrid.tsx` | 三态角标 `up…` / `cos` / `!cos`, hover title 解释含义。`pickDisplayUrl` 优先选 `cosUrl` 兜底 `resultUrl`, 持久化链接生效后 UI 自动切换 |

**E. 其它打磨**

| 改动 | 文件 | 说明 |
|------|------|------|
| 内置版本号文案修正 | `src/renderer/src/main.tsx` + `src/renderer/src/features/intro-video/IntroVideoController.ts` + `src/renderer/src/features/updater/UpdateNotification.ts` | 启动页 / 更新提示窗口里硬编码的版本号字符串同步到 4.3.8 |
| 历史数据服务签名收紧 | `src/renderer/src/features/history/HistoryDataService.ts` + `hooks/useHistoryData.ts` + `services/cache/ImageCacheService.ts` | 跟 `cosUrl` / snapshot 字段配套的类型补全, 没运行时行为变化 |

#### 测试

- `pnpm exec vitest run useBatchStore.test.ts` → **28/28 全过**(其中含 3 个 batch 队列爆发并发的 timing-sensitive 测试)
- `pnpm exec vitest run cosClient.test.ts` → COS 上传防御层新增的 timeout / cancel 路径全过
- 受影响文件 lint / typecheck 干净(其它存量类型错误在 storage / storyboard-pipeline / LazyLibraries, 跟本次无关)

#### 用户可见行为

1. 升级到 v4.3.8 不再出现"更新装到一半 app 自己消失"(即使没装上, 老 exe 也保留, 重新启动 → 重新拉更新, 不会进死循环)
2. 批量页跑 100+ 任务: 滚动稳定 60fps, 内存涨幅显著降低, 不再有"卡到爆"的体感
3. 历史 / 批量任一项的 ↺ EDIT 按钮永久可见, 点了能把 prompt / 比例 / 参考图 / 模型一起灌回输入框
4. 任一图片生成后, 卡片左下角实时显示 COS 上传状态角标; 升到 `cos` 后即使会话关闭再打开, 图也不会因为模型 URL 过期而 404

参考:
- React 官方 `React.memo` + `useCallback` 配合模式: <https://react.dev/reference/react/useCallback>
- react-window 2.x 文档: <https://github.com/bvaughn/react-window>
- electron-updater `quitAndInstall` 流程: <https://www.electron.build/auto-update>

### v4.3.7 (2026-05-19)

v4.3.5 落地 Skill Marketplace MVP 后，收到的 UX 反馈分两批：

1. "光在 tab bar 加一个『技能市场』tab 不够直观，应该在 Agent Workspace 的 Skills 页面有一个明显按钮一键跳过去；商城页本身应该像 Cursor 应用市场那样——左侧分类导航 + 右侧卡片 grid，而不是平铺三列。"
2. "点不动按钮 / 卸载按钮一直抽搐。"

第一批是预期 UI 抛光；第二批是 bug——marketplace tab 加在 React `useTabStore` 里却没在底层 vanilla DOM 体系（`TabManager.DEFAULT_VALID_TABS` + `index.html` 的 `<div id="xxxPanel">`）里注册，加上"已安装"按钮 hover 时切换两种文案的渲染宽度不一致导致 bounding box 跳变。v4.3.7 把这两批一并发掉。

> **注**：原计划的 v4.3.6 没真正进入仓库历史（commit/tag 都没存在），所以这次直接跳号到 v4.3.7。如果你看到 docs/聊天记录里出现过 v4.3.6 字样，对应的内容已合并进本条目。

| 改动 | 文件 | 说明 |
|------|------|------|
| Agent Workspace 入口 | `src/renderer/src/features/agent-workspace/SkillsSection.tsx` (+18) | "New Skill" 按钮旁加一颗亮黄色 "🛒 Skill 商城" 按钮,点击通过 `useTabStore.switchTab('marketplace')` 跳转。视觉上是头部 3 个 action 中最显眼的一个（cyberpunk yellow filled），优先级高于"打开 Skills 文件夹"和"New Skill" |
| 商城页重写 | `src/renderer/src/pages-react/MarketplacePage.tsx` (重写 ~280 行) | 从三列 tab（可安装/已安装/有更新）变成 Cursor-marketplace 风格的左侧 sidebar + 右侧 grid 卡片：sidebar 7 个分类（Featured / Director / Storyboard / Methodology / Other / Installed / Updates），每项带 emoji icon + 计数；顶部有搜索框（按名称或描述模糊匹配）；卡片每行 2 列（lg breakpoint），包含 emoji 图标 + skill 名称 + 版本号 + 2 行描述截断 + 体积 + 已认领 badge + Get / Installed ✓ / Update 按钮 |
| **Bugfix: marketplace tab 注册** | `src/renderer/src/features/tab-manager/TabManager.ts` (+1), `src/renderer/index.html` (+5), `src/renderer/src/react-app/main.tsx` (+27), `src/renderer/src/services/ServiceBridge.ts` (+8) | 项目目前是两套 tab 系统并存的渐进迁移状态：上层 React `useTabStore` 走 zustand 状态，下层是 vanilla DOM 的 `TabManager` + `index.html` 里手写的 `<div id="xxxPanel">` panel。`marketplace` 之前只加在 React 侧，导致 zustand subscribe 转发到 `TabManager.switchTab('marketplace')` 时被白名单拒绝（控制台 `无效的标签名: marketplace`），按钮点了没反应。修复：(a) `DEFAULT_VALID_TABS` 加 `'marketplace'`，(b) `index.html` 加 `<div id="marketplacePanel">` 容器 + 内嵌 `<div id="marketplace-react-root">`，(c) `react-app/main.tsx` 加 `mountMarketplaceReact` / `unmountMarketplaceReact`（与其他 React-only 页面同款 lazy + Suspense 模式），(d) `ServiceBridge.ts` 把 mount/unmount 接到 onTabChange 桥 + 启动时预 mount 一次 |
| **Bugfix: 已安装按钮抽搐** | `src/renderer/src/pages-react/MarketplacePage.tsx` (-5 +18) | 原实现用 `group-hover:hidden` 切换"✓ Installed" / "Uninstall" 两个 span 的 `display`，但两段文案渲染宽度不同 → hover 时按钮宽度跳变 → 鼠标恰好被甩出 button bounding box → leave 触发 → 文字切回 → 鼠标又落回 → enter 触发，进入 hover-flicker 死循环（CSS 经典坑）。修复：按钮固定 `w-24 h-7`(96×28px) bounding box 永不变；两个 span 全部 `absolute inset-0` 脱离布局流，互不影响尺寸；改用 `opacity` + `transition-opacity duration-150` 平滑切换。同时把 Get / Update 按钮也 lock 成相同尺寸，避免 busy 文案切换（Get ↔ 安装中…）抖动 |

#### 分类推导规则（不需要后端 taxonomy 字段）

```
director-*       → Director (12 个)
storyboard-*     → Storyboard (7 个)
codex-research-* → Methodology (1 个)
其他              → Other
```

Featured 是手动 curated 4 个推荐 skill（`codex-research-grounded-prompting` / `director-prompt-engineering` / `director-structured-captioning` / `storyboard-structure`），写死在 `FEATURED_NAMES` 集合里。后续要加分类只需改 `CATEGORIES` 数组，不动 catalog schema。

#### 双 tab 系统注释（给未来接手的人）

`useTabStore` 是 React 侧状态，`TabManager` + `index.html` panel 是 vanilla DOM 老体系，二者通过 `ServiceBridge` 双向 subscribe 同步。新增任何 React 路由 tab 必须**同时**：(1) 在 `useTabStore.VALID_TABS` 加，(2) 在 `TabManager.DEFAULT_VALID_TABS` 加，(3) 在 `index.html` 加 panel 容器，(4) 在 `react-app/main.tsx` 写 mount/unmount，(5) 在 `ServiceBridge` 接入 onTabChange + 预 mount。漏一处都会出现"按钮点不动"症状。

#### 用户可见行为

1. 升级 v4.3.5 → v4.3.7：自动检测热更新 → 安装 → 重启 → Agent Workspace → Skills tab 多了亮黄色 "Skill 商城" 按钮。
2. 点按钮跳转到全新商城页（左侧 sidebar 分类 + 右侧 grid），搜索 / 浏览 / 安装更顺手。
3. 已安装 skill 的卸载按钮 hover 不再抽搐：默认绿框绿字 "✓ Installed"，hover 平滑淡入红字 "Uninstall"，宽度不变。

### v4.3.6 (未发布 — 内容已合并进 v4.3.7)

### v4.3.5 (2026-05-18)

把 v4.3.3 / v4.3.4 强制 mirror 的"每次启动复制 20 个 bundled skill 到 `~/.agents/skills/`"流程**完全废弃**，改为**用户主动安装**的 Skill Marketplace（插件商城）。源头痛点：bundled skill 的目录级非覆盖镜像让升级用户必须手动删 `~/.agents/skills/<name>/` 才能拿到新版 SKILL.md（v4.3.4 changelog 里那段"升级用户需手动删除"就是这个 bug 的 UX）。MVP 把决定权还给用户——什么时候装、装哪几个、什么时候升级，全在 app 内一个新 tab 里完成。

| 改动 | 文件 | 说明 |
|------|------|------|
| 废弃 bundled mirror | `src/main/index.ts` (-60) + `electron-builder.yml` (-15) | 删除 `bundledCodexSkillsMirrorPromise` 与 `bundledCodexSkillsDir`；`load-skills` IPC 只 await legacy `<userData>/skills` 迁移那一份。installer 不再把 `resources/codex-skills/` 打入 extraResources（用户机器从此不会被自动塞 20 个 skill） |
| 新增 marketplace service | `src/main/marketplace/marketplaceService.ts` (+225) + `src/main/marketplace/ipc.ts` (+100) | DI 化的 `MarketplaceService` 类：`fetchCatalog`（缓存 + force 刷新）/ `install`（下载 zip → sha256 校验 → temp 解压 → 原子 rename → 写 state，**任何失败都不留半成品**）/ `uninstall`（删目录 + 删 state）/ `listInstalled`（读 ledger）/ `adoptExisting`（首启认领 v4.3.4 leftover）。fetcher 注入 `fetch()`（Node 18 全局），不走 Chromium 网络栈 |
| 共享类型 | `src/types/marketplace.ts` (+55) | `Catalog` / `CatalogEntry` / `InstalledRecord` / 5 个 IPC envelope。main + preload + renderer 三处共用 |
| 启动认领 | `src/main/index.ts` | 启动时 fire-and-forget 跑 `adoptExisting()`：扫 `~/.agents/skills/<name>/`，若 `<name>` 命中 catalog 且 state 里没记录 → 写入 `marketplace-state.json` 标记 `source: 'adopted'`。结果：v4.3.4 老用户升级到 v4.3.5 后，marketplace 的"已安装"页直接列出他们机器上现有的 20 个 skill，**不需要重新下载** |
| 上传脚本 | `scripts/upload-skills-to-cos.mjs` (+185) + `resources/codex-skills/skill-versions.json` (+30) | 扫 `resources/codex-skills/*` 每个目录 → 读 SKILL.md `description` + skill-versions.json 的 version → `JSZip` 打包 → sha256 → 上传 `cos://image-master-1345773498/skills/<name>-<version>.zip` → 聚合上传 `catalog.json`。`--dry-run` 不动 COS 只打印。新增 `npm run publish:skills` |
| 渲染层 marketplace 页 | `src/renderer/src/pages-react/MarketplacePage.tsx` (+275) | 三栏视图（可安装 / 已安装 / 有更新）+ 安装/升级/卸载按钮 + sha256 校验失败的 toast。卸载前 `confirm()` 二次确认。版本不一致即显示"有更新"，不假设 semver 比较——避免误判 |
| Tab 入口 | `useTabStore.ts` + `TabBar.tsx` + `AppLayout.tsx` + `pages-react/index.ts` | 新增 `marketplace` tab（🛒 技能市场），居于 Agent Workspace 与设置之间 |
| Preload bridge | `src/preload/index.ts` (+30) | 暴露 `window.electronAPI.marketplace.{fetchCatalog,install,uninstall,listInstalled,adoptExisting}`，复用现有 `safeInvoke` |
| 测试 | `src/main/marketplace/__tests__/marketplaceService.test.ts` (+340) | TDD 11 测试：catalog 缓存 / install 成功+sha256 不匹配+目录消失原子回滚 / 升级覆盖 / uninstall 含 no-op / adopt 认领 + 幂等 + 非 catalog 目录忽略 / state 跨进程持久化。+ legacy migration 6 测试不动。**17 测试全过** |

#### COS 布局

```
image-master-1345773498/
└── skills/
    ├── catalog.json                                  # ~19 KB, 20 skill entries
    ├── codex-research-grounded-prompting-1.0.0.zip   # ~21 KB
    ├── director-anchor-extraction-quality-1.0.0.zip  # ~1.2 KB
    └── ... 18 more zips
```

`catalog.json` 是 source of truth，每个 entry 含 `{name, version, description, size, sha256, url}`。客户端先拉 catalog，安装时按 `url` 下载 zip，按 `sha256` 校验，落盘到 `~/.agents/skills/<name>/`。

#### 用户可见行为

1. 全新安装 v4.3.5：`~/.agents/skills/` 是空的。打开"技能市场"tab → 可安装列表显示 20 个 skill → 用户挑想要的点"安装"。
2. v4.3.4 老用户升级：原 `~/.agents/skills/` 里的 20 个 skill 保留不动，启动时自动被 `adoptExisting` 标记为 `源: 已认领`（蓝色 badge），在"已安装"列表里直接可见。如果 catalog 里的版本与本地一致 → "有更新"是空的；如果 catalog 之后发版了新 skill 内容 → "有更新"亮起对应条目，点"升级"即可。
3. 单 skill 升级：marketplace 不再触发 app 全量热更新——`scripts/upload-skills-to-cos.mjs` 单独跑就能换 skill 内容，无需 build app/发 installer。

#### 发布步骤

```
npm run publish:skills:dry  # build & inspect catalog, no upload
npm run publish:skills      # upload to image-master-1345773498/skills/
npm run release:cn          # then build & publish app binary as usual
```

参考：
- `src/main/marketplace/`（service + ipc）
- `scripts/upload-skills-to-cos.mjs`
- `src/types/marketplace.ts`

### v4.3.4 (2026-05-18)

把 `codex-research-grounded-prompting`（方法论 skill）和 v4.3.3 同期落地的 19 个 `director-* / storyboard-*` cookbook（具体写法 skill）显式建立 method → recipe 两层关系——之前它们仅"并存"，Codex agent 没有信号知道走到某一步该 *调用* 哪一条 cookbook。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新增 `<companion-skills>` 章节 | `resources/codex-skills/codex-research-grounded-prompting/SKILL.md` (+35 行) | 在 `</verification>` 与 `<references>` 之间插入一节：(1) 用 method/recipe 二级模型重述 20 个 skill 的关系；(2) 给出"任务步骤 → 调用哪个 sibling cookbook"路由表，覆盖 Pillar 2/4/5、Lens 1-4 全部主线 + audio/dialogue/sensitive-dodge 三条横切；每行点名 sibling 贡献的具体规则（如 *色彩比 ≥7:3*、*7 字段 prompt 顺序*、*运动矢量 °/cm/m·s⁻¹*）便于模型自校；(3) 调用协议：reasoning 中 call out by name → 引用具体规则 → 多 sibling 冲突时按非重叠子维度组合；(4) caveat 解释 `appliesTo` 在移植中被剥除（pipeline hook，Codex 不认）但 rule body 域无关；(5) "don't double up" 守则——单一 recipe 任务别再戴上五 Pillar 的全套帽子 |
| 镜像生效路径 | `$HOME\.agents\skills\codex-research-grounded-prompting\SKILL.md` | 沿用 v4.3.3 的 `bundledCodexSkillsMirrorPromise` 路径，目录级非覆盖。已知行为：旧版若已存在则新版不会覆盖；release 后用户首次升级时，原 v4.3.3 mirror 仍是上一版 SKILL.md。**升级用户需手动删除** `$HOME\.agents\skills\codex-research-grounded-prompting` 一次再重启 app 才能拿到 `<companion-skills>` 章节；全新安装无需此步 |

参考：
- 5747f45 `feat(codex-skills): wire codex-research-grounded-prompting to dispatch the 19 cookbook siblings`
- 母 skill：`resources/codex-skills/codex-research-grounded-prompting/SKILL.md`
- 19 子 cookbook：`resources/codex-skills/{director-*,storyboard-*}/SKILL.md`

### v4.3.3 (2026-05-18)

Codex agent 获得首个内置 USER-scope skill：`codex-research-grounded-prompting`。

| 改动 | 文件 | 说明 |
|------|------|------|
| 新 skill 源 | `resources/codex-skills/codex-research-grounded-prompting/{SKILL.md, references/methodology-rationale.md, references/papers.md}` | Codex 体例（语义标签 + 散文），五大方法论支柱 + 五个抽取镜头；明确要求模型用自带 `web_search` / `fetch` 工具针对用户实际 brief 验证引用——文档内出现的所有导演 / 作画师 / 影片名都是 *illustrative*，决不作为默认套用 |
| 启动镜像 | `src/main/index.ts` `bundledCodexSkillsMirrorPromise` | 启动时把 `<resources>/codex-skills/` 整目录 **非覆盖** 复制到 `$HOME/.agents/skills/`；用户事后改动永远胜出，下次安装不会被回滚 |
| 打包注入 | `electron-builder.yml` extraResources 新增 `resources/codex-skills → codex-skills` | bundled 源跟随安装包分发 |
| Regression test | `src/main/agent/__tests__/legacySkillsMigration.test.ts` | 新 case 验证 bundled→user 镜像的"用户编辑在再镜像时保留" |

参考：设计 spec `docs/superpowers/specs/2026-05-18-codex-research-grounded-prompting-design.md`

### v4.2.9 (2026-05-16)

Codex 模式附件面板 live-update。修"chat 上传图片之后 ATTACHMENTS 面板不刷新，要重启 app 才能看到"。

| 改动 | 文件 | 说明 |
|------|------|------|
| Track A — in-process 成功信号 | `src/main/agent/AttachmentService.ts` | `ingestOne` 写完 disk + Prisma 后 `emit('attachment-added', { saved })`，对偶 `attachment-error` 失败通道，**保证 chat 上传场景毫秒级触达** renderer 不依赖文件系统事件 |
| Track A — 广播桥 | `src/main/file-explorer/AttachmentTreeProvider.ts` + `__tests__/AttachmentTreeProvider.test.ts` | 新增 `wireAttachmentBroadcast(service, windowsGetter)`，监听 `attachment-added` → 向所有 BrowserWindow 发 `attachments:changed` IPC，自动跳过 destroyed window |
| Track B — 原生 FS watcher | `src/main/file-explorer/AttachmentDirWatcher.ts` (新) + `__tests__/AttachmentDirWatcher.test.ts` (新, 11 tests) | 对齐 VSCode `parcelWatcher.ts` 设计：用 `@parcel/watcher@2.5.6`（VSCode 同款）监听 `userData/agent/uploads/` 递归。Windows 走 ReadDirectoryChangesW、macOS 走 FSEvents、Linux 走 inotify，C++ 层自带 `MIN_WAIT=50 / MAX_WAIT=500` debounce 保证 burst 期间 callback 不超 500ms 不 fire。JS 层加 75ms trailing aggregator（match VSCode `FILE_CHANGES_HANDLER_DELAY`）合并 callback 间事件。**覆盖 chokidar 在 Windows 高负载 burst（robocopy /MT、备份还原）下 ReadDirectoryChangesW kernel buffer 溢出丢事件的盲区** |
| 噪音过滤 | `AttachmentDirWatcher.ts` | parcel `ignore: ['**/_tmp_*']` 把 AttachmentService 的中间 tmp 文件在 C++ 层就过滤掉，砍掉 ingest 期间 ~2/3 事件量（原 3 事件：create tmp / delete tmp / create sha，过滤后只剩 create sha） |
| Race 处理 | `AttachmentDirWatcher.start()` | 处理 dispose-during-subscribe 竞态：如果 `dispose()` 在 `subscribe()` Promise resolved 之前调用，等 resolve 后立即 `unsubscribe()`，避免泄漏 native watcher |
| 渲染端订阅 | `src/preload/index.ts` + `src/renderer/src/features/file-explorer/{store,FileTree}.tsx` + 各自 `__tests__/` | preload 暴露 `attachments.onChanged(cb)` IPC，store 加 `ensureSubscriptions()` 动作（200ms trailing debounce 合并 burst），`FileTree` mount 时调用——单一入口、可测试、race-free |
| 打包配置 | `electron.vite.config.ts` + `electron-builder.yml` | `@parcel/watcher` + `/^@parcel\/watcher-/` 加入 main external（native .node 不可 bundle）；`**/node_modules/@parcel/watcher*/**` 加入 `asarUnpack`（wildcard 通配 wrapper + 平台二进制子包 `@parcel/watcher-win32-x64` 等） |

参考：
- VSCode 文件 watcher：[parcelWatcher.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/files/node/watcher/parcel/parcelWatcher.ts)（`FILE_CHANGES_HANDLER_DELAY=75`，excludes 模式，watcher fail 容灾）
- parcel C++ debounce 源码：[Debounce.cc](https://github.com/parcel-bundler/watcher/blob/v2.5.6/src/Debounce.cc)（`MIN_WAIT_TIME=50`, `MAX_WAIT_TIME=500`）
- 没采用 ThrottledWorker(500) chunk size：我们的 broadcast 无 payload，C++ → JS marshal 后只 check `.length`，没有 per-event 工作可 chunk

#### 用户可见行为
- chat 上传图片或拖文件进 chat → ATTACHMENTS 面板 75-275ms 内自动出现新条目（不需重启 app）
- 外部修改 uploads 目录（手动拖入、还原备份、其他进程写入）→ 75-700ms 内面板自动刷新
- 沙箱/EACCES 等极端环境 native watcher 启动失败 → log warn 后降级运行，chat 上传仍能即时刷新（Track A in-process 兜底）

### v4.2.8 (2026-05-15)

三个用户反馈直击的修复。

| 改动 | 文件 | 说明 |
|------|------|------|
| Smart Erase 去超时 | `src/main/services/smartErase/runner.ts` | 删掉 `POLL_TIMEOUT`（原 60min 硬 deadline），改 `while(true)` 直到 MPS 终态（SUCCESS / FAIL / CANCELLED）或用户取消。长任务（≥200 次 PROCESSING）不再被代码主动杀掉 |
| Smart Erase 真实进度 | `runner.ts` + `src/types/smartErase.ts` + `src/renderer/src/pages-react/smart-erase/{EraseQueue,useEraseEvents}.tsx` | 新增 `summarizeTaskDetail()` 把 `DescribeTaskDetail` curate 成 `EraseTaskDetailSnapshot`（progress / workflowStatus / smartEraseStatus / errCode / message / output path / timing），每次 poll 通过 `onProgress` + IPC 透传到 renderer。UI 优先用真实 `mpsProgress`，估计值加 `~` 后缀区分 |
| Smart Erase 查看详情 | `EraseQueue.tsx` | 每行加 `[详情]` 按钮，展开内嵌 `DetailPanel` 显示 curated 字段，对标腾讯控制台"查看结果详情" |
| 批量队列爆发并发 | `src/renderer/src/stores/useBatchStore.ts` | `addItem` 在跑批中触发 `_spawnWorker`；`concurrency` 改为只决定初始池大小，`HARD_MAX_WORKERS = 6` 兜上限。修第二批任务不会立即启动的 UX 问题 |
| 参考图上限 8 → 12 | `ReferenceImageUpload.tsx` / `PunkRefDrop.tsx` / `BatchRefDrop.tsx` / `ExampleGallery.tsx` / `useDirectorStore.ts` / 4 语言 i18n / `index.html` / `GeneratePage.ts` | 所有上传入口、store guard、提示文案统一升到 12 张 |
| 视觉 Prompt 辅助上 Generate / Compare | 新增 `GeneratePromptHelperBar.tsx` + `ComparePromptHelperBar.tsx` + `useVanillaPageRefImages.ts` hook | 多角度 / 打光 按钮在 Generate 和 Compare 也能用了，参考图有/无状态用 `MutationObserver` 事件驱动联动 |

### v4.2.6 (2026-05-14)

修复"Codex 连接失败：PGlite worker error: Aborted()"——升级覆盖安装 / 强杀 / 双开后启动崩溃。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `src/main/agent/pgliteRecovery.ts` (新) + `__tests__/pgliteRecovery.test.ts` (新, 15 tests) | 三个纯函数：`isPgliteAbortedError`（容忍 `Aborted()` / `RuntimeError + callMain` / `wasm-function + callMain` 三种 wrapper）、`moveCorruptDataDir`（同毫秒冲突用 `-N` 防撞）、`isResetAllowedNow` + `recordResetAttempt`（24h 滚动窗口的电路断路器） |
| Phase 2 | `src/main/agent/db.ts` | `startEmbeddedPGlite` 重写：第一次启动失败 → 命中 `Aborted` → 检查 24h 内重置次数 < 4 → 把 `pgdata/` 改名为 `pgdata.corrupted-{ISO}` 留档 → 用同名空目录重试一次。重试也失败 / 断路器跳闸 → 切换到 `pgdata-ephemeral-{pid}` 临时模式（本会话不持久但 app 不再卡死）。三种结果都通过 `consumeStartupNotice()` 留通知 |
| Phase 3 | `src/main/index.ts` | (A) `app.requestSingleInstanceLock()` + `second-instance` 聚焦回主窗口——堵住 PGlite #884 的"双开 → 同时打开同一 dataDir → 必腐化"通道；(B) `initAgentRuntime` 在 `agentManager.start()` 后用 `did-finish-load` + 250ms grace 把 `consumeStartupNotice()` 的内容通过 `agent:event` 发到 renderer，避开 `webContents.send` 在 listener 未挂时静默丢消息的 race |
| Phase 4 | `src/types/agent.ts` + `src/renderer/src/features/agent-chat/NoticesBanner.tsx` | 新 `AgentNotice` kind `pgliteReset`（warning 级别）+ Banner 标签 `database`，details 携带 `backupPath` / `ephemeralDir` / `reason: aborted-recovered \| aborted-rebuild-failed \| breaker-tripped` |

参考：
- 上游 issue 串：[electric-sql/pglite#884](https://github.com/electric-sql/pglite/issues/884)（`Aborted()` 在 callMain，PR #892 in flight 未合）+ [#794](https://github.com/electric-sql/pglite/issues/794)（同根因，第二次 open 必崩）
- PGlite 自陈："Postgres in 'single user mode'... will corrupt the database if you open it multiple times at once"（docs/filesystems.md）
- Codex 类比：[openai/codex#11435](https://github.com/openai/codex/issues/11435)（"per-process unique session directories"，本次 ephemeral 兜底借鉴）

#### 用户可见行为
- 旧用户升级后第一次启动如果命中此 bug：弹一条黄色 banner "数据库目录无法打开（PGlite #884 已知 bug），已自动重建。旧数据备份在：…\pgdata.corrupted-2026-05-14T…"，agent 历史归零但 app 立即可用。备份目录可手动检查或在上游修复后导入。
- 24h 内连续 4 次重置触发断路器后：banner 变成 "切换到临时模式"，提示用户手动清理或排查硬件 / 杀软干扰。
- 双开第二个实例：第二个进程立即 quit，第一个窗口被 focus 到前台。

### v4.2.5 (2026-05-13)

修复"PlanCard 不渲染 / `update_plan` 工具仍走通用 chip"的双向问题。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase 1 | `src/main/agent/codexNotificationRouter.ts` | `TurnPlanStepStatus` 在 v2 协议是 camelCase（`inProgress`），工具参数是 snake_case（`in_progress`）—— 新增 `normalisePlanStepStatus` 折叠大小写 + 分隔符 + 同义词（`done`/`active`/`running`），所有渠道统一规一化为 snake_case。证据：`codex-rs/app-server-protocol/src/protocol/v2.rs:6450` |
| Phase 2 | `src/main/agent/codexNotificationRouter.ts` | v2 `ThreadItem::DynamicToolCall` 的工具名字段是 `tool`，旧 build 是 `toolName`，MCP 是 `name`。`summarizeActivity` + `readToolName` 都改成 canonical-first（`tool → toolName → name`）。证据：v2.rs:5578 |
| Phase 3 | `src/main/agent/codexNotificationRouter.ts` | plan tool 命中后**始终路由**，即便 args 完全没有结构化 plan 数据也发 placeholder 事件。新增 `extractStepsFromAnywhere` 覆盖 `plan`/`todo`/`todos`/`steps`/`items`/`args` 自身 5+ 种字段形状，外加自由文本回退：解析 `1./1)/1、/-/•/①…⑩` 列表标记 + `[x]/[-]/[ ]` 复选框 + 周围 prose 的"第 N 项进行中" / "已完成第 1、2 项" 状态线索 |
| Phase 4 | `src/renderer/src/features/agent-chat/cards/ActivityCard.tsx` | PlanCard 视觉重写：单行头部 `☰ X of Y Done`（图 1 spec），干净状态图标（`○` pending / `→` in_progress / `⊘` completed），空步骤态显示 `Creating plan…` placeholder 占位（不再回退到通用 chip） |
| Phase 5 | 测试 | +5 router 测试（camelCase / kebab / Pascal / 同义词 / 自由文本 markdown / `args.todo` 单数 / checkbox 标记）；+2 PlanCard 测试（placeholder 态 + explanation 显示）；总计 87 plan 相关测试全过 |

参考：
- Codex protocol 源：`codex-rs/app-server-protocol/src/protocol/v2.rs`
- Codex plan_tool 源：`codex-rs/protocol/src/plan_tool.rs`
- Codex PR #7329（`turn/plan/updated` 通知）/ PR #10124（`update_plan` → `todo_write` rename，未合并）

### v4.2.4 (2026-05-11)

修复"拖大文件进对话框 → Prisma `Server has closed the connection`"崩溃。

| 改动 | 文件 | 说明 |
|------|------|------|
| Phase A | `src/main/agent/AttachmentService.ts` | 改成**流式 ingest**：`pipeline(createReadStream → writeStream)` + chunk-level sha256，串行处理 + 每文件后 `setImmediate` 让出事件循环，单文件失败通过 `attachment-error` event 隔离不杀整轮 |
| Phase A | `src/main/agent/AgentManager.ts` + `src/types/agent.ts` + `src/renderer/src/features/agent-chat/{store,NoticesBanner}` | 新增 `attachment_error` 流事件 + `attachmentSkipped` notice，前端显示"已跳过 xx.md：原因" |
| Phase B | `src/renderer/src/features/agent-chat/MentionInput.tsx` | picker 路径优先用 `webUtils.getPathForFile`（preload 已暴露），只在 fallback 时才读 `arrayBuffer()`。从此 N 个 100MB 文件不再经 IPC structuredClone |
| Phase C | `src/main/agent/pgliteWorker.ts` + `src/main/agent/db.ts` + `scripts/build-pglite-worker.mjs` | PGlite + `PGLiteSocketServer` 搬到 Electron `utilityProcess`，主进程偶发卡顿不再饿死数据库 socket。worker 用 esbuild 单独打成 1.6KB CJS bundle |

参考：
- 复盘 spec：`docs/superpowers/specs/2026-05-11-attachment-streaming-design.md`
- Codex 同类问题：openai/codex#13508、#15270、PR #21108

### v4.2.3 (2026-05-10)

- 取消客户端显式超时（"天荒地老"模式）：删除 `ApiService` 中的 `composeTimeoutSignal`
- 进度条动画窗口从 5 分钟拉到 15 分钟（`GeneratePage`）
- BatchPage 全量重写为 zinc + 赛博朋克黄风格

### v4.2.2 (2026-05-09)

- MCP 端口绑定方案 B：默认 7842 优先，`EACCES`/`EADDRINUSE` 自动回退 ephemeral，全部失败时优雅降级
