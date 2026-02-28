# LangChain 结构化分镜输出 — 图像理解页面 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 复用导演模式的 LangChain 技术栈，为图像理解页面的 Sora分镜角色提供 Zod schema 结构化输出，确保台词嵌入、动机绑定、声画对位、特效/动作分离。

**Architecture:** 新建 `LangChainStoryboardService`，定义演出导向的 Zod schema（含 `lines`/`motive`/`act`/`fx` 字段），复用 `LangChainDirectorService` 的 LLM 初始化和图片处理逻辑。UnderstandPage 在检测到 `sora-storyboard` 角色时，走 LangChain 结构化输出路径替代纯文本流式 API。

**Tech Stack:** LangChain.js (@langchain/core, @langchain/openai, @langchain/google), Zod 4, TypeScript

---

## 架构概览

```
UnderstandPage.ts
  ├─ 普通角色 → ApiService.analyzeImagesStream() (现有流式路径)
  └─ sora-storyboard 角色 → LangChainStoryboardService.analyze()
       ├─ Zod schema 约束输出格式
       ├─ 台词嵌入 seq.S[n]
       ├─ 道具动机 objs[].motive
       ├─ 特效/动作分离 objs[].act + objs[].fx
       └─ 声画对位 scene.bgm (绑定 S 编号)
```

## Zod Schema 设计（演出导向）

```typescript
const StoryboardObjSchema = z.object({
  n: z.string().describe('角色/物体名'),
  f: z.string().describe('外观特征→心理动机映射'),
  s: z.string().describe('空间位置: fg/mg/bg + 位置'),
  p: z.string().describe('物理类型: rigid/artic/fluid/cloth'),
  t: z.string().describe('跨镜头一致性锚点'),
  tc: z.string().describe('镜头衔接: 姿态/运动向量/视线延续'),
  act: z.string().describe('演出动作（纯动作，不含特效）'),
  fx: z.nullable(z.string()).describe('特效: 风/烟/光/粒子，与 act 时间对齐'),
  motive: z.string().describe('动机: 这个动作/道具外化了什么心理'),
  a: z.string().describe('多粒度: 粗(构图)→中(动作链)→细(遮挡)'),
  m: z.record(z.string(), z.string()).describe('运动强度: 部位→角度/位移/H-M-L')
})

// Zod 4: z.record() 必须传两个参数 (key schema, value schema)
const StoryboardSeqSchema = z.record(
  z.string(),
  z.string().describe('S[n]: 景别|动作|台词精华|心理→外化|运镜')
)

const StoryboardTimelineEntrySchema = z.object({
  t: z.string().describe('时间范围'),
  dur: z.string().describe('持续时长'),
  tempo: z.string().describe('节奏: slow/accelerating/urgent/sudden-stop'),
  trans: z.string().describe('转场: cut/match-cut/whip-pan/smash-cut')
})

const StoryboardSceneSchema = z.object({
  d: z.string().describe('叙事弧线: A→B→C'),
  cap: z.string().describe('结构化标题: 主体-动作-环境'),
  env: z.string().describe('环境: 光照/空间/风格'),
  bgm: z.string().describe('4层声画对位: 层1(绑定S?)|层2(绑定S?)|层3|层4'),
  timeline: z.record(z.string(), StoryboardTimelineEntrySchema)
})

const StoryboardResponseSchema = z.object({
  scene: StoryboardSceneSchema,
  objs: z.array(StoryboardObjSchema),
  seq: StoryboardSeqSchema,
  cont: z.record(z.string(), z.string()).describe('跨镜头连续性锚点'),
  notes: z.string().describe('验证总结 + 节奏呼吸曲线')
})
```

---

### Task 1: 创建 LangChainStoryboardService

**Files:**
- Create: `src/renderer/src/services/LangChainStoryboardService.ts`

**Step 1: 创建服务文件，定义 Zod schema + Service 类**

完整代码见上方 schema 设计。Service 类复用 LLM 初始化逻辑（Gemini 自动检测），暴露 `analyze(images, rolePrompt, context?)` 方法。

**Step 2: 验证 TypeScript 编译**

Run: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit src/renderer/src/services/LangChainStoryboardService.ts`

**Step 3: Commit**

```bash
git add src/renderer/src/services/LangChainStoryboardService.ts
git commit -m "feat: add LangChainStoryboardService with performance-oriented Zod schema"
```

---

### Task 2: 在 ServiceBridge 中注册服务

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts`

**Step 1: 添加 import 和懒加载 getter**

在 ServiceBridge 中添加 `getLangChainStoryboardService()` 函数，类似现有的 `getLangChainDirectorService()`。

**Step 2: Commit**

---

### Task 3: UnderstandPage 集成 LangChain 路径

**Files:**
- Modify: `src/renderer/src/pages/UnderstandPage.ts`

**Step 1: 在 `analyzeImages()` 中检测 sora-storyboard 角色**

当 `this.currentRole === 'sora-storyboard'` 时，调用 LangChain 结构化输出路径，将结果 JSON.stringify 后显示在结果区域。

**Step 2: 回退机制**

如果 LangChain 调用失败（API 不支持 structured output），自动回退到现有的流式文本路径。

**Step 3: Commit**

---

### Task 4: 构建验证

**Step 1: Build**

Run: `npm run build:vite`

**Step 2: 运行时验证**

1. 打开图像理解 → 选 Sora分镜 角色
2. 上传图片 + 输入剧本
3. 确认输出包含 `act`/`fx`/`motive`/台词嵌入
4. 切换到其他角色 → 确认仍走流式路径

**Step 3: Commit**

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 新建 Service vs 复用 DirectorService | 新建 | Schema 完全不同（演出导向 vs 生成导向） |
| LLM 初始化 | 复用相同逻辑 | 同样的 Gemini/OpenAI 自动检测 |
| 失败回退 | 回退到流式文本 | 不是所有 API 都支持 structured output |
| 字符限制 | 不需要 | LangChain structured output 由 schema 控制，不靠字符限制 |
