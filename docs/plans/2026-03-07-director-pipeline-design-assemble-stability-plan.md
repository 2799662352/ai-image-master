# DirectorPipeline DesignAndAssemble Stability Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 `DirectorPipeline` 在 `designAndAssemble` 阶段因为重复 skill 注入与脆弱 JSON 恢复导致的 L1/L2/L3 连续失败问题。

**Architecture:** 保持现有 LangGraph `MemorySaver + thread_id + interrupt/Command(resume)` 结构不变，只收敛 Pass 4 的上下文编排和恢复逻辑。第一部分让 `resolveSystemPrompt()` 支持跳过 phase skill 自动注入，使 discovery 结果成为唯一 skill 来源；第二部分把 panel 提取逻辑抽成可测试 helper，统一处理字符串、content 数组、嵌套对象和代码块 JSON，避免 L3 继续依赖脆弱的贪婪正则。实现过程遵循 `@test-driven-development`、分析过程遵循 `@debugging-strategies`，结束前执行 `@verification-before-completion`。

**Tech Stack:** TypeScript, Vitest, Zod, `@langchain/openai`, `@langchain/langgraph`

---

### Task 1: 为 Prompt 构建增加“跳过自动 skill 注入”开关

**Files:**
- Modify: `src/renderer/src/services/pipeline/BasePipeline.ts`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts`

**Step 1: Write the failing test**

在 `BasePipeline.test.ts` 追加一个用例，先定义需要的新参数行为：

```ts
it('buildSystemPrompt can skip automatic skill injection', () => {
  const pipeline = new TestPipeline(config)
  pipeline.registerSharedSkill({
    id: 'skip-me',
    description: 'Should be skipped',
    rules: 'Skill body that should not be appended',
    appliesTo: ['myPhase'],
    priority: 1,
  })

  const result = (pipeline as any).buildSystemPrompt(
    'myPhase',
    'base prompt',
    {},
    { skipSkillInjection: true },
  )

  expect(result).toBe('base prompt')
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
```

Expected: FAIL，因为 `buildSystemPrompt` 还不接受第 4 个参数。

**Step 3: Write minimal implementation**

在 `BasePipeline.ts` 中为 `buildSystemPrompt()` 增加可选参数，在 `DirectorPipeline.ts` 中给 `resolveSystemPrompt()` 透传该参数：

```ts
buildSystemPrompt(
  passName: string,
  basePrompt: string,
  context: Record<string, unknown>,
  options?: { skipSkillInjection?: boolean },
): string {
  if (options?.skipSkillInjection) return basePrompt
  const skills = this.getSkillRulesForPhase(passName, context)
  if (!skills) return basePrompt
  return `${basePrompt}\n\n--- 领域规则 ---\n${skills}`
}
```

```ts
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
  return this.buildSystemPrompt(passName, basePrompt, context, options)
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
```

Expected: PASS，且原有 `Progressive Disclosure` 相关测试继续通过。

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/BasePipeline.ts src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
git commit -m "fix(pipeline): allow skipping automatic skill injection"
```

---

### Task 2: 让 designAndAssemble 只消费 discovery 选中的 skill 规则

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`

**Step 1: Write the failing test**

先在 `DirectorPipeline.recovery.test.ts` 增加一个消息构建 helper 的测试，锁定“不重复注入 skill”这个行为。为避免直接测私有节点，先计划在 `DirectorPipeline.ts` 导出一个小 helper：`buildDesignAndAssembleMessages()`。

新增测试：

```ts
it('buildDesignAndAssembleMessages injects discovered skills only once', () => {
  const messages = (DirectorPipelineModule as any).buildDesignAndAssembleMessages({
    systemPrompt: 'base system prompt',
    userText: 'generate 6 panels',
    discoveredSkillRules: '[Skill:storyboard-visual]\nOnly inject once.',
    designContent: [{ type: 'text', text: 'generate 6 panels' }],
  })

  expect(messages[0]).toEqual({ role: 'system', content: 'base system prompt' })
  expect(JSON.stringify(messages)).toContain('Only inject once.')
  expect(JSON.stringify(messages).match(/Only inject once\./g)).toHaveLength(1)
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
```

Expected: FAIL，因为 helper 还不存在。

**Step 3: Write minimal implementation**

1. 在 `DirectorPipeline.ts` 顶部工具函数区域新增可测试 helper：

```ts
export function buildDesignAndAssembleMessages(params: {
  systemPrompt: string
  userText: string
  discoveredSkillRules: string
  designContent: Array<any>
}): Array<{ role: 'system' | 'assistant' | 'user'; content: any }> {
  const messages: Array<{ role: 'system' | 'assistant' | 'user'; content: any }> = [
    { role: 'system', content: params.systemPrompt },
  ]

  if (params.discoveredSkillRules) {
    messages.push(
      {
        role: 'assistant',
        content: `I've reviewed the available skills and will apply the following domain rules:\n\n${params.discoveredSkillRules}`,
      },
      {
        role: 'user',
        content: 'Good. Now apply these rules and generate the panel designs and prompts.',
      },
    )
  }

  messages.push({ role: 'user', content: params.designContent })
  return messages
}
```

2. 在 `designAndAssembleFn` 中，构建 `baseSystemPrompt` 时显式跳过自动 skill 注入：

```ts
const baseSystemPrompt = self.resolveSystemPrompt(
  'designAndAssemble',
  vars,
  skillContext,
  fallbackPrompt,
  { skipSkillInjection: true },
)
```

3. 用 helper 替代内联 `messages.push(...)` 逻辑，确保 skill rules 只来自 `discoveredSkillRules`。

**Step 4: Run test to verify it passes**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
```

Expected: PASS，测试能证明 discovery 选中的规则只进入消息一次。

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
git commit -m "fix(pipeline): avoid duplicate skill injection in design assemble"
```

---

### Task 3: 抽离统一的 panels 恢复 helper 并替换 L1/L3 脆弱正则

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`

**Step 1: Write the failing test**

在现有 recovery 测试基础上再补 2 个失败用例，覆盖 code fence 和 `content[]` 混合输出：

```ts
it('extracts panels from fenced json blocks', () => {
  const panels = (DirectorPipelineModule as any).extractPanelsFromUnknown(
    '```json\n{"panels":[{"id":1,"prompt":"dramatic silhouette"}]}\n```',
  )

  expect(panels).toEqual([{ id: 1, prompt: 'dramatic silhouette' }])
})

it('extracts panels from message content arrays returned by LLM adapters', () => {
  const panels = (DirectorPipelineModule as any).extractPanelsFromUnknown({
    content: [
      { type: 'reasoning', text: 'thinking...' },
      { type: 'text', text: '```json\n{"panels":[{"id":1,"prompt":"tracking shot"}]}\n```' },
    ],
  })

  expect(panels).toEqual([{ id: 1, prompt: 'tracking shot' }])
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
```

Expected: FAIL，因为当前实现还在 L1/L3 中直接用 `text.match(/\{[\s\S]*"panels".../)`。

**Step 3: Write minimal implementation**

在 `DirectorPipeline.ts` 顶部工具函数区域新增三个 helper，并在 L1/L3 中统一复用：

```ts
export function extractTextFromUnknown(input: unknown): string {
  if (typeof input === 'string') return input
  if (Array.isArray(input)) {
    return input
      .map((item) => extractTextFromUnknown(item))
      .filter(Boolean)
      .join('\n')
  }
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    if (typeof record.text === 'string') return record.text
    if ('content' in record) return extractTextFromUnknown(record.content)
    if ('raw' in record) return extractTextFromUnknown(record.raw)
    if ('result' in record) return extractTextFromUnknown(record.result)
    if (Array.isArray(record.panels)) return JSON.stringify({ panels: record.panels })
  }
  return ''
}
```

```ts
function tryParsePanelsCandidate(candidate: string): any[] | null {
  try {
    const parsed = JSON.parse(candidate)
    return Array.isArray(parsed?.panels) ? parsed.panels : null
  } catch {
    return null
  }
}
```

```ts
export function extractPanelsFromUnknown(input: unknown): any[] | null {
  const text = extractTextFromUnknown(input)
  if (!text) return null

  const direct = tryParsePanelsCandidate(text)
  if (direct) return direct

  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  for (const match of fenced) {
    const parsed = tryParsePanelsCandidate(match[1].trim())
    if (parsed) return parsed
  }

  const panelsMatches = text.match(/\{"panels"\s*:\s*\[[\s\S]*?\]\s*\}/g) || []
  for (const candidate of panelsMatches) {
    const parsed = tryParsePanelsCandidate(candidate)
    if (parsed) return parsed
  }

  return null
}
```

然后替换 L1 与 L3：

```ts
let parsedPanels = (response as any)?.parsed?.panels
if (!parsedPanels?.length) {
  parsedPanels = extractPanelsFromUnknown(response)
}
```

```ts
const parsedPanels = extractPanelsFromUnknown(feedbackResult)
if (parsedPanels?.length) {
  const { panels, prompts } = makePanelsAndPrompts(parsedPanels)
  // ...
}
```

**Step 4: Run test to verify it passes**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
```

Expected: PASS，现有 3 个 recovery 测试和新增 2 个测试全部通过。

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
git commit -m "fix(pipeline): harden panel recovery from llm output"
```

---

### Task 4: 做定向回归验证并确认不破坏 pause/resume 机制

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`

**Step 1: Run targeted pipeline tests**

Run:

```bash
cd temp-ai-image-master-source && npm run test:run -- src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts src/renderer/src/services/pipeline/__tests__/prompt-loader.runtime-skills.test.ts src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts
```

Expected: PASS，证明：
- skill lazy loading 仍然成立
- discovery 只注入一次规则
- recovery helper 可以处理非标准 LLM 输出

**Step 2: Run type check**

Run:

```bash
cd temp-ai-image-master-source && npm run typecheck
```

Expected: PASS，无新的 TypeScript 报错。

**Step 3: Manual verification checklist**

人工验证一次 `DirectorPipeline`：

```text
1. 选择会触发 designAndAssemble 的真实场景输入
2. 观察日志中 Skill Discovery 输出
3. 确认 Pass 4 不再出现 “L1 failed: full schema + raw extraction both empty”
4. 若 L1/L2 失败，确认 L3 不再因简单代码块 JSON 而报 Unterminated string
5. 暂停并恢复一次，确认已有 pause/resume 行为不回归
```

**Step 4: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
git commit -m "test(pipeline): add regression coverage for design assemble stability"
```

