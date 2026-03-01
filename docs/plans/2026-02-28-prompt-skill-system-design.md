# Prompt Skill System Design

**Date:** 2026-02-28
**Goal:** 将 StoryboardPipeline 的硬编码规则重构为可组合的 PromptSkill 模块系统，同时创建外部 AI Skill 封装 prompt 工程经验。
**Architecture:** Prompt 层模块化 + State 层参考帧注入，不改 graph 拓扑。

---

## 背景

当前 `StoryboardPipelineService.ts` 中的 `hardRules` 是一个包含 17 条规则的大字符串，在所有 4 个 Pass 的 system prompt 中原样注入。问题：

1. 每个 Pass 收到了不相关的规则（如 scene Pass 收到了 dialogue 规则）
2. 重试时没有连续性锁定机制，模型可能"遗忘"上一轮已通过的镜头
3. 无法按场景需求动态开关规则（如关闭 dodge 规则）
4. prompt 工程经验没有被封装为可复用的 skill

## 技术栈验证

经 context7 获取以下文档并验证：

| 技术 | 文档来源 | 验证结论 |
|------|---------|---------|
| LangGraphJS StateGraph | `/langchain-ai/langgraphjs` | `Annotation.Root` + `reducer: (_, y) => y` 适合存储 previousShots |
| LangChain JS Prompt | `/websites/langchain_oss_javascript` | `SystemMessage(string)` 拼接即可，无需 ChatPromptTemplate |
| LangGraphJS 动态 prompt | `/langchain-ai/langgraphjs` docs/agents/context.md | `RunnableConfig.configurable` 适合运行时参数，但我们用闭包更简洁 |
| Agent Skills 规范 | agentskills.io/specification | name ≤64 chars, description ≤1024 chars, SKILL.md < 500 lines |
| Deep Agents Skills | docs.langchain.com/oss/javascript/deepagents/skills | Progressive disclosure: Match → Read → Execute |
| OpenSkills / Vercel Skills | `/numman-ali/openskills`, `/vercel-labs/skills` | SKILL.md + references/ + scripts/ + assets/ 结构 |

## Part 1：Pipeline PromptSkill 系统

### PromptSkill 接口

```typescript
type PassType = 'scene' | 'character' | 'shot' | 'verify'
type PipelineStateType = typeof PipelineState.State

interface PromptSkill {
  id: string
  rules: string | ((state: PipelineStateType) => string)
  appliesTo: PassType[]
  priority: number  // 越小越靠前
}
```

- `rules` 支持静态字符串或动态函数（continuity skill 需要 state 数据）
- `priority` 控制规则在 prompt 中的注入顺序
- 无 `name`/`enabled` 字段（YAGNI）

### 6 个内置 Skills

| id | rules 类型 | appliesTo | priority | 内容 |
|----|-----------|-----------|----------|------|
| `core` | 静态 | 全部 | 0 | 光影/镜头/Z轴/快照/微表情 (原 Rules 1-7) |
| `dialogue` | 静态 | shot, verify | 10 | 角色名+台词逐字提取 (原 Rules 8-9) |
| `physics` | 静态 | character, shot | 10 | 物理描述/运动向量/微表情量化 |
| `style` | 静态 | scene | 10 | 色彩层次/光源约束 |
| `dodge` | 静态 | 全部 | 20 | 过滤器绕过 D1-D8 |
| `continuity` | **动态函数** | shot | 30 | 重试时注入参考帧锁定 |

### buildRulesForPass 函数

```typescript
function buildRulesForPass(
  pass: PassType,
  skills: PromptSkill[],
  state?: PipelineStateType
): string {
  return skills
    .filter(s => s.appliesTo.includes(pass))
    .sort((a, b) => a.priority - b.priority)
    .map(s => typeof s.rules === 'function' ? s.rules(state!) : s.rules)
    .join('\n\n')
}
```

### Continuity Skill 动态规则生成

```typescript
function buildContinuityLock(state: PipelineStateType): string {
  if (!state.retryFeedback || !state.previousShots) return ''

  const shotSummary = state.previousShots
    .map(s => `${s.id}: ${s.desc}`)
    .join('\n')

  const anchors = state.characters
    ?.map(c => `[${c.n}] ${c.t}`)
    .join('; ') || ''

  return `CONTINUITY LOCK (严格遵守):
以下为上一轮生成的参考帧，本次仅修正被指出的问题，其余完全保持不变。
角色锚点锁定: ${anchors}

参考帧:
${shotSummary}

规则: 未被 retryFeedback 提及的镜头 → 原样保留，禁止修改。`
}
```

### State 新增字段

```typescript
previousShots: Annotation<Array<{ id: string; desc: string }> | null>({
  reducer: (_, y) => y,
  default: () => null,
})
```

精简版只保留 `{ id, desc }` 以控制 token 预算。

### prepareRetry 修改

```typescript
function prepareRetry(state: typeof PipelineState.State) {
  const feedback = state.report?.issues
    ?.map(i => `[${i.shotId}] ${i.field}: ${i.problem} → ${i.suggestion}`)
    .join('\n') || ''

  const previousShots = state.shots?.map(s => ({ id: s.id, desc: s.desc })) || null

  return {
    retryFeedback: feedback,
    retryCount: state.retryCount + 1,
    previousShots,
    shots: null,
    report: null
  }
}
```

### StoryboardPipelineService 构造函数

```typescript
constructor(config: PipelineConfig, skills?: PromptSkill[]) {
  // ... LLM init ...
  this.skills = skills || BUILTIN_SKILLS
}
```

## Part 2：外部 AI Skill

### 目录结构

```
.cursor/skills/storyboard-prompt-engineering/
├── SKILL.md
├── references/
│   ├── dodge-patterns.md
│   ├── continuity-lock.md
│   └── modular-rules.md
└── templates/
    └── prompt-skill-template.ts
```

### SKILL.md Frontmatter

```yaml
---
name: storyboard-prompt-engineering
description: >
  AI video storyboard prompt engineering toolkit for multi-pass LLM pipelines.
  Use when: optimizing prompts for video generation (Kling/Jimeng/Seedance),
  implementing filter bypass/dodge layers for sensitive content,
  adding continuity lock for cross-shot consistency in retries,
  modularizing prompt rules into composable PromptSkill modules,
  or building 4-pass storyboard pipelines with LangGraph.
  Triggers: "dodge layer", "filter bypass", "continuity lock",
  "prompt modular", "storyboard pipeline", "分镜提示词".
metadata:
  version: "1.0"
  author: tecx
---
```

### Skill 内容分工

| 文件 | 内容 | 何时加载 |
|------|------|---------|
| SKILL.md | 核心工作流 + 快速参考表 + references 导航 | skill 触发时 |
| references/dodge-patterns.md | 中英文替换表 + D1-D8 规则 + 回避层常量 | 需要 dodge 功能时 |
| references/continuity-lock.md | 参考帧注入模式 + 锚点提取 + 动态规则生成 | 需要重试优化时 |
| references/modular-rules.md | PromptSkill 接口 + 组合策略 + 各 Pass 规则映射 | 需要模块化时 |
| templates/prompt-skill-template.ts | PromptSkill 接口 + buildRulesForPass 代码模板 | 要写代码时 |

## Part 3：Bug 修复

### sanitizer.ts 词边界修正

```typescript
// Before (bug):
{ pattern: /SM|虐待/g, safe: '权力交换' }

// After (fix):
{ pattern: /\bSM\b|虐待/g, safe: '权力交换' }
```

## 文件改动清单

| # | 文件 | 动作 | 复杂度 |
|---|------|------|--------|
| 1 | `src/.../storyboard-pipeline/prompt-skills.ts` | 新建 | 中 |
| 2 | `src/.../storyboard-pipeline/StoryboardPipelineService.ts` | 修改 | 中 |
| 3 | `src/.../storyboard-pipeline/sanitizer.ts` | 修改 | 小 |
| 4 | `.cursor/skills/storyboard-prompt-engineering/` | 新建 | 中 |

## 设计决策记录

| 决策 | 选择 | 替代方案 | 理由 |
|------|------|---------|------|
| Skill 配置层级 | class 构造函数 | RunnableConfig.configurable | 闭包模式更简洁，skills 是实例级配置 |
| 动态 rules | 函数类型 | 全部静态 | continuity skill 需要 state 数据 |
| previousShots 精简 | `{ id, desc }` | 完整 ShotData | Token 预算控制 |
| Graph 拓扑 | 不变 | Command 路由重构 | 改动最小，风险最低 |
| 外部 skill 结构 | Agent Skills 规范 | 自定义格式 | 兼容 Deep Agents / OpenSkills / Cursor |
