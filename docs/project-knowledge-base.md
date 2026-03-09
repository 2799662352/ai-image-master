# AI Image Master v3.1.0 — 项目知识库

> 本文档为 AI Image Master 项目的完整知识地图，覆盖架构设计、核心功能、数据流、关键文件索引和版本历史。
> 适用于新成员 onboarding、AI 辅助开发上下文注入、代码审查参考。

---

## 1. 项目概览

| 维度 | 内容 |
|------|------|
| 名称 | CATIMATION-Cyberpunk Master / AI Image Master |
| 版本 | v3.1.0 |
| 许可 | MIT |
| 仓库 | https://github.com/2799662352/ai-image-master |
| 定位 | 基于 AI 的图片生成/理解桌面应用 |

### 核心能力

1. **文生图** — 文字描述生成图片，支持多模型（Gemini、Seedream、Flux Kontext 等）
2. **导演模式** — 从参考图自动生成电影级分镜漫画（LangGraph 6-Pass 管线）
3. **图像理解** — AI 多模态识图分析（流式输出 + 角色预设）
4. **批量生成** — 批量文生图
5. **模型对比** — 多模型生成结果对比
6. **历史记录** — 生成历史持久化管理

---

## 2. 技术栈

```
┌─────────────────────────────────────────────────────┐
│ Desktop: Electron 28                                │
│ Build:   Vite 7 + electron-vite 5                   │
│ Lang:    TypeScript 5.9 (strict)                     │
│ UI:      React 19 + Tailwind CSS 3.4                │
│ State:   Zustand 5                                   │
│ AI:      @langchain/core + @langchain/langgraph     │
│          @langchain/openai + @langchain/google       │
│ Storage: Cloudflare R2                               │
│ Test:    Vitest 4 + Playwright 1.58                  │
│ Trace:   Langfuse (生产环境可观测性)                   │
└─────────────────────────────────────────────────────┘
```

---

## 3. 项目结构

```
temp-ai-image-master-source/
├── src/
│   ├── main/                          # Electron 主进程
│   │   └── index.ts                   # 窗口、IPC、文件系统、自动更新
│   ├── preload/                       # 预加载脚本
│   │   └── index.ts                   # contextBridge 暴露安全 API
│   ├── renderer/                      # 渲染进程 (React 前端)
│   │   ├── index.html                 # HTML 入口
│   │   ├── public/                    # 静态资源
│   │   │   ├── data/                  # 配置 JSON
│   │   │   │   ├── vision-models.json # 图像理解模型配置
│   │   │   │   ├── understand-roles.json # 分析角色配置
│   │   │   │   └── prompts/           # 提示词模板
│   │   │   ├── i18n/                  # 多语言文案
│   │   │   └── css/                   # 样式
│   │   └── src/
│   │       ├── main.ts                # 渲染进程入口
│   │       ├── core/                  # 核心模块
│   │       │   ├── AppBootstrap.ts    # 应用引导
│   │       │   └── VirtualScroller.ts # 虚拟滚动
│   │       ├── pages/                 # 页面
│   │       │   ├── BasePage.ts        # 页面基类
│   │       │   ├── GeneratePage.ts    # 文生图
│   │       │   ├── BatchPage.ts       # 批量生成
│   │       │   ├── ComparePage.ts     # 模型对比
│   │       │   ├── HistoryPage.ts     # 历史记录
│   │       │   └── UnderstandPage.ts  # 图像理解 (~1657行)
│   │       ├── services/              # 服务层
│   │       │   ├── ServiceBridge.ts   # 工厂函数暴露到 window
│   │       │   ├── PageStateManager.ts# 页面状态持久化
│   │       │   ├── LangChainDirectorService.ts
│   │       │   ├── LangChainStoryboardService.ts
│   │       │   ├── StoryboardToDirectorAdapter.ts
│   │       │   ├── api/               # API 服务
│   │       │   │   ├── ApiService.ts  # 图片生成 + 流式分析
│   │       │   │   └── GeminiErrorHandler.ts
│   │       │   ├── pipeline/          # 导演管线 ★
│   │       │   │   ├── BasePipeline.ts
│   │       │   │   ├── DirectorPipeline.ts  # 核心 (~1770行)
│   │       │   │   ├── director-skills.ts
│   │       │   │   ├── prompt-loader.ts
│   │       │   │   ├── types.ts
│   │       │   │   ├── schemas/
│   │       │   │   │   ├── director-schemas.ts
│   │       │   │   │   └── style-anchor-schema.ts
│   │       │   │   └── __tests__/     # 20+ 单元测试
│   │       │   ├── storyboard-pipeline/ # 故事板管线
│   │       │   │   ├── StoryboardProPipeline.ts
│   │       │   │   ├── StoryboardPipelineService.ts
│   │       │   │   └── ...
│   │       │   ├── r2-storage/        # R2 云存储
│   │       │   │   └── R2StorageService.ts
│   │       │   └── cache/             # 图片缓存
│   │       │       └── ImageCacheService.ts
│   │       └── features/              # 功能模块
│   │           ├── tab-manager/       # Tab 路由
│   │           ├── model-selector/    # 模型选择
│   │           ├── settings/          # 设置
│   │           ├── history/           # 历史
│   │           └── image-viewer/      # 图片预览
│   └── types/                         # 全局类型
├── skills/                            # 内置 AI Skills
│   ├── director-*/SKILL.md           # 11 个导演 skills
│   └── storyboard-*/SKILL.md        # 7 个故事板 skills
├── tests/                             # 单元测试
├── e2e/                               # E2E 测试
├── docs/                              # 文档
│   └── plans/                         # 开发计划
├── config/                            # 配置
├── build/                             # 构建资源
└── package.json                       # v3.1.0
```

---

## 4. 导演模式 (Director Pipeline) — 深入解析

### 4.1 管线架构

基于 **LangGraph StateGraph** 构建，采用 **Evaluator-Optimizer** 设计模式。

```
                              ┌────────────────────────┐
                              │     START              │
                              └──────────┬─────────────┘
                                         │
                              ┌──────────▼─────────────┐
                              │  Pass 0: selectSkills   │
                              │  (LLM 选择适用 skills)  │
                              └──┬────┬────┬───────────┘
                     ┌───────────┘    │    └───────────┐
                     ▼                ▼                ▼
          ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
          │Pass 1: 场景分析│ │Pass 2: 角色锚点│ │Pass 3: 风格锚点│
          │(analyzeScene) │ │(extractChars) │ │(extractStyle)│
          └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
                 │                │                │
                 └───────┬────────┘                │
                         └──────────┬──────────────┘
                                    │
                         ┌──────────▼─────────────┐
                         │   validateAnalysis      │
                         │   (3-way fan-in)        │
                         └───┬──────┬─────────┬───┘
                     continue│   retry│      abort│
                             ▼       ▼           ▼
               ┌─────────────────┐ ┌───┐    ┌──────┐
               │Pass 4: 分镜设计  │ │重试│    │ 终止 │
               │(designAssemble) │ │分析│    │      │
               │ 3级错误恢复     │ └───┘    └──────┘
               └────────┬────────┘
                        │
            ┌───────────┴───────────┐
            │ skipVerify?           │
         yes▼                   no ▼
   ┌────────────┐        ┌────────────────┐
   │Pass 6: 生图 │        │Pass 5: 一致性校验│
   └────────────┘        │(Evaluator)     │
                         └───────┬────────┘
                          score < threshold?
                      ┌───yes──┘  └──no───┐
                      ▼                   ▼
               ┌────────────┐      ┌────────────┐
               │ 回到 Pass 4 │      │Pass 6: 生图 │
               │(增量修正)   │      │(Contact Sheet)│
               └────────────┘      └────────────┘
```

### 4.2 状态 Schema

```typescript
{
  scene: SceneAnalysis | null          // Pass 1 输出
  characters: CharacterAnchors | null   // Pass 2 输出
  styleAnchor: StyleAnchor | null       // Pass 3 输出
  panels: Panel[] | null                // Pass 4 输出
  prompts: AssembledPrompt[] | null     // Pass 4 输出
  report: VerifyReport | null           // Pass 5 输出
  images: GeneratedImage[] | null       // Pass 6 输出
  
  // 输入参数
  inputImages: { data: string; mimeType: string }[]
  sceneDescription: string
  layout: { rows: number; cols: number; panelCount: number }
  template: string
  styleInstructions: string
  ratio: string                         // "3:2", "16:9", etc.
  resolution: string                    // "2K"
  imageModel: string
  
  // 控制参数
  skipVerify: boolean
  skipAnalyzeScene: boolean
  skipCharacterAnchors: boolean
  scoreThreshold: number                // 默认 6
  activeSkills: string[]
  retryCount: number                    // 当前重试次数
  retryFeedback: string                 // Evaluator 反馈
  visionDetail*: 'low' | 'high' | 'auto' // 每个 Pass 独立配置
}
```

### 4.3 关键设计决策

**Character Identity Lock**
```
## Character Identity Lock
- [char1] 角色名 (she): 面部特征、发型、服装描述
- [char2] 角色名 (he): 面部特征、发型、服装描述
Identity continuity is mandatory across all panels.
```

**Style Authority Chain**
```
1. USER EXPLICIT STYLE (Priority 1 — NON-NEGOTIABLE): 用户选择的模板
2. STYLE ANCHOR (from reference image): medium, palette, lighting, texture
3. CONFLICTS RESOLVED: 用户选择优先
```

**3 级错误恢复 (Pass 4)**
```
L1: withStructuredOutput(includeRaw) + regex 提取 → 0 额外 LLM 调用
L2: SimplePanelSchema (简化 schema) → +1 LLM 调用
L3: 错误信息反馈给 LLM 自修正 → +1 LLM 调用
```

**Narrative Rhythm Guardrails**
```
- 身份锚点（脸、发型、服装、配色、武器）优先保持一致
- 叙事方向以用户简报为主线
- 导演可自主决定镜头、构图、光影、调度与节奏
- 允许角色/场景随叙事推进合理演进
```

### 4.4 Skill 系统

11 个内置 Director Skills:

| Skill | 用途 |
|-------|------|
| director-prompt-engineering | 提示词工程最佳实践 |
| director-character-consistency | 角色一致性规则 |
| director-cinematic-composition | 电影构图技巧 |
| director-lighting-continuity | 光影连续性 |
| director-narrative-flow | 叙事流畅度 |
| director-scene-analysis-depth | 场景分析深度 |
| director-shot-sequence-patterns | 镜头序列模式 |
| director-structured-captioning | 结构化描述 |
| director-style-consistency | 风格一致性 |
| director-visual-continuity | 视觉连续性 |
| director-anchor-extraction-quality | 锚点提取质量 |

运行时由 LLM 在 Pass 0 (selectSkills) 自动选择适用的 skills。

---

## 5. 图像理解模式 (UnderstandPage) — 深入解析

### 5.1 三条分析路径

```
用户点击「开始分析」
        │
        ├─ currentRole === 'sora-storyboard-pro'
        │    └─→ getStoryboardPipelineService() → 4-Pass 管线
        │         └─→ formatStoryboardText → showStoryboardResult
        │              └─→ 支持 格式化文本 / JSON 切换
        │              └─→ 一键导入导演模式
        │
        ├─ currentRole === 'sora-storyboard'
        │    └─→ getLangChainStoryboardService() → 结构化输出
        │         └─→ toJSON → appendResultChunk
        │              └─→ 一键导入导演模式
        │
        └─ 其他角色 (universal, product-title, ocr-extract, ...)
             └─→ api.analyzeImagesStream() → 流式 SSE
                  └─→ onChunk → 实时追加显示
                  └─→ onComplete → 完成
```

### 5.2 Vision 模型

| 模型 ID | 名称 | 特点 |
|---------|------|------|
| gpt-5.2 | GPT-5.2 | 旗舰理解推理 |
| gemini-3-pro-preview | Gemini 3 Pro | Google 多模态 |
| gemini-3-flash-preview | Gemini 3 Flash | 轻量高速 (默认) |
| gpt-5-mini | GPT-5-mini | 轻量版 |
| claude-haiku-4-5 | Claude Haiku 4.5 | Anthropic 轻量 |
| qwen-vl-ocr-latest | Qwen OCR | 阿里云 OCR |

### 5.3 与导演模式的桥梁

```typescript
// StoryboardToDirectorAdapter.ts
const importData = convertStoryboardToDirector(
  storyboardResult,     // 分镜反推结果
  referenceImageBase64, // 参考图
  mimeType
)
sessionStorage.setItem('director_import_data', JSON.stringify(importData))
app.switchTab('director')
```

---

## 6. 服务层架构

```
ServiceBridge.ts (window 暴露)
    ├── createUnderstandPageTS → UnderstandPage 工厂
    ├── getStoryboardPipelineService → StoryboardPipelineService
    ├── getLangChainStoryboardService → LangChainStoryboardService
    └── aiImageAPI → ApiService 实例

ApiService.ts
    ├── generateImage()           → 调用图片生成 API
    ├── analyzeImagesStream()     → 流式 Vision API 分析
    └── GeminiErrorHandler        → Gemini 特定错误处理

R2StorageService.ts (v3.1.0 重构)
    └── Cloudflare R2 图片云存储

PageStateManager.ts
    └── 页面状态持久化 (切换 Tab 时保存/恢复)
```

---

## 7. v3.1.0 发布记录

### 完整变更（从 v3.0.0 起）

| Commit | 类型 | 内容 |
|--------|------|------|
| a7ab5f1 | bugfix | P1+P4 safety: catch 清空 retryFeedback + MAX_RETRIES 防御 |
| 07daae2 | test | shouldRetryAnalysis 路由测试 (+5 tests) |
| 0447f7f | bugfix | **修复 3-way fan-in retry hang** → individual edges |
| bcef842 | test | totalPasses 计算验证测试 (+2 tests) |
| 033280d | bugfix | stream 前发射 onProgress 修复 UI 步骤数 |
| 675777a | refactor | **R2Storage 从 window global 迁移到 service pattern** |
| 7636f01 | release | version bump to 3.1.0 |
| 8761b6a | docs | 4 个实施计划文档 |

### 统计

- **2 个关键 pipeline bug 修复**: fan-in hang + UI 步骤数
- **1 个架构改进**: R2Storage 迁移
- **7 个新测试**, 全部 **175 tests 通过**
- commit 历史清晰有序，每个 commit 单一职责

---

## 8. 知识图谱记忆

本项目的结构化知识已写入 **MCP Knowledge Graph** (user-mcp-docker)。

### 实体清单

| 实体名 | 类型 | 说明 |
|--------|------|------|
| ai-image-master | Project | 项目主实体 |
| director-pipeline | Feature | 导演管线 |
| understand-page | Feature | 图像理解 |
| storyboard-pipeline | Feature | 故事板管线 |
| director-skill-system | Feature | Skill 系统 |
| director-pass-0~6 | PipelineStage | 管线各阶段 |
| director-graph-topology | Architecture | 图拓扑 |
| api-service | Service | API 服务 |
| r2-storage-service | Service | R2 存储 |
| langchain-services | Service | LangChain 服务 |
| v3.1.0-release | Release | 版本发布 |

### 关系清单

```
ai-image-master ──contains_feature──→ director-pipeline
ai-image-master ──contains_feature──→ understand-page
ai-image-master ──contains_feature──→ storyboard-pipeline
director-pipeline ──contains_stage──→ director-pass-0~6
director-pipeline ──uses_skills──→ director-skill-system
director-pass-5 ──retry_loops_to──→ director-pass-4
understand-page ──exports_to_via_adapter──→ director-pipeline
understand-page ──calls_for_storyboard_pro──→ storyboard-pipeline
v3.1.0-release ──fixes_fan_in_hang──→ director-pipeline
```

### 查询方式

```bash
# 在 MCP 工具中使用:
search_nodes({ query: "director" })
open_nodes({ names: ["ai-image-master", "director-pipeline"] })
read_graph({})
```

---

## 9. 开发参考

### 常用命令

```bash
npm run dev              # 开发模式 (electron-vite)
npm run test:run         # 运行所有测试
npm run test:coverage    # 覆盖率报告
npm run test:ui          # Vitest UI
npm run build:win        # Windows 打包
npm run pipeline:test    # Pipeline 测试
npm run analyze          # Bundle 分析
npm run perf:startup     # 启动性能测量
```

### 调试技巧

1. **管线调试**: `DirectorPipeline.ts` 中每个 Pass 都有 `console.log`/`console.warn` 输出
2. **Langfuse 追踪**: 生产环境设置 `VITE_LANGFUSE_SECRET_KEY` + `VITE_LANGFUSE_PUBLIC_KEY`
3. **Vision Detail**: 通过 `visionDetail*` 参数控制每个 Pass 的图片精度
4. **测试隔离**: `__tests__/setup.ts` 中 mock 了 LLM 调用

### 添加新 Skill

1. 在 `skills/` 下创建 `director-<name>/SKILL.md`
2. `SKILL.md` 中定义规则，会被 `prompt-loader.ts` 加载
3. 在 `director-skills.ts` 中注册到 `sharedSkills`
4. 或作为 runtime skill 通过 `getDirectorSkillsFromConfig()` 加载

### 添加新 Vision 角色

1. 编辑 `src/renderer/public/data/understand-roles.json`
2. 添加 `{ id, name, icon, prompt, defaultModel?, promptFile?, contextPlaceholder? }`
3. 如需外部提示词，创建文件并在 `promptFile` 中引用
