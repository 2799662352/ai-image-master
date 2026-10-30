# CATIMATION Cyberpunk Master / AI Image Master

An open-source Electron desktop workspace for AI-assisted image and video creation, visual storyboarding, and creative production workflows.

**Downloads:** Official Windows installers are available from [GitHub Releases](https://github.com/2799662352/ai-image-master/releases).

## Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

Official Windows releases follow the project's [Code signing policy](docs/CODE_SIGNING_POLICY.md). Data handling is documented in the [Privacy Policy](docs/PRIVACY.md).

## 中文简介

AI 图片生成桌面应用 — Electron + React + LangChain/LangGraph。
支持文生图、参考图、批量生成、Director 多阶段流水线和 StoryboardPro 分镜系统。

![TypeScript](https://img.shields.io/badge/TypeScript-95%25-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-35-47848F?style=flat-square&logo=electron&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

## 核心功能

| 模块 | 描述 |
|------|------|
| **图片生成** | 多模型 (Gemini / Seedream / Sora / Flux Kontext)，参考图上传，多分辨率 (1K–4K) |
| **Director 模式** | LangGraph 4-pass 流水线: 技能选择→场景分析→角色锚点→设计组装→一致性校验 |
| **StoryboardPro** | 九宫格分镜、剧场版动画、电影级模板、Sora2 视频提示词生成 |
| **批量生成** | 抽卡模式 + 多提示词模式，智能并发队列 |
| **模型对比** | 双模型同时生成对比，参考图自动同步 |
| **图像理解** | 多模型图像分析，流式输出 |
| **历史记录** | 自动保存 + R2 云端存储，批量下载/删除，虚拟滚动 |
| **Skills 系统** | 内置 + 用户自定义 Skill (Markdown)，运行时热加载 |
| **国际化** | 简中 / 繁中 / English / Русский |

## 快速开始

```bash
git clone https://github.com/2799662352/ai-image-master.git
cd ai-image-master
pnpm bootstrap           # pnpm install + 下载 Codex 二进制 (~239MB)
pnpm dev                 # 开发模式 (electron-vite)
pnpm build               # 构建并打包
pnpm build:win           # Windows 安装包
```

`pnpm bootstrap` 是 fresh clone 或新建 `git worktree` 后的一站式初始化:跑 `pnpm install`(自动触发 `prisma generate` + `electron-builder install-app-deps`)+ `pnpm codex:fetch` 把 Codex CLI 二进制下到 `resources/codex/`。`.gitignore` 排除了那个目录(避免 200+MB 进仓),所以新 worktree 不跑 bootstrap 会在启动时报 `CodexLocalBackend.send called before start`(本质是 `spawn codex.exe ENOENT`)。

如果你已经在主 worktree 跑过 `codex:fetch`,新建 worktree 时可以直接 `Copy-Item ../../resources/codex/* ./resources/codex/ -Recurse`(或 `cp -r`),比重新下 239MB 快得多。

纯 Electron 桌面应用,无 Docker 部署。

## 远程 apiyi 网关 / BYOK(可选)

(桌面端内置的 apiyi MCP 已于 2026-10-30 移除,本节说的是**自己服务器上**独立部署的版本,不受影响。)

如果想跨设备/多人共用 `apiyi-mcp-server` 的能力 —— 在自己的服务器上挂一个 HTTPS endpoint,
**每个用户填自己的 apiyi key**(BYOK,Bring Your Own Key):

```
[ Client ] ─ Authorization: Bearer sk-xxx ─→ https://api.example.com/mcp
                                                    │
                                                    ▼ (HTTPS / CDN / DDoS / WAF)
                                          [ 腾讯 EdgeOne (或其他 CDN) ]
                                                    │ 回源 HTTP:80
                                                    ▼
                                            [ apiyi-fastmcp (Python) ]
                                                    │ per call: read Bearer,
                                                    │ build google-genai client
                                                    ▼
                                              api.apiyi.com
```

实现细节:`deploy/apiyi-fastmcp/server.py` 用 **FastMCP** 重写了 `apiyi-mcp-server`(原 Node 版)
的两个工具 `generate_content` + `generate_content_batch`,直接调用 `google-genai` Python SDK
打到 apiyi 网关。**API key 来自每次请求的 Authorization 头**,服务端不持有任何 key、不缓存任何 key,
是目前主流 MCP 网关(Docker MCP Gateway / Supergateway / mcp-proxy)都不原生支持的 BYOK 模式。

源站只跑 FastMCP 监听 80 端口,HTTPS 由前面的 CDN / 反代统一终止(我们用的是腾讯 EdgeOne;
没有 CDN 就翻 git 历史拉回 Caddy 配置自己签 Let's Encrypt 证书,二选一)。

完整方案见 [`deploy/README.md`](./deploy/README.md) —— 包含 EdgeOne 配置、运维、安全模型、
客户端 JSON 配置示例(支持 Cursor / Codex / Claude Desktop)。

镜像已发布到 Docker Hub:[`zuozuoliang999/apiyi-fastmcp`](https://hub.docker.com/r/zuozuoliang999/apiyi-fastmcp)
(linux/amd64)。在自己的服务器上一行 `docker run` 即可拉起:

```bash
docker run -d --name apiyi-fastmcp --restart unless-stopped \
  -p 80:8000 \
  -e APIYI_BASE_URL=https://api.apiyi.com \
  -e GEMINI_MODEL=gemini-3.1-pro-preview-thinking \
  -e FASTMCP_HOST=0.0.0.0 -e FASTMCP_PORT=8000 \
  -e FASTMCP_PATH=/mcp -e FASTMCP_TRANSPORT=http \
  zuozuoliang999/apiyi-fastmcp:latest
```

## 项目结构

```
ai-image-master/
├── src/
│   ├── main/                           # Electron 主进程
│   │   └── index.ts
│   ├── preload/                        # IPC 桥接 (contextBridge)
│   │   └── index.ts
│   ├── types/                          # 全局类型定义
│   └── renderer/                       # 渲染进程
│       └── src/
│           ├── pages/                  # 页面模块
│           │   ├── GeneratePage.ts     # 图片生成
│           │   ├── BatchPage.ts        # 批量生成
│           │   ├── ComparePage.ts      # 模型对比
│           │   ├── HistoryPage.ts      # 历史记录
│           │   ├── UnderstandPage.ts   # 图像理解
│           │   └── PromptTemplates.ts  # 提示词模板
│           ├── services/               # 服务层
│           │   ├── pipeline/           # Director 流水线
│           │   │   ├── DirectorPipeline.ts
│           │   │   ├── BasePipeline.ts
│           │   │   └── director-skills.ts
│           │   ├── storyboard-pipeline/ # StoryboardPro
│           │   ├── api/                # API 调用
│           │   ├── r2-storage/         # R2 云存储
│           │   ├── cache/              # 图片缓存
│           │   ├── storage/            # 本地存储
│           │   ├── i18n/               # 国际化
│           │   ├── version-checker/    # 版本检查
│           │   ├── LangChainDirectorService.ts
│           │   ├── LangChainStoryboardService.ts
│           │   └── ServiceBridge.ts    # 服务总线
│           ├── features/               # 功能模块 (18+)
│           │   ├── model-selector/     # 模型选择器
│           │   ├── tab-manager/        # 标签管理
│           │   ├── history/            # 历史数据
│           │   ├── settings/           # 设置面板
│           │   ├── image-viewer/       # 图片查看器
│           │   ├── intelligent-resize/ # 智能缩放
│           │   ├── keyboard/           # 快捷键
│           │   ├── language/           # 语言切换
│           │   ├── updater/            # 自动更新
│           │   └── ...
│           ├── core/                   # 核心模块
│           │   ├── AppBootstrap.ts     # 应用引导
│           │   ├── Router.ts           # SPA 路由
│           │   ├── EventBus.ts         # 事件总线
│           │   ├── VirtualScroller.ts  # 虚拟滚动
│           │   └── RetryManager.ts     # 重试管理
│           ├── utils/                  # 工具函数
│           └── styles/                 # 样式
│
├── electron/                           # Electron 入口文件
│   ├── main.js
│   └── preload.js
│
├── skills/                             # Skills 定义 (19 个)
│   ├── director-*/                    # Director 流水线 Skill (12 个)
│   │   ├── director-anchor-extraction-quality
│   │   ├── director-anime-quality-boost
│   │   ├── director-character-consistency
│   │   ├── director-cinematic-composition
│   │   ├── director-lighting-continuity
│   │   ├── director-narrative-flow
│   │   ├── director-prompt-engineering
│   │   ├── director-scene-analysis-depth
│   │   ├── director-shot-sequence-patterns
│   │   ├── director-structured-captioning
│   │   ├── director-style-consistency
│   │   └── director-visual-continuity
│   └── storyboard-*/                  # StoryboardPro Skill (7 个)
│       ├── storyboard-audio
│       ├── storyboard-dialogue
│       ├── storyboard-dodge
│       ├── storyboard-physics
│       ├── storyboard-structure
│       ├── storyboard-style
│       └── storyboard-visual
│
├── .agents/skills/                     # Deep Agents 元数据
│   ├── deep-agents-core/
│   ├── deep-agents-memory/
│   └── deep-agents-orchestration/
│
├── docs/                               # 项目文档
│   └── plans/                         # 功能实现计划 (100+)
├── tests/                              # 单元测试 (Vitest)
├── e2e/                                # E2E 测试 (Playwright)
├── i18n/                               # 翻译资源
├── images/                             # 参考素材
└── config/                             # 构建配置
```

## Director 流水线

LangGraph 驱动的 4-pass 多阶段图片生成流水线:

```
Pass 1: 技能选择 + 场景分析
    → 从 19 个 Skill 中选择最匹配的
    → 深度场景理解 (角色/环境/氛围)

Pass 2: 角色锚点提取
    → 角色一致性保证
    → 关键特征锚定

Pass 3: 设计组装
    → 结构化 prompt 生成
    → 风格/构图/光影参数

Pass 4: 一致性校验
    → 跨镜头角色一致
    → 视觉连续性检查
```

### Director Skill 列表

| Skill | 描述 |
|-------|------|
| `anchor-extraction-quality` | 角色锚点提取优化 |
| `anime-quality-boost` | 动画画质增强 |
| `character-consistency` | 角色一致性保证 |
| `cinematic-composition` | 电影构图 |
| `lighting-continuity` | 光影连续性 |
| `narrative-flow` | 叙事流畅性 |
| `prompt-engineering` | 提示词工程 |
| `scene-analysis-depth` | 场景深度分析 |
| `shot-sequence-patterns` | 镜头序列模式 |
| `structured-captioning` | 结构化描述 |
| `style-consistency` | 风格一致性 |
| `visual-continuity` | 视觉连续性 |

## StoryboardPro 风格模板

| 模板 | 说明 | 特点 |
|------|------|------|
| `theatrical` | 剧场版动画 | 日式权重标记 `((style:1.5))` |
| `cinematic` | 电影级九宫格 | 分形几何，角色一致性 |
| `anime` | 动画截图 | 赛璐璐着色 |
| `manga` | 漫画分镜 | 黑白墨线，网点 |
| `movie` | 电影分镜 | 宽银幕，戏剧光影 |
| `webtoon` | 韩漫/条漫 | 全彩，纵向排版 |

## Skills 系统

### 加载策略

```
最终 Skill 集 = 内置 skills/ + 用户 userData/skills/
同名冲突: 用户 Skill 覆盖内置
格式异常: 跳过不中断
运行时热加载: 渲染进程手动刷新生效
```

### 用户自定义 Skill

打包后用户可在 `app.getPath('userData')/skills/<skill-name>/SKILL.md` 添加自定义 Skill，刷新后即时生效。

## 技术栈

| 分类 | 技术 |
|------|------|
| 框架 | Electron 35 |
| 构建 | Vite 6 + electron-vite |
| 语言 | TypeScript 5.7 |
| 样式 | Tailwind CSS 4 |
| AI | LangChain + LangGraph |
| 存储 | Cloudflare R2 |
| 测试 | Vitest + Playwright |
| 国际化 | 4 语言 (zh-CN/zh-TW/en/ru) |

## Codex 页 DeepSeek (Miau) 通道:选择器次序与记忆模型

2026-10-30 调整(`src/shared/modelSettings.ts`、`src/main/agent/gatewayModelRouting.ts`):

- **选择器次序**:DeepSeek 组按 `火山 V4.1 Flash` → `火山 V4.1 Flash 经济版` → `DeepSeek V4 Pro` → `DeepSeek Flash` 排列(火山在前,官方在后,`v4-pro` 先于 `flash`)。次序以 `CANONICAL_MODEL_SETTINGS_ROWS` 为准;通道默认模型仍是 `deepseek-flash`。
- **记忆模型**(`memories.extract_model` / `consolidation_model`)与会话自动起标题的模型:四个 DeepSeek 模型(火山两个 + 官方两个)**一律走火山标准版 `deepseek-v4-1-flash-261017`**(原为 `deepseek-flash`),在通道的 `memoriesModel` 里写一个固定值。
  - 为什么是一个值而不是按对话模型分路:记忆模型是启动 Codex 时写死的 `-c` 参数,而同一通道内切换模型不会重启 Codex,分路会让它停在启动那一刻的值上(切换后过期)。一个值就没有这个问题,也不需要映射表。
  - 通道默认对话模型不变,仍是 `deepseek-flash`。
- **代价**:官方两个模型的用户也按火山标准版计费;同一时段它的单价是 `deepseek-flash` 的 6.7 倍(输入 ¥1 对 ¥0.15、输出 ¥4 对 ¥0.6,每百万 token,缓存命中的输入另有折扣)。**2026-10-30 按网关扣费日志实测(不是价格表推算)**:一次记忆提取(阶段 1,约 5 万输入 / 4 千输出 token)≈ ¥0.07;一次记忆合并(阶段 2,23 次请求、约 99 万输入 token 其中 97% 命中缓存、1.6 万输出)≈ ¥0.22;一次完整整理合计约 ¥0.3。按 6.7 倍推算,同样的工作用 `deepseek-flash` 约 ¥0.045(推算值,没有实测)。**此前文档里写的「单次记忆请求约 ¥0.0005 对 ¥0.00007、绝对值很小」是只按一条很小的请求估的,低估了阶段 2,以本条为准**。这些费用会出现在用量明细里;合并只在有新的提取结果时才跑,频率取决于用户开新会话的节奏。
- **已验证(2026-10-30,对生产 Miau 网关,真实内置 Codex + 本机转发代理)**:`memories.extract_model` / `consolidation_model` = `deepseek-v4-1-flash-261017`,聊天模型 `deepseek-flash`。① 阶段 1(提取):`/v1/responses`、`stream=true`、`text.format=json_schema`、`reasoning.effort=low`、0 个工具,HTTP 200,返回合法结构化结果,`stage1_outputs` 落库、任务 `done`;② 阶段 2(合并):合并 agent 用同一个模型(`effort=medium`、9 个工具)连续 24 次请求,**全部 HTTP 200**,任务 `done`(耗时约 130 秒),写出 `MEMORY.md`(6.9 KB)、`memory_summary.md`(4.1 KB)、`raw_memories.md`(5.6 KB)、1 份 rollout 摘要和 1 个自动生成的技能,agent 最后一句是 "Phase 2 complete"。聊天轮(`deepseek-flash`)与记忆请求(火山标准版)走的是两个不同的模型,互不影响。
- **没有覆盖到的**:① 只用一个很小的会话做样本(1 份 rollout、从空记忆库起步的 INIT 合并),没有测多份 rollout 的增量合并,也没有评估合并产出的质量(只确认写完了文件、任务状态 `done`);② 有一次运行里阶段 1 请求撞上一次瞬时 `fetch failed`(5 秒,本机到网关),Codex 自动重试后成功,没有查网络层原因;③ 验证脚本曾在第一个 Codex 被强杀后留下一条「合并任务 running、租约 1 小时」的记录,第二个进程 10 分钟内没有接手(清掉这条记录后正常跑完)——正常退出不会留下这条记录,但**用户强杀应用后的下一次启动是否同样 1 小时内合并不了,没有单独验证**。

## apiyi (Gemini) MCP 已从应用移除(2026-10-30)

桌面端不再内置、不再启动 apiyi 的 Gemini MCP(`apiyi-mcp-server`)。**API易作为 Codex 网关 / 出图站点(provider id `apiyi`、`APIYI_PRESET`、设置里的「API易」key)不受影响。**

- **原因**:这条 MCP 早已对 agent 隐藏(`APIYI_MCP_EXPOSED=false`),能力与千问 omni 的 `understand_*` 工具重复;而它的休眠写法 `-c mcp_servers.apiyi.enabled=false` 在配置里没有 `[mcp_servers.apiyi]` 表时会凭空造出一张没有 transport 的表,Codex 直接以 `invalid transport in mcp_servers.apiyi` 起不来(例如全新的 `CODEX_HOME`)。
- **主进程**:`codexLaunch.ts` 不再发任何 `mcp_servers.apiyi.*` / `apiyi` direct_only 项,`buildCodexLaunchArgs` 去掉 `apiyiKey` 选项;`AgentManager` / `CodexLocalBackend` / `codexProviders` 去掉 apiyi 密钥桥(`APIYI_MCP_PROVIDER_ID`);删除 `apiyiMcpLauncher.ts`、`apiyiMcpSeed.ts` 及其测试;启动时不再往 `~/.codex/config.toml` 写 `[mcp_servers.apiyi]`。`whichNode` / `resolveStdioNodeCommand`(「系统 node,否则 Electron-as-Node」)抽到 `src/main/agent/stdioNodeCommand.ts`,catimation 桥与运镜知识库共用。
- **老用户配置自动清理**:`src/main/agent/legacyApiyiMcpCleanup.ts` 在 Codex 启动前,只在 `mcp_servers.apiyi` 的 `args[0]` 指向应用自带路径(以 `/apiyi-mcp/dist/index.js` 结尾)时删掉这一条;用户自己写的同名条目保留、TOML 解析失败不改写、没有可删内容不写盘、幂等。结果写日志 `[apiyi-mcp] legacy entry cleanup: removed|kept-user-entry|malformed`。
- **渲染层**:去掉 `ApiService.syncApiyiKeyToMcp`(构造器 / 保存 key / MCP 页冷启动三处调用)与 `APIYI_MCP_PROVIDER_ID`;MCP 页「预装」分组机制保留,`APP_BUNDLED_MCP_NAMES` 现为空集;「已连接但无工具」提示去掉 apiyi 专属分支(只剩 Docker / 通用两条)。
- **打包**:`electron-builder.yml` 去掉 `resources/apiyi-mcp` 两段 `extraResources`,`package.json` 去掉 `vendor:apiyi-mcp*` 脚本与 `build:vite` 里的前置 vendor 步骤,`.gitignore` 去掉对应条目,删除 `scripts/vendor-apiyi-mcp.mjs` / `.lock.json`。评测 harness 与 12 个冒烟 / 诊断脚本里写 `[mcp_servers.apiyi]` 惰性占位的代码一并去掉(运镜知识库那条保留)。
- **技能**:`catimation-understand` 的「apiyi-mcp(Gemini)只作深度复核的备选」整节与 frontmatter 里的对应句子删除(已 `pnpm skills:gen`)。
- **没有动的**:`deploy/apiyi-fastmcp`(自己服务器上跑的 BYOK 版,见上面「远程 apiyi 网关」一节)、用户 `~/.cursor/mcp.json` 里 Cursor 自己的 `apiyi` / `apiyi-remote`、已持久化在 provider store 里的 `apiKeys["apiyi-mcp"]`(不再被读取,是 API易 key 的一份重复拷贝)。
- **测试**:新增 `legacyApiyiMcpCleanup.test.ts`(8 条)、`stdioNodeCommand.test.ts`、`codexLaunch.test.ts` 里「apiyi MCP 已移除」3 条、`McpServerCard.test.tsx` 里 docker / 通用空工具提示 2 条。

## 许可证

MIT License
