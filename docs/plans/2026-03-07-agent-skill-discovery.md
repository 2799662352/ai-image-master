# Agent 自主 Skill Discovery（Deep Agents 模式）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 designAndAssemble 阶段的 LLM 自主发现、请求读取、并遵循 skill，而非被动接收注入的 rules。仿照 Deep Agents 的 Progressive Disclosure 模式。

**Architecture:**
1. system prompt 中只放 skill 描述菜单（id + description），不放 body
2. LLM 第一次调用返回"我要读取的 skill 列表" + "初步设计思路"
3. 代码根据 LLM 请求的 skill 列表加载对应 body，追加到对话中
4. LLM 第二次调用基于读取的 skill 内容生成最终 panel prompts

**Tech Stack:** `@langchain/langgraph` ^1.2.0, `@langchain/openai` ^1.2.10, `zod` ^4.3.6

**Deep Agents 官方模式 (2026-03-07 确认):**
> "Skills use progressive disclosure—they are only loaded when the agent determines they're useful for the current task"
> "Agent reads frontmatter from each SKILL.md file at startup, then reviews full skill content when needed"
来源: https://docs.langchain.com/oss/javascript/deepagents/harness

**改造前后对比:**
```
改造前 (被动注入):
  system prompt = base prompt + 所有被选中 skill 的完整 body
  → LLM 收到一个巨大的 system prompt
  → 一次调用生成 panel prompts

改造后 (Agent 自主发现):
  system prompt = base prompt + skill 描述菜单（仅 id: description）
  → 第一次调用: LLM 返回 { requestedSkills: ["skill-a", "skill-c"], designPlan: "..." }
  → 代码加载 skill-a 和 skill-c 的 body
  → 第二次调用: LLM 基于 body + designPlan 生成 panel prompts
```

---

### Task 1: 新增 SkillDiscoverySchema

**文件:**
- 修改: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`

**Step 1: 运行现有测试确认基线**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 2: 在 director-schemas.ts 末尾添加新 Schema**

```typescript
export const SkillDiscoverySchema = z.object({
  requestedSkills: z.array(z.string()).describe('List of skill IDs to read for this task'),
  designPlan: z.string().describe('Brief plan for how to approach the storyboard design based on available information'),
})

export type SkillDiscovery = z.infer<typeof SkillDiscoverySchema>
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/schemas/director-schemas.ts
git commit -m "feat(schemas): 新增 SkillDiscoverySchema 支持 Agent 自主 Skill Discovery"
```

---

### Task 2: buildSystemPrompt 支持 description-only 模式

**文件:**
- 修改: `src/renderer/src/services/pipeline/BasePipeline.ts`

**Step 1: 添加 buildSkillMenuPrompt 方法**

在 `buildSystemPrompt` 方法之后（约行 101）添加新方法:

```typescript
buildSkillMenuPrompt(passName: string, basePrompt: string, context: Record<string, unknown>): string {
  const matched = this.matchSkillsForPhase(passName, context)
  if (matched.length === 0) return basePrompt

  const menu = matched
    .map(s => `- ${s.id}: ${s.description}`)
    .join('\n')

  return `${basePrompt}\n\n--- Available Skills (read only if relevant) ---\n${menu}\n\nIf any skills are relevant to this task, include their IDs in your requestedSkills list. You will receive the full skill content before generating the final output.`
}
```

**Step 2: 添加 getSkillBodiesById 方法**

```typescript
getSkillBodiesById(ids: string[], passName: string, context: Record<string, unknown>): string {
  const matched = this.matchSkillsForPhase(passName, context)
  return matched
    .filter(s => ids.includes(s.id))
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

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS（新方法不影响现有代码）

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/BasePipeline.ts
git commit -m "feat(pipeline): 添加 buildSkillMenuPrompt 和 getSkillBodiesById

buildSkillMenuPrompt: 只将 skill 描述菜单（id: description）注入 system prompt
getSkillBodiesById: 根据 LLM 请求的 skill ID 列表加载对应 body"
```

---

### Task 3: designAndAssembleFn 改为两步对话

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts` — designAndAssembleFn 函数

**Step 1: 在 designAndAssembleFn 中添加 Step 1 — Skill Discovery**

在现有 `const messages = [...]` 构建之后（约行 1087），在 L1 调用之前，插入 skill discovery 步骤:

```typescript
// ===== Step 1: Agent Skill Discovery (Progressive Disclosure) =====
let discoveredSkillRules = ''
const allSkills = self.pipelineSkills
const hasDiscoverableSkills = allSkills.some(s => s.appliesTo.includes('designAndAssemble'))

if (hasDiscoverableSkills) {
  try {
    const discoveryPrompt = self.buildSkillMenuPrompt(
      'designAndAssemble', 
      `You are an experienced film director. Before designing shots, review the available skills and select which ones are relevant to this task.\n\nScene: ${vars.scene_env}${characterIdentityLock ? `\n\n${characterIdentityLock}` : ''}`,
      skillContext,
    )
    const discoveryLLM = self.createStructuredLLM(SkillDiscoverySchema, undefined, 2048, 'jsonMode')
    const discoveryResult = await discoveryLLM.invoke(
      [
        { role: 'system' as const, content: discoveryPrompt },
        { role: 'user' as const, content: `Task: Design ${state.layout.panelCount} storyboard panels.\nTemplate: ${state.template || 'default'}\nStyle: ${state.styleInstructions || '(none)'}\nScene: ${state.sceneDescription || '(none)'}\n\nWhich skills should I read to do this well?` },
      ],
      { signal: config?.signal },
    )

    const validIds = new Set(allSkills.map(s => s.id))
    const requested = (discoveryResult?.requestedSkills || []).filter((id: string) => validIds.has(id))
    
    if (requested.length > 0) {
      discoveredSkillRules = self.getSkillBodiesById(requested, 'designAndAssemble', skillContext)
      console.log(`[DirectorPipeline] Skill Discovery: ${requested.length} skills requested: [${requested.join(', ')}]`)
      console.log(`[DirectorPipeline] Design plan: ${(discoveryResult?.designPlan || '').slice(0, 100)}`)
    } else {
      console.log('[DirectorPipeline] Skill Discovery: no skills requested')
    }
  } catch (e: unknown) {
    console.warn('[DirectorPipeline] Skill Discovery failed, falling back to injected skills:', e instanceof Error ? e.message : String(e))
    // Fallback: use the old injected approach
    discoveredSkillRules = self.getSkillRulesForPhase('designAndAssemble', skillContext)
  }
}

// ===== Step 2: Build final system prompt with discovered skill bodies =====
const finalSystemPrompt = discoveredSkillRules
  ? `${systemPrompt}\n\n--- 领域规则 (Agent-Requested) ---\n${discoveredSkillRules}`
  : systemPrompt

const messages = [
  { role: 'system' as const, content: finalSystemPrompt },
  { role: 'user' as const, content: designContent },
]
```

**重要修改**: 原来的 `systemPrompt` 是通过 `self.resolveSystemPrompt('designAndAssemble', ...)` 构建的，它会自动注入所有被选中 skill 的 body。现在需要改为**不注入 body**的版本。

修改约行 1065:
```typescript
// BEFORE (自动注入所有 skill body):
const systemPrompt = self.resolveSystemPrompt(
  'designAndAssemble', vars, skillContext,
  `You are an experienced film director...`,
)

// AFTER (不注入 body，只用 base prompt):
const baseSystemPrompt = `You are an experienced film director, storyboard artist and prompt engineer. Design shots and write prompts for ${vars.panel_count} panels.\nScene: ${vars.scene_env}${characterIdentityLock ? `\n\n${characterIdentityLock}` : ''}${userDirective ? `\n\n${userDirective}` : ''}`
```

然后在 Skill Discovery 之后，将 `discoveredSkillRules` 追加到 `baseSystemPrompt` 上构建最终的 `systemPrompt`。

**Step 2: 在 director-schemas.ts 中添加 import**

在 DirectorPipeline.ts 的 import 区域添加:
```typescript
import { SkillDiscoverySchema } from './schemas/director-schemas'
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "feat(director): designAndAssemble 实现 Agent 自主 Skill Discovery

仿照 Deep Agents Progressive Disclosure:
Step 1: LLM 看到 skill 描述菜单 → 返回 requestedSkills 列表
Step 2: 代码加载请求的 skill body → 追加到 system prompt
Step 3: LLM 基于 skill body 生成最终 panel prompts

失败时 fallback 到原有的全量注入模式。"
```

---

### Task 4: 添加测试

**文件:**
- 修改: `src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts`

**Step 1: 添加 buildSkillMenuPrompt 和 getSkillBodiesById 测试**

```typescript
describe('Skill Discovery (Progressive Disclosure)', () => {
  it('buildSkillMenuPrompt returns menu with descriptions only', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'test-skill',
      description: 'A test skill for anime quality',
      rules: 'Full body content here',
      appliesTo: ['myPhase'],
      priority: 1,
    })
    const result = pipeline.buildSkillMenuPrompt('myPhase', 'base', {})
    expect(result).toContain('test-skill: A test skill for anime quality')
    expect(result).not.toContain('Full body content here')
    expect(result).toContain('requestedSkills')
  })

  it('getSkillBodiesById loads only requested skills', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'skill-a',
      description: 'Skill A',
      rules: 'Body A',
      appliesTo: ['myPhase'],
      priority: 1,
    })
    pipeline.registerSharedSkill({
      id: 'skill-b',
      description: 'Skill B',
      rules: 'Body B',
      appliesTo: ['myPhase'],
      priority: 2,
    })
    const result = pipeline.getSkillBodiesById(['skill-a'], 'myPhase', {})
    expect(result).toContain('Body A')
    expect(result).not.toContain('Body B')
  })

  it('getSkillBodiesById returns empty for unknown IDs', () => {
    const pipeline = new TestPipeline(config)
    const result = pipeline.getSkillBodiesById(['nonexistent'], 'myPhase', {})
    expect(result).toBe('')
  })
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
```
预期: 全部 PASS

**Step 3: 运行全部测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
git commit -m "test(pipeline): Skill Discovery 单元测试

验证 buildSkillMenuPrompt 只输出描述菜单不含 body，
getSkillBodiesById 只加载请求的 skill body。"
```

---

## 验证

```bash
# 全部测试
npx vitest run

# 端到端
npm run dev
# → 导演模式 → 选 theatrical 模板 → 生成
# → 控制台应看到:
#   [DirectorPipeline] Skill Discovery: N skills requested: [director-anime-quality-boost, ...]
#   [DirectorPipeline] Design plan: "I will use anime quality boost for..."
# → 管线正常完成，输出质量不降
```

## 技术备注

### 延迟影响

Skill Discovery 增加一次 LLM 调用（~2-4s），但使用 `maxTokens: 2048` 和简化的 prompt（不含图片），延迟较小。总管线时间从 ~110s 增加到 ~114s。

### Fallback 机制

如果 Skill Discovery 失败（LLM 返回异常、超时等），自动 fallback 到原有的全量注入模式。不会因为新功能导致管线崩溃。

### 与 Progressive Disclosure (Task 2-3) 的关系

Progressive Disclosure 改的是 **loader 层**（何时加载 body 到内存），Agent Skill Discovery 改的是 **prompt 层**（何时将 body 放入 system prompt）。两者互补：
- Progressive Disclosure 确保未选中 skill 的 body 不占用内存
- Agent Skill Discovery 确保 LLM 自主决定读取哪些 skill

### 与 selectSkillsFn (Pass 0) 的关系

`selectSkillsFn` 仍然存在，它的职责变为：决定哪些 skill **有资格**被 designAndAssemble 发现。Agent Skill Discovery 是在 `selectSkillsFn` 筛选后的子集上进一步细化。

```
Pass 0: selectSkillsFn 从 19 个 skill 中选出 16 个 activeSkills
Pass 4: Agent Skill Discovery 从 16 个 activeSkills 中请求读取 4 个的完整 body
```

两层筛选确保 system prompt 只包含最相关的 skill body。
