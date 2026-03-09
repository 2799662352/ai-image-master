# Session Summary: DirectorPipeline 连贯提示词组装 + 全管线一致性强化

**日期**: 2026-03-09 (续)
**范围**: `DirectorPipeline` prompt 组装 → Schema 精简 → Reference Fidelity → 全管线英文统一 → Skill 注入 → StoryboardPro 架构对齐
**成果**: 10+ 个实施计划，185/186 测试通过 (1 pre-existing)

---

## 1. 自然语言角色内联 (expandCharacterTags 重构)

### 问题
- 角色描述用括号标注 `(Name: attrs)`，扩散模型容易 cross-attention 泄漏
- 多角色时 `.` 分隔，token 边界不清

### 解决方案

**文件**: `DirectorPipeline.ts`

| 函数 | 改动 |
|------|------|
| `buildNaturalDescriptor` | 新建 — 从 face/outfit/markers 生成 "a figure with X, wearing Y, carrying Z" |
| `getSpatialAnchors` | "on the left" → "in the foreground left" |
| `expandCharacterTags` | 重构为自然语言内联 + `;\n` 分隔符 |
| `assembleCoherentPrompt` | `.\n` 分段 (shot / characters / scene) |

**输出示例**:
```
medium shot;
in the foreground left, a figure with long mint-green hair, wearing dark teal military coat, carrying white folding fan lunges forward;
in the foreground right, a figure with silver-white twin tails, wearing navy blue sailor uniform blocks the strike;
stone courtyard with arched columns, warm golden hour side-light
```

---

## 2. CharacterAnchorSchema 精简 (6 → 5 字段)

### 问题
- `build` 字段低价值（身高体型），`buildNaturalDescriptor` 未使用
- 6 字段 × N 角色 → LLM 输出 token 过多

### 解决方案

**文件**: `director-schemas.ts`, `DirectorPipeline.ts`

| 改前 | 改后 |
|------|------|
| name, **anchor**, face, **build**, outfit, markers | name, **anchor**, face, outfit, markers |
| 6 字段/角色 | **5 字段/角色** |
| `SimpleCharacterSchema` 作为 L2 降级 | **已删除** — 不再降级 |

`anchor` 保留（下游直接引用），`build` 删除（低价值），`buildAnchorFromFields` 作为 fallback。

---

## 3. Reference Image Fidelity Mandate (三档注入全管线)

### 问题
- Pass 1/2/3 没有明确的"不允许臆造"约束
- 分析阶段可能 hallucinate 参考图中不存在的特征

### 解决方案

**文件**: `DirectorPipeline.ts` + 6 个 `.md` 模板 + `StoryboardProPipeline.ts`

| 档位 | 适用 Pass | 核心约束 |
|------|----------|---------|
| **analysis** | Pass 1/2/3 + StoryboardPro 1/2 | "Describe ONLY what is visually present. DO NOT hallucinate." |
| **design** | Pass 4 + Pass 6 | "MUST reproduce character appearance exactly. REFERENCE IMAGE WINS." |
| **verify** | Pass 5 | 新增 Reference Fidelity 维度 + 扣分规则 (-2/-3) |

共享函数 `buildReferenceImageFidelityMandate('analysis' | 'design' | 'verify')` 可复用。

---

## 4. StoryboardProPipeline 架构对齐

### 问题
- Pass 1/2 用 L1+L2 两次 LLM 调用模式
- L1 失败后发起第二次完整 LLM+Vision 调用 (~5-8s)

### 解决方案

**文件**: `StoryboardProPipeline.ts`

| Pass | 改前 | 改后 |
|------|------|------|
| Pass 1 sceneDecompose | L1 → L2 SimpleSceneSchema | L1 → raw regex → graceful degrade |
| Pass 2 characterExtract | L1 11-field → L2 4-field | L1 4-field SimpleObjArraySchema → raw regex → `{objs:[]}` |

删除 `SimpleSceneSchema` 定义。每 Pass 最多 **1 次 LLM 调用**。

---

## 5. 导演规划 Skill 注入

### 问题
- Task Planning (Pass 0) 是裸 `llm.invoke()` — 零 Skill 感知
- 其他 Pass 都有 `SkillsMW` + `runSkillDiscovery()`

### 解决方案

**文件**: `DirectorPipeline.ts` + `config/prompts/director/pass0-task-planning.md` + 6 个 `skills/director-*/SKILL.md`

| 改动 | 内容 |
|------|------|
| 新建模板 | `pass0-task-planning.md` |
| 6 个 skill 添加 `taskPlanning` phase | narrative-flow, cinematic-composition, shot-sequence-patterns, scene-analysis-depth, character-consistency, style-consistency |
| taskPlanningFn 重写 | `SkillsMW` + `runSkillDiscovery()` + prompt 模板 + `appliedSkills` |

---

## 6. 全管线英文统一

### 问题
- Task Planning 输出语言跟随用户输入 → 中文 sceneDescription 导致中文输出
- 下游 Pass 都要求英文，中英混杂导致模型混乱
- Pass 4 user message 是中文

### 解决方案

**文件**: `DirectorPipeline.ts`

| Pass | 改前 | 改后 |
|------|------|------|
| Pass 0 | "Write in same language as brief" | "Write ENTIRE plan in English" |
| Pass 3 | 无语言指令 | "in English" |
| Pass 4 | `【创意简报】...请基于该简报...` | `CREATIVE BRIEF: "..." Design N panels...` |

---

## 7. 导演规划传导到所有 Pass

### 问题
- 导演规划只通过 `injectTaskPlan` 注入 system prompt
- Pass 1/2/3/4 的 user message 没有引用导演规划

### 解决方案

**文件**: `DirectorPipeline.ts`

| Pass | 改动 |
|------|------|
| Pass 1 场景分析 | user message 加入 `DIRECTOR'S PLAN` |
| Pass 2 角色锚点 | user message 加入 `DIRECTOR'S PLAN (extraction priority)` |
| Pass 3 风格锚点 | user message 加入 `DIRECTOR'S PLAN (style direction)` |
| Pass 4 分镜设计 | user message 加入 `DIRECTOR'S PLAN (shooting blueprint)` |

---

## 8. 性能优化

### 改动

| 项目 | 改前 | 改后 |
|------|------|------|
| maxTokens | Gemini=65536, 其他=4096 | 统一 **65536** |
| Pass 4 L1 maxTokens | `panelCount * 800 + 1024` 限制 | 已删除，用默认值 |
| Pass 3 vision detail | 硬编码 `'high'` | `resolveVisionDetailByPass` 动态 |
| Pass 2 injectTaskPlan | 缺失 | 已补齐 |
| Prompt 字数限制 | "under 120 words" / "under 300 words" | **全部移除** |

---

## 9. UI 修复

### 改动

| 项目 | 改前 | 改后 |
|------|------|------|
| 风格锚点控件 | 不在看图质量列表里 | 已添加（复用场景分析 vision detail） |
| 导演规划卡片 | 直接显示 planText 全文 | 统一 appliedSkills + summary 格式 |

---

## 待执行 Plan

| Plan | 内容 | 状态 |
|------|------|------|
| `2026-03-09-skill-discovery-toggle.md` | Skill Discovery 开关 UI | 待执行 |
| `2026-03-09-task-planning-ui-controls.md` | 导演规划看图质量 + 跳过开关 | 待执行 |

---

## 测试状态

- Director pipeline: **185/186** (1 pre-existing vision-detail failure)
- Storyboard pipeline: **27/27**
- 无新增 linter errors
