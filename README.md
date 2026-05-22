# AI Image Master

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

完整方案见 [`deploy/README.md`](./deploy/README.md) —— 包含 Docker Compose、EdgeOne 配置、
客户端 JSON 配置示例(支持 Cursor / Codex / Claude Desktop)。一行命令部署:

```bash
cd deploy && docker compose up -d --build
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

## 许可证

MIT License
