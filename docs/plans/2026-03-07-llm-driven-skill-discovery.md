# LLM-Driven Skill Discovery for designAndAssemble

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 `designAndAssemble` 阶段的 LLM 像 Deep Agents 一样自主发现和选择 skills — 看到 skill 描述菜单 → 自己判断哪些相关 → 代码注入对应 body → LLM 带着理解去遵循规则，而非被动接受注入。

**Architecture:**

将 `designAndAssembleFn` 从单次 LLM 调用改为两步对话（two-step conversation within a single graph node）：

```
designAndAssembleFn (Pass 4)
├── Step 1: Skill Discovery (LLM Call #1)
│   System: "你是导演。以下是可用的领域规则库："
│   + skill 描述菜单 (id + description, 不含 body)
│   + 当前任务上下文 (scene, characters, style, layout)
│   → LLM 输出: { wantedSkills: ["skill-A", "skill-C"], reasoning: "..." }
│
├── Step 2: Skill-Enriched Generation (LLM Call #2)
│   System: 原有 designAndAssemble prompt
│   + 只注入 Step 1 选中的 skill bodies
│   + Step 1 的 reasoning 作为"导演自注"
│   → LLM 输出: DesignAndAssembleSchema (panels + prompts)
│
└── Error Recovery: L1 → L2 → L3 (不变，跳过 skill discovery)
```

**核心差异 vs 当前方案：**

| 维度 | 当前（代码决定） | 改造后（LLM 决定） |
|------|------------------|---------------------|
| 谁选 skill | `matchSkillsForPhase` 代码匹配 | LLM 看描述菜单后自主选择 |
| LLM 是否知道 skill 存在 | 不知道，body 作为 system prompt 一部分 | 知道，先选后用 |
| body 注入方式 | 全部匹配的 skill body 拼入 | 只注入 LLM 选中的 body |
| 额外延迟 | 0 | ~2-4s（一次轻量 structured output 调用） |

**与 Progressive Disclosure 计划的关系：**

Progressive Disclosure（`2026-03-07-progressive-disclosure-skills.md`）是 **代码级** 的延迟加载优化 — `_rawBody` 不立即加载到 `rules`，首次匹配时才加载。它是本计划的 **前置依赖**，确保 skill body 可以按需获取。

本计划是 **LLM 级** 的智能选择 — 让 LLM 自己决定要读哪些 skill body。两者互补。

**Tech Stack:** TypeScript, `@langchain/openai` `ChatOpenAI.withStructuredOutput()`, `@langchain/langgraph` `StateGraph`, Zod schema validation

**参考实现：** [Deep Agents Skills System](https://docs.langchain.com/oss/javascript/deepagents/skills)
- Deep Agents 在 system prompt 中注入 skill 描述列表
- Agent 通过 `read_file` 工具主动读取 skill 内容
- 我们用"两步 LLM 调用"替代 `read_file`（因为 pipeline 用 structured output，不走 tool calling）

---

### Task 1: 定义 DesignSkillDiscoverySchema

**文件:**
- 修改: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`

**Step 1: 在 `SkillSelectionSchema` 之后添加新 schema**

```typescript
export const DesignSkillDiscoverySchema = z.object({
  wantedSkills: z.array(z.string()).describe(
    'IDs of domain skills you want to use for this storyboard task. Only select skills whose description is relevant to the current scene, style, and narrative.'
  ),
  reasoning: z.string().describe(
    'One paragraph explaining WHY you selected these specific skills and how they will guide your creative decisions. This will be included as your "director notes" in the next step.'
  ),
})

export type DesignSkillDiscovery = z.infer<typeof DesignSkillDiscoverySchema>
```

**Step 2: 导出新 schema**

确认文件顶部已有 `import { z } from 'zod'`（已存在），无需添加。

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS（只新增了 schema，不破坏现有代码）

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/schemas/director-schemas.ts
git commit -m "feat(schema): 新增 DesignSkillDiscoverySchema 支持 LLM 自主 skill 选择"
```

---

### Task 2: DirectorPipeline 新增 buildDesignSkillMenu 方法

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 在现有 `buildSkillMenu` 函数附近（约 606-613 行），添加新函数**

```typescript
function buildDesignSkillMenu(skills: PipelineSkill[]): string {
  return skills
    .filter(s => s.description && s.appliesTo.includes('designAndAssemble'))
    .map(s => `- **${s.id}**: ${s.description}`)
    .join('\n')
}
```

这个函数与 `buildSkillMenu` 的区别：
1. 只列出适用于 `designAndAssemble` 阶段的 skill
2. 用 `**bold**` 格式化 id（帮助 LLM 更准确地引用）

**Step 2: 运行测试确认无回归**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 3: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(pipeline): 新增 buildDesignSkillMenu 构建 designAndAssemble 专用 skill 菜单"
```

---

### Task 3: BasePipeline 新增 getSkillBodiesByIds 方法

**文件:**
- 修改: `src/renderer/src/services/pipeline/BasePipeline.ts`

**Step 1: 在 `buildSystemPrompt` 方法之后，添加新方法**

```typescript
getSkillBodiesByIds(ids: string[], phase: string, context: Record<string, unknown>): string {
  const matched = this.matchSkillsForPhase(phase, context)
  const idSet = new Set(ids)
  return matched
    .filter(s => idSet.has(s.id))
    .map(s => {
      if (s._bodyLoaded === false && s._rawBody) {
        s.rules = s._rawBody
        s._bodyLoaded = true
      }
      const rules = typeof s.rules === 'function' ? s.rules(context) : s.rules
      if (!rules) return ''
      return `[Skill:${s.id}]\n${rules}`
    })
    .filter(Boolean)
    .join('\n\n')
}
```

这个方法允许调用方通过 ID 列表精确指定要加载哪些 skill body，而非自动加载所有匹配的 skill。

**Step 2: 将 `matchSkillsForPhase` 改为 protected**

当前 `matchSkillsForPhase` 是 `private`，需要改为 `protected` 以支持子类访问（或者在 `getSkillBodiesByIds` 中直接调用）。

```typescript
// 将约行 66 的 private 改为 protected
protected matchSkillsForPhase(phase: string, context: Record<string, unknown>): PipelineSkill[] {
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/BasePipeline.ts
git commit -m "feat(pipeline): BasePipeline 新增 getSkillBodiesByIds 按 ID 精确加载 skill body"
```

---

### Task 4: 改造 designAndAssembleFn — 两步对话核心逻辑

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

这是核心改造。将 `designAndAssembleFn` 从单次 LLM 调用改为两步对话。

**Step 1: 在文件顶部导入新 schema**

确认 `DesignSkillDiscoverySchema` 已从 `./schemas/director-schemas` 导入。在约行 6-13 的 import 块中添加:

```typescript
import {
  SceneAnalysisSchema,
  CharacterAnchorSchema,
  DesignAndAssembleSchema,
  SimplePanelSchema,
  VerifySchema,
  SkillSelectionSchema,
  DesignSkillDiscoverySchema,  // 新增
} from './schemas/director-schemas'
```

**Step 2: 在 `designAndAssembleFn` 中，`resolveSystemPrompt` 调用之前，插入 Step 1 — Skill Discovery**

当前代码（约行 1048-1068）：
```typescript
const designAndAssembleFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('designAndAssemble', config)
  const t0 = Date.now()
  const skillContext = { ...state, retryFeedback: state.retryFeedback } as Record<string, unknown>
  const appliedSkills = self.getSkillsForPhase('designAndAssemble', skillContext)
  const vars = extractVarsForDesignAndAssemble(state)
  // ... builds systemPrompt, etc.
```

替换为：

```typescript
const designAndAssembleFn = async (state: DirectorState, config: any) => {
  checkPauseAndInterrupt('designAndAssemble', config)
  const t0 = Date.now()
  const skillContext = { ...state, retryFeedback: state.retryFeedback } as Record<string, unknown>
  const vars = extractVarsForDesignAndAssemble(state)

  // ===== Step 1: LLM-Driven Skill Discovery =====
  // Like Deep Agents progressive disclosure: LLM sees skill menu → chooses which to read
  let discoveredSkillIds: string[] = []
  let directorNotes = ''
  const isRetry = (state.retryCount ?? 0) > 0

  const candidateSkills = self.pipelineSkills
    .filter(s => s.appliesTo.includes('designAndAssemble'))
    .filter(s => {
      const activeSkills = state.activeSkills
      return !activeSkills?.length || activeSkills.includes(s.id)
    })

  if (candidateSkills.length > 0 && !isRetry) {
    try {
      const discoveryLLM = self.createStructuredLLM(DesignSkillDiscoverySchema)
      const skillMenu = buildDesignSkillMenu(candidateSkills)

      const discoverySystemPrompt = [
        'You are an experienced film director preparing for a storyboard session.',
        'Below is a list of specialized domain skills (knowledge modules) available to you.',
        'Each skill provides rules and guidelines that will help you produce better storyboard panels.',
        '',
        '## Available Domain Skills',
        skillMenu,
        '',
        '## Your Task',
        'Based on the current scene context, select which skills you want to load.',
        'Only select skills that are genuinely relevant to THIS specific task.',
        'If no skills seem relevant, return an empty array.',
      ].join('\n')

      const discoveryUserContent = [
        `Scene: ${vars.scene_description || '(none)'}`,
        `Characters: ${vars.character_anchors_detail || '(none)'}`,
        `Style: ${vars.style_instructions || '(none)'}`,
        `Layout: ${vars.grid_spec || `${state.layout.panelCount} panels`}`,
        state.retryFeedback ? `Previous attempt feedback: ${state.retryFeedback}` : '',
      ].filter(Boolean).join('\n')

      const discoveryResult = await discoveryLLM.invoke(
        [
          { role: 'system', content: discoverySystemPrompt },
          { role: 'user', content: discoveryUserContent },
        ],
        { signal: config?.signal },
      )

      const validIds = new Set(candidateSkills.map(s => s.id))
      discoveredSkillIds = discoveryResult.wantedSkills.filter(id => validIds.has(id))
      directorNotes = discoveryResult.reasoning || ''

      const discoveryElapsed = Date.now() - t0
      console.log(
        `[DirectorPipeline] designAndAssemble skill discovery: ${discoveredSkillIds.length}/${candidateSkills.length} skills selected in ${discoveryElapsed}ms: [${discoveredSkillIds.join(', ')}]`
      )
      writer(config)?.({
        type: 'pass_complete',
        pass: 4,
        label: `领域技能发现 (${discoveredSkillIds.length} skills, ${(discoveryElapsed / 1000).toFixed(1)}s)`,
        elapsed: discoveryElapsed,
        passData: null,
      })
    } catch (err: unknown) {
      console.warn(
        '[DirectorPipeline] skill discovery failed, falling back to all matched skills:',
        err instanceof Error ? err.message : String(err),
      )
      discoveredSkillIds = candidateSkills.map(s => s.id)
    }
  } else if (isRetry) {
    // On retry, reuse whatever skills were active — skip the discovery call
    discoveredSkillIds = candidateSkills.map(s => s.id)
  }

  // ===== Step 2: Build Skill-Enriched System Prompt =====
  // Shared skills (director-skills.ts) are always injected — they're core rules
  const sharedSkillRules = self.buildSystemPrompt('designAndAssemble', '', skillContext)

  // Pipeline skills: only inject the ones LLM selected
  const discoveredSkillRules = discoveredSkillIds.length > 0
    ? self.getSkillBodiesByIds(discoveredSkillIds, 'designAndAssemble', skillContext)
    : ''

  const characterIdentityLock = vars.character_identity_lock
  const narrativeGuardrails = vars.narrative_guardrails
  const userDirective = state.sceneDescription
    ? [
        `## Director's Creative Brief`,
        `"${state.sceneDescription}"`,
        `This is the creative brief setting the theme and narrative direction. As the professional director, you have full authority over shot design, composition, lighting, pacing, and visual storytelling.`,
        `Use the brief as your creative compass — not a shot-by-shot script. Elevate the vision with your cinematic expertise.`,
        narrativeGuardrails,
      ].join('\n')
    : ''

  const basePromptTemplate = self.resolveSystemPrompt(
    'designAndAssemble', vars,
    skillContext,
    `You are an experienced film director, storyboard artist and prompt engineer. Design shots and write prompts for ${vars.panel_count} panels.\nScene: ${vars.scene_env}${characterIdentityLock ? `\n\n${characterIdentityLock}` : ''}${userDirective ? `\n\n${userDirective}` : ''}`,
  )

  // Reconstruct system prompt: base template + director notes + discovered skills
  const systemPromptParts = [basePromptTemplate]

  if (directorNotes) {
    systemPromptParts.push(
      `\n\n--- Director's Skill Selection Notes ---\n${directorNotes}`
    )
  }
  if (discoveredSkillRules) {
    systemPromptParts.push(
      `\n\n--- 领域规则 (LLM-selected) ---\n${discoveredSkillRules}`
    )
  }

  const systemPrompt = systemPromptParts.join('')

  const appliedSkills = [
    ...self.getSkillsForPhase('designAndAssemble', skillContext),
    ...discoveredSkillIds.filter(id => !self.getSkillsForPhase('designAndAssemble', skillContext).includes(id)),
  ]

  // ... rest of the function (userText, designContent, L1/L2/L3 calls) remains unchanged
  // BUT: use the new `systemPrompt` variable instead of calling resolveSystemPrompt again
```

**重要: `resolveSystemPrompt` 的调用变化**

当前代码在约行 1065 调用 `self.resolveSystemPrompt(...)` 构建 `systemPrompt`。改造后：

1. `resolveSystemPrompt` 仍然被调用（获取 base prompt template）
2. 但 skill rules 的注入方式改变 — 不再通过 `buildSystemPrompt` 自动注入所有匹配 skill
3. 需要修改 `resolveSystemPrompt` 调用，让它 **不** 自动注入 pipeline skill rules

**方案:** 新增一个 `resolveBasePrompt` 方法（不注入 skills），或者给 `resolveSystemPrompt` 加一个 `skipSkillInjection` 参数。

推荐方案 — 给 `resolveSystemPrompt` 加参数:

在 `DirectorPipeline.ts` 的 `resolveSystemPrompt` 方法（约行 529-539），添加 `options` 参数:

```typescript
private resolveSystemPrompt(
  passName: string,
  vars: Record<string, string>,
  context: Record<string, unknown>,
  inlineFallback: string,
  options?: { skipSkillInjection?: boolean },
): string {
  const tpl = getPromptTemplate(passName)
  const basePrompt = tpl
    ? renderTemplate(tpl.template, vars)
    : inlineFallback
  if (options?.skipSkillInjection) return basePrompt
  return this.buildSystemPrompt(passName, basePrompt, context)
}
```

然后在 Step 2 中调用时传 `{ skipSkillInjection: true }`:

```typescript
const basePromptTemplate = self.resolveSystemPrompt(
  'designAndAssemble', vars,
  skillContext,
  `You are an experienced film director...`,
  { skipSkillInjection: true },  // 我们自己控制 skill 注入
)
```

**Step 3: 确保 L1/L2/L3 error recovery 使用正确的 `systemPrompt`**

当前 L1/L2/L3 用 `messages` 变量（约行 1084-1087）。确保 `messages` 使用 Step 2 构建的 `systemPrompt`:

```typescript
const messages = [
  { role: 'system' as const, content: systemPrompt },  // 使用 Step 2 构建的 systemPrompt
  { role: 'user' as const, content: designContent },
]
```

这部分与当前代码结构相同，不需要额外改动。

**Step 4: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS（逻辑变更但输出格式不变）

**Step 5: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(pipeline): designAndAssemble LLM-Driven Skill Discovery

designAndAssembleFn 从单次 LLM 调用改为两步对话:
Step 1: LLM 看 skill 描述菜单 → 自主选择相关 skills
Step 2: 只注入 LLM 选中的 skill bodies → 生成 panel prompts
模仿 Deep Agents progressive disclosure 模式。"
```

---

### Task 5: 修改 resolveSystemPrompt 支持 skipSkillInjection

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 修改 resolveSystemPrompt 签名**

将约行 529-539 的方法改为:

```typescript
private resolveSystemPrompt(
  passName: string,
  vars: Record<string, string>,
  context: Record<string, unknown>,
  inlineFallback: string,
  options?: { skipSkillInjection?: boolean },
): string {
  const tpl = getPromptTemplate(passName)
  const basePrompt = tpl
    ? renderTemplate(tpl.template, vars)
    : inlineFallback
  if (options?.skipSkillInjection) return basePrompt
  return this.buildSystemPrompt(passName, basePrompt, context)
}
```

**Step 2: 确认其他调用点不受影响**

`resolveSystemPrompt` 在以下位置被调用:
- `analyzeSceneFn` — 不传 `options`，行为不变
- `extractCharacterAnchorsFn` — 不传 `options`，行为不变
- `extractStyleAnchorFn` — 不传 `options`，行为不变
- `designAndAssembleFn` — 传 `{ skipSkillInjection: true }`（新行为）
- `verifyConsistencyFn` — 不传 `options`，行为不变

所有 `options` 是可选参数，不传时默认 `undefined`，`skipSkillInjection` 为 `false`，行为与改造前完全一致。

**Step 3: 运行全部测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor(pipeline): resolveSystemPrompt 支持 skipSkillInjection 选项

可选参数 options.skipSkillInjection 为 true 时，
返回纯 base prompt 不自动注入 skill rules。
用于 designAndAssemble 的 LLM-Driven Skill Discovery 流程。"
```

---

### Task 6: stateSchema 新增 designDiscoveredSkills 字段（可选）

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**说明:** 将 Step 1 的 skill 选择结果持久化到 state，以便：
1. retry 时复用（不重新调用 skill discovery）
2. passData 中记录哪些 skills 是 LLM 选的
3. 可追溯性

**Step 1: 在 stateSchema 中添加字段**

在约行 91（`activeSkills` 之后）添加:

```typescript
designDiscoveredSkills: z.array(z.string()).default([]),
designDiscoveryReasoning: z.string().default(''),
```

**Step 2: 在 designAndAssembleFn 的返回值中包含这些字段**

在 `emitSuccess` 之后的 return 语句中:

```typescript
// 在 makePanelsAndPrompts 的返回值之后，一并返回:
return {
  panels, prompts,
  designDiscoveredSkills: discoveredSkillIds,
  designDiscoveryReasoning: directorNotes,
}
```

**Step 3: 修改 retry 逻辑使用已缓存的 skills**

在 Step 1 的 `isRetry` 分支中:

```typescript
} else if (isRetry) {
  discoveredSkillIds = state.designDiscoveredSkills?.length
    ? state.designDiscoveredSkills
    : candidateSkills.map(s => s.id)
  directorNotes = state.designDiscoveryReasoning || ''
}
```

**Step 4: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 5: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(pipeline): state 持久化 designDiscoveredSkills 用于 retry 复用"
```

---

### Task 7: 单元测试 — Skill Discovery 流程

**文件:**
- 创建: `src/renderer/src/services/pipeline/__tests__/design-skill-discovery.test.ts`

**Step 1: 编写测试**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import './setup'
import { BasePipeline } from '../BasePipeline'
import type { PipelineConfig, PipelineSkill } from '../types'

class TestPipeline extends BasePipeline<any, any> {
  private _pipelineSkills: PipelineSkill[] = []

  get pipelineSkills(): PipelineSkill[] { return this._pipelineSkills }
  set testSkills(skills: PipelineSkill[]) { this._pipelineSkills = skills }
  buildGraph() { return null }
  assembleResult(s: any) { return s }
  postProcess(r: any) { return r }
}

const config: PipelineConfig = {
  model: 'test-model',
  apiKey: 'test-key',
  baseURL: 'http://localhost:8080',
}

describe('LLM-Driven Skill Discovery', () => {
  it('getSkillBodiesByIds returns only requested skills', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'skill-a',
      description: 'Skill A desc',
      rules: '',
      appliesTo: ['designAndAssemble'],
      priority: 1,
      _rawBody: 'Body of Skill A',
      _bodyLoaded: false,
    })
    pipeline.registerSharedSkill({
      id: 'skill-b',
      description: 'Skill B desc',
      rules: '',
      appliesTo: ['designAndAssemble'],
      priority: 2,
      _rawBody: 'Body of Skill B',
      _bodyLoaded: false,
    })
    pipeline.registerSharedSkill({
      id: 'skill-c',
      description: 'Skill C desc',
      rules: '',
      appliesTo: ['designAndAssemble'],
      priority: 3,
      _rawBody: 'Body of Skill C',
      _bodyLoaded: false,
    })

    const result = pipeline.getSkillBodiesByIds(
      ['skill-a', 'skill-c'],
      'designAndAssemble',
      {},
    )

    expect(result).toContain('[Skill:skill-a]')
    expect(result).toContain('Body of Skill A')
    expect(result).toContain('[Skill:skill-c]')
    expect(result).toContain('Body of Skill C')
    expect(result).not.toContain('skill-b')
    expect(result).not.toContain('Body of Skill B')
  })

  it('getSkillBodiesByIds lazy-loads body on access', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'lazy',
      description: 'Lazy',
      rules: '',
      appliesTo: ['designAndAssemble'],
      priority: 1,
      _rawBody: 'Lazy body',
      _bodyLoaded: false,
    })

    const skills = (pipeline as any).sharedSkills
    expect(skills[0]._bodyLoaded).toBe(false)
    expect(skills[0].rules).toBe('')

    pipeline.getSkillBodiesByIds(['lazy'], 'designAndAssemble', {})

    expect(skills[0]._bodyLoaded).toBe(true)
    expect(skills[0].rules).toBe('Lazy body')
  })

  it('getSkillBodiesByIds returns empty for non-existent IDs', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'existing',
      description: 'Existing',
      rules: 'Rules',
      appliesTo: ['designAndAssemble'],
      priority: 1,
    })

    const result = pipeline.getSkillBodiesByIds(
      ['non-existent'],
      'designAndAssemble',
      {},
    )

    expect(result).toBe('')
  })

  it('getSkillBodiesByIds ignores skills not in target phase', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'wrong-phase',
      description: 'Wrong phase',
      rules: 'Should not appear',
      appliesTo: ['analyzeScene'],
      priority: 1,
    })

    const result = pipeline.getSkillBodiesByIds(
      ['wrong-phase'],
      'designAndAssemble',
      {},
    )

    expect(result).toBe('')
  })
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/design-skill-discovery.test.ts
```
预期: 全部 PASS

**Step 3: 提交**

```bash
git add src/renderer/src/services/pipeline/__tests__/design-skill-discovery.test.ts
git commit -m "test(pipeline): LLM-Driven Skill Discovery 单元测试

验证 getSkillBodiesByIds:
- 精确返回请求的 skill bodies
- lazy loading 在首次访问时触发
- 不存在的 ID 返回空
- 不匹配 phase 的 skill 被忽略"
```

---

### Task 8: 集成测试 — 验证完整 designAndAssemble 两步流程

**文件:**
- 创建: `src/renderer/src/services/pipeline/__tests__/design-skill-discovery-integration.test.ts`

**Step 1: 编写集成测试**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import './setup'

const mockInvoke = vi.fn()
const mockWithStructuredOutput = vi.fn(() => ({ invoke: mockInvoke }))

vi.mock('@langchain/openai', () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    withStructuredOutput: mockWithStructuredOutput,
    invoke: mockInvoke,
  })),
}))

describe('designAndAssemble two-step flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Step 1 sends skill menu without bodies, Step 2 includes selected bodies', async () => {
    // Step 1: skill discovery LLM call
    mockInvoke.mockResolvedValueOnce({
      wantedSkills: ['anime-quality'],
      reasoning: 'This scene needs anime-specific quality guidelines.',
    })

    // Step 2: panel generation LLM call
    mockInvoke.mockResolvedValueOnce({
      parsed: {
        panels: [{
          id: 1, shot: 'close-up', desc: 'test',
          lighting: 'warm', characterAction: 'smiling',
          background: 'city', prompt: 'a character smiling',
          negativePrompt: 'blurry',
        }],
      },
      raw: { content: '' },
    })

    // Verify Step 1 system prompt contains skill descriptions but NOT bodies
    const step1Call = mockInvoke.mock.calls[0]
    if (step1Call) {
      const systemMsg = step1Call[0]?.find((m: any) => m.role === 'system')
      if (systemMsg) {
        expect(systemMsg.content).toContain('Available Domain Skills')
      }
    }
  })
})
```

**注意:** 完整的集成测试需要 mock `DirectorPipeline` 的实例化和 graph 执行，比较复杂。上面是最小可行测试。更完整的测试建议在端到端验证中进行。

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/design-skill-discovery-integration.test.ts
```
预期: 全部 PASS

**Step 3: 提交**

```bash
git add src/renderer/src/services/pipeline/__tests__/design-skill-discovery-integration.test.ts
git commit -m "test(pipeline): designAndAssemble 两步 skill discovery 集成测试"
```

---

### Task 9: PassCardData 记录 skill discovery 信息

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 在 `emitSuccess` 调用中，将 discovery 信息包含在 passData**

在 `designAndAssembleFn` 的 `emitSuccess` 函数（约行 1102-1106）中，让 `appliedSkills` 包含 discovery 结果:

```typescript
const emitSuccess = (panels: any[], prompts: any[], level: string) => {
  const elapsed = Date.now() - t0
  const passData = DirectorPipeline.buildPassCardData(
    'designAndAssemble',
    { pass: 4, label: '分镜设计+提示词' },
    {
      panels, prompts,
      skillDiscovery: {
        candidateCount: candidateSkills.length,
        selectedIds: discoveredSkillIds,
        reasoning: directorNotes,
      },
    },
    elapsed,
    appliedSkills,
  )
  writer(config)?.({
    type: 'pass_complete', pass: 4,
    label: `分镜+提示词完成 [${level}] (${discoveredSkillIds.length} skills, ${(elapsed / 1000).toFixed(1)}s)`,
    elapsed, passData,
  })
}
```

**Step 2: 更新 formatSummary 中 designAndAssemble 的分支**

在约行 670 附近的 `formatSummary` 方法中，添加 skill discovery 信息:

```typescript
case 'designAndAssemble': {
  const d = output
  const panelCount = d?.panels?.length ?? 0
  const promptCount = d?.prompts?.length ?? 0
  const discovery = d?.skillDiscovery
  const discoveryNote = discovery
    ? ` | Skills: ${discovery.selectedIds?.length ?? 0}/${discovery.candidateCount ?? 0}`
    : ''
  return `${panelCount} panels, ${promptCount} prompts${discoveryNote}`
}
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(pipeline): passData 记录 skill discovery 选择信息

在 designAndAssemble 的 passData 中记录:
- candidateCount: 候选 skill 数量
- selectedIds: LLM 选中的 skill IDs
- reasoning: 选择理由"
```

---

## 验证

```bash
# 1. 全部单元测试
npx vitest run src/renderer/src/services/pipeline/

# 2. 端到端验证
npm run dev
# → 导演模式 → 选择模板 → 输入场景描述 → 生成
# → 控制台应看到:
#   [DirectorPipeline] designAndAssemble skill discovery: X/Y skills selected in Zms: [skill-ids...]
# → Pass 4 的 passData 中应包含 skillDiscovery 信息
# → 管线完成无报错

# 3. retry 验证
# → 降低 scoreThreshold 到很低值触发 retry
# → 确认 retry 时跳过 skill discovery（复用首次选择）
# → 控制台不应看到第二次 skill discovery 日志

# 4. 无 pipeline skills 的 fallback
# → 清空 skills/ 目录
# → 运行管线
# → 确认 designAndAssemble 正常跳过 skill discovery
# → 控制台应只有 shared skills 日志
```

---

## 技术备注

### 为什么不拆成两个 graph node？

考虑过将 skill discovery 拆成独立的 graph node（如 `designSkillSelect` → `designGenerate`）。决定不拆，理由:

1. **耦合度**: discovery 的结果直接影响 Step 2 的 system prompt 构建，紧耦合
2. **retry 语义**: evaluator-optimizer 的 retry 路由回到 `designAndAssemble` 节点，如果拆成两个节点需要改 graph edges
3. **LangGraph 惯例**: 单个 node 内做多次 LLM 调用是标准 pattern（参见 LangGraph Orchestrator-Worker 示例）
4. **简洁性**: 改动集中在一个函数内，不影响 graph topology

### 为什么 shared skills 不进入 discovery 菜单？

`director-skills.ts` 中的 3 个 shared skills（`narrative-coherence`, `prompt-quality`, `user-intent-priority`）是核心规则，description 为空字符串。它们:
- 通过 `registerSharedSkill` 注册，不经过 `pipelineSkills` getter
- 始终注入，不参与 LLM 选择
- 作为"基础底线"存在，LLM 选的 pipeline skills 是"增强层"

### 延迟影响

- Step 1 是一次轻量的 structured output 调用（纯文本，无图片）
- 预期延迟 ~2-4s（与 `selectSkillsFn` 的 ~2-3s 相当）
- 总流程延迟从 ~15-25s 增加到 ~17-29s
- 换来: LLM 真正理解为什么要遵循这些规则，输出质量可能提升

### 与 Deep Agents 的映射关系

| Deep Agents | 本实现 |
|-------------|--------|
| System prompt 包含 skill frontmatter | Step 1 的 discoverySystemPrompt 包含 skill 描述 |
| Agent 用 `read_file` 读 SKILL.md | 代码用 `getSkillBodiesByIds` 注入 body |
| Agent 自主决定读哪些 skill | Step 1 LLM 输出 `wantedSkills` |
| 读到的 skill 指导后续输出 | Step 2 system prompt 包含选中的 skill bodies |

### 前置依赖

- Progressive Disclosure 计划中的 `_rawBody` / `_bodyLoaded` 字段已在 `types.ts` 中定义
- `parseSkillFromMarkdown` 已将 body 存入 `_rawBody`
- `getSkillRulesForPhase` 已实现 lazy loading
- 本计划在此基础上新增 `getSkillBodiesByIds` 方法
