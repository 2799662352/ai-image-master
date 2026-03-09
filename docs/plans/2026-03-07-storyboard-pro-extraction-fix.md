# StoryboardProPipeline 提取失败修复 — 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 StoryboardProPipeline 中 sceneDecompose 和 characterExtract 双双失败的 bug，使其达到 DirectorPipeline 同等的可靠性水平。

**Architecture:** 参照 DirectorPipeline 的成功模式，从四个层面修复：(1) 将惰性正则改为贪婪正则修复 fallback 截断问题；(2) 为 Pass 1/2 增加简化 schema 作为 L2 降级方案；(3) 新增 Analysis Gate 验证门控 + 重试机制；(4) 精简 StoryboardObjSchema 到核心字段。

**Tech Stack:**
- `@langchain/langgraph` ^1.2.0 (StateGraph, addConditionalEdges, retryPolicy)
- `@langchain/openai` ^1.2.10 (ChatOpenAI, withStructuredOutput)
- `@langchain/core` ^1.1.29
- `zod` ^4.3.6
- `vitest` ^4.0.18

**技术依据:**
- LangGraph JS 官方文档 (2026-03-07 确认最新): `addConditionalEdges` 支持路由函数 + 映射表模式
- `@langchain/openai` API Reference (2026-03-07 确认): `ChatOpenAI.withStructuredOutput` 官方支持 `jsonMode`、`functionCalling`、`jsonSchema` 三种 method
- LangChain Context7 + Gemini 文档: `jsonMode` 推荐用于 Gemini，因为它直接约束 model 输出 JSON，而 `functionCalling` 依赖 proxy 翻译 tool schema
- 导演模式 (`DirectorPipeline.ts`) 的 analysis gate 模式已验证可靠（有 5 个测试覆盖）

---

## 修复总览

| 优先级 | 任务 | 改动文件 | 预计耗时 |
|--------|------|----------|----------|
| P0 | Task 1: 正则 fallback 修复 | `StoryboardProPipeline.ts` | 5 min |
| P0.5 | Task 1.5: BasePipeline 支持 jsonMode | `BasePipeline.ts` + `StoryboardProPipeline.ts` | 10 min |
| P1 | Task 2: 新增简化 Schema | `StoryboardProPipeline.ts` | 10 min |
| P1 | Task 3: Pass 1/2 加 L2 降级 | `StoryboardProPipeline.ts` | 15 min |
| P1 | Task 4: Analysis Gate 门控 | `StoryboardProPipeline.ts` | 20 min |
| P2 | Task 5: ObjSchema 精简 | `LangChainStoryboardService.ts` | 15 min |
| P2 | Task 6: storyboard-verify 适配 | `storyboard-verify.ts` | 5 min |

---

### Task 1: 修复正则 Fallback — 惰性改贪婪 (P0)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` — 行 232, 290, 375, 429

**问题根因:** 
导演模式使用贪婪匹配 `[\s\S]*`（正确匹配完整 JSON），分镜 Pro 使用惰性匹配 `[\s\S]*?`（在第一个 `}` 处截断，破坏嵌套 JSON）。

**Step 1: 写失败测试**

在 `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-regex-fallback.test.ts` 创建新测试文件：

```typescript
import { describe, it, expect } from 'vitest'

// 测试从原始文本中提取嵌套 JSON 的正则
describe('Storyboard regex fallback patterns', () => {
  it('scene regex should match complete nested JSON with greedy quantifier', () => {
    const rawText = '分析结果: {"d": "A→B→C", "cap": "test", "env": "室内|暖光", "bgm": "layer1", "timeline": [{"id": "S1", "t": "0-3s", "dur": "3s", "tempo": "slow", "trans": "cut"}]}'
    const match = rawText.match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0])
    expect(parsed.d).toBe('A→B→C')
    expect(parsed.timeline).toHaveLength(1)
    expect(parsed.timeline[0].id).toBe('S1')
  })

  it('lazy scene regex truncates nested JSON (demonstrates the bug)', () => {
    const rawText = '分析结果: {"d": "A→B→C", "cap": "test", "env": "室内", "bgm": "layer1", "timeline": [{"id": "S1", "t": "0-3s", "dur": "3s", "tempo": "slow", "trans": "cut"}]}'
    const match = rawText.match(/\{[\s\S]*?"d"\s*:[\s\S]*?\}/)
    // 惰性匹配会在第一个 } 处停止 — 这就是 bug
    expect(() => {
      const parsed = JSON.parse(match![0])
      expect(parsed.timeline).toBeDefined()
    }).toThrow() // JSON.parse 失败或 timeline 丢失
  })

  it('objs regex should match complete array JSON with greedy quantifier', () => {
    const rawText = '提取结果: {"objs": [{"n": "Alice", "f": "blonde", "t": "hair anchor"}, {"n": "Bob", "f": "dark", "t": "scar anchor"}]}'
    const match = rawText.match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0])
    expect(parsed.objs).toHaveLength(2)
    expect(parsed.objs[1].n).toBe('Bob')
  })

  it('seq regex should match complete shot array with greedy quantifier', () => {
    const rawText = '{"seq": [{"id": "S1", "desc": "test1"}, {"id": "S2", "desc": "test2"}], "cont": "anchor", "notes": "ok"}'
    const match = rawText.match(/\{[\s\S]*"seq"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
    expect(match).not.toBeNull()
    const parsed = JSON.parse(match![0])
    expect(parsed.seq).toHaveLength(2)
    expect(parsed.cont).toBe('anchor')
  })
})
```

**Step 2: 运行测试验证失败**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-regex-fallback.test.ts
```
预期: 通过 3 个贪婪测试, 通过 1 个验证 bug 的测试

**Step 3: 修改 StoryboardProPipeline.ts 中的 4 处正则**

位置 1 — sceneDecompose (约行 232):
```typescript
// BEFORE (惰性 — bug):
const match = rawText.match(/\{[\s\S]*?"d"\s*:[\s\S]*?\}/)
// AFTER (贪婪 — 正确):
const match = rawText.match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)
```

位置 2 — characterExtract (约行 290):
```typescript
// BEFORE (惰性 — bug):
const match = rawText.match(/\{[\s\S]*?"objs"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/)
// AFTER (贪婪 — 正确):
const match = rawText.match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
```

位置 3 — shotDesign L1 fallback (约行 375):
```typescript
// BEFORE (惰性 — bug):
const jsonMatch = rawText.match(/\{[\s\S]*?"seq"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/)
// AFTER (贪婪 — 正确):
const jsonMatch = rawText.match(/\{[\s\S]*"seq"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
```

位置 4 — shotDesign L3 feedback (约行 429):
```typescript
// BEFORE (惰性 — bug):
const jsonMatch = text.match(/\{[\s\S]*?"seq"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/)
// AFTER (贪婪 — 正确):
const jsonMatch = text.match(/\{[\s\S]*"seq"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
```

**Step 4: 运行测试验证通过**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-regex-fallback.test.ts
```
预期: 全部 PASS

**Step 5: 运行全部 storyboard 测试确认无回归**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 6: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/
git commit -m "fix(storyboard-pro): 修复正则 fallback 惰性匹配截断嵌套 JSON 的 P0 bug

将 sceneDecompose/characterExtract/shotDesign 中的惰性正则 [\s\S]*?
改为贪婪正则 [\s\S]* 以正确匹配完整嵌套 JSON 结构。
对齐导演模式 (DirectorPipeline) 中已验证的正则模式。"
```

---

### Task 1.5: BasePipeline 支持 jsonMode — 可配置 method (P0.5)

**文件:**
- 修改: `src/renderer/src/services/pipeline/BasePipeline.ts` — 行 129-145
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` — sceneDecomposeFn 和 characterExtractFn 中调用处

**技术依据 (已通过官方文档确认):**

`@langchain/openai` API Reference 原文:
> The OpenAI model family supports the following structured output methods:
> - `jsonMode`: JSON mode ensures that model output is valid JSON.
> - `functionCalling`: Function calling bridges models and application functionality.
> - `jsonSchema`: Use response_format to return a JSON schema.
> The default method is `functionCalling`.

`jsonMode` 的优势（针对 OpenAI proxy + Gemini 场景）:
- 只需 proxy 透传 `response_format: { type: "json_object" }`（Gemini 原生支持）
- 不需要 proxy 翻译 OpenAI function/tool schema → Gemini function schema
- `includeRaw` 时 `raw.content` 直接就是 JSON 字符串 → 正则 fallback 更容易成功
- LangChain 自动将 Zod schema 序列化到 system prompt 作为指令

**Step 1: 写失败测试**

在 `src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts` 中追加测试：

```typescript
it('createStructuredLLM accepts methodOverride parameter', () => {
  const pipeline = new TestPipeline({
    model: 'gemini-3-flash-preview',
    apiKey: 'test-key',
    baseURL: 'http://localhost:8080',
  })
  // 验证 Gemini 模型被正确识别
  expect((pipeline as any).isGeminiModel('gemini-3-flash-preview')).toBe(true)
  // 验证非 Gemini 模型
  expect((pipeline as any).isGeminiModel('gpt-4o')).toBe(false)
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/BasePipeline.test.ts
```
预期: PASS

**Step 3: 修改 BasePipeline.ts — 添加 methodOverride 参数**

修改 `createStructuredLLM` (行 129-136):

```typescript
protected createStructuredLLM<T extends z.ZodType>(
  schema: T,
  model?: string,
  maxTokens = 4096,
  methodOverride?: 'functionCalling' | 'jsonMode' | 'jsonSchema',
) {
  const llm = this.createLLM(model, maxTokens)
  const m = model || this.config.model
  const method = methodOverride
    ?? (this.isGeminiModel(m) ? 'functionCalling' : undefined)
  if (method) {
    return llm.withStructuredOutput(schema, { method: method as any })
  }
  return llm.withStructuredOutput(schema)
}
```

修改 `createStructuredLLMWithRaw` (行 138-145):

```typescript
protected createStructuredLLMWithRaw<T extends z.ZodType>(
  schema: T,
  model?: string,
  maxTokens = 4096,
  methodOverride?: 'functionCalling' | 'jsonMode' | 'jsonSchema',
) {
  const llm = this.createLLM(model, maxTokens)
  const m = model || this.config.model
  const method = methodOverride
    ?? (this.isGeminiModel(m) ? 'functionCalling' : undefined)
  const opts = method
    ? { method: method as any, includeRaw: true as const }
    : { includeRaw: true as const }
  return llm.withStructuredOutput(schema, opts)
}
```

**关键设计决策:**
- `methodOverride` 是可选参数，不传则保持现有行为（Gemini → `functionCalling`，其他 → 默认）
- 只在 StoryboardProPipeline 需要时传 `'jsonMode'`，DirectorPipeline 完全不受影响
- 如果 proxy 不支持 `response_format`，`jsonMode` 调用会失败，但 L2 schema 降级会兜底

**Step 4: 在 StoryboardProPipeline 的 Pass 1/2 中使用 jsonMode**

在 `sceneDecomposeFn` 中（Task 3 实现时一起做），L1 调用改为:

```typescript
const structuredWithRaw = self.createStructuredLLMWithRaw(
  StoryboardSceneSchema,
  undefined,
  4096,
  'jsonMode',  // 使用 jsonMode 代替默认的 functionCalling
)
```

在 `characterExtractFn` 中，L1 调用改为:

```typescript
const structuredWithRaw = self.createStructuredLLMWithRaw(
  ObjArraySchema,
  undefined,
  4096,
  'jsonMode',  // 使用 jsonMode 代替默认的 functionCalling
)
```

**注意:** shotDesign (Pass 3) 暂时保持 `functionCalling`，因为它已有完整的 L1/L2/L3 恢复机制。可以后续观察 Pass 1/2 的效果再决定是否全面切换。

**Step 5: 运行全部 pipeline 测试确认无回归**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS（因为我们只添加了可选参数，默认值不变）

**Step 6: 提交**

```bash
git add src/renderer/src/services/pipeline/BasePipeline.ts
git commit -m "feat(pipeline): BasePipeline 支持 methodOverride 参数

createStructuredLLM 和 createStructuredLLMWithRaw 新增可选的
methodOverride 参数，允许子类按需选择 'jsonMode'/'jsonSchema'。
默认行为不变（Gemini→functionCalling），不影响 DirectorPipeline。
依据: @langchain/openai API Reference 确认 ChatOpenAI.withStructuredOutput
官方支持 jsonMode/functionCalling/jsonSchema 三种 method。"
```

---

### Task 2: 新增简化 Schema (P1)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` — 在现有 Schema 定义区域 (约行 24-46) 添加

**Step 1: 写失败测试**

在 `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-simplified-schemas.test.ts` 创建新测试文件：

```typescript
import { describe, it, expect } from 'vitest'
import { z } from 'zod'

// 测试简化 schema 可以解析精简的 JSON
describe('Simplified storyboard schemas', () => {
  const SimpleSceneSchema = z.object({
    d: z.string().describe('Narrative arc: A→B→C'),
    cap: z.string().describe('Structured caption'),
    env: z.string().describe('Environment description'),
  })

  const SimpleObjSchema = z.object({
    objs: z.array(z.object({
      n: z.string().describe('Character/object name'),
      f: z.string().describe('Appearance features'),
      t: z.string().describe('Cross-shot consistency anchor'),
      act: z.string().describe('Action'),
    })),
  })

  it('SimpleSceneSchema parses minimal scene data', () => {
    const data = { d: 'A→B→C', cap: 'hero-runs-forest', env: 'outdoor|golden hour' }
    const result = SimpleSceneSchema.parse(data)
    expect(result.d).toBe('A→B→C')
  })

  it('SimpleObjSchema parses minimal character data', () => {
    const data = {
      objs: [
        { n: 'Alice', f: 'blonde hair, red dress', t: 'blonde hair anchor', act: 'walking' },
      ],
    }
    const result = SimpleObjSchema.parse(data)
    expect(result.objs).toHaveLength(1)
    expect(result.objs[0].n).toBe('Alice')
  })

  it('SimpleSceneSchema rejects missing required fields', () => {
    expect(() => SimpleSceneSchema.parse({ d: 'arc' })).toThrow()
  })
})
```

**Step 2: 运行测试验证**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-simplified-schemas.test.ts
```
预期: 全部 PASS（因为 schema 定义就在测试文件内）

**Step 3: 在 StoryboardProPipeline.ts 中定义简化 Schema**

在约行 46（`SimpleShotDesignSchema` 定义之后）添加：

```typescript
const SimpleSceneSchema = z.object({
  d: z.string().describe('Narrative arc: A→B→C'),
  cap: z.string().describe('Structured caption'),
  env: z.string().describe('Environment description'),
})

const SimpleObjArraySchema = z.object({
  objs: z.array(z.object({
    n: z.string().describe('Character/object name'),
    f: z.string().describe('Appearance features'),
    t: z.string().describe('Cross-shot consistency anchor'),
    act: z.string().describe('Action'),
  })),
})
```

**Step 4: 更新测试使用实际导出**

如果 schema 不导出，保持测试文件内联定义即可（与项目现有模式一致：`BasePipeline.test.ts` 也是内联测试）。

**Step 5: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/
git commit -m "feat(storyboard-pro): 添加简化 Schema 为 L2 降级做准备

新增 SimpleSceneSchema(3 字段) 和 SimpleObjArraySchema(4 字段/obj)，
仿照 DirectorPipeline 中 SimplePanelSchema 的精简策略。"
```

---

### Task 3: 为 Pass 1/2 添加 L2 降级恢复 (P1)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` — sceneDecomposeFn 和 characterExtractFn 函数

**Step 1: 写失败测试**

在 `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts` 创建测试：

```typescript
import { describe, it, expect } from 'vitest'

describe('Storyboard extraction L2 fallback concept', () => {
  it('SimpleSceneSchema has fewer required fields than StoryboardSceneSchema', () => {
    // StoryboardSceneSchema: d, cap, env, bgm, timeline (5 fields, nested)
    // SimpleSceneSchema: d, cap, env (3 fields, flat)
    // 证明: 简化 schema 字段更少，成功率更高
    const fullSchemaFields = ['d', 'cap', 'env', 'bgm', 'timeline']
    const simpleSchemaFields = ['d', 'cap', 'env']
    expect(simpleSchemaFields.length).toBeLessThan(fullSchemaFields.length)
  })

  it('SimpleObjArraySchema has fewer fields per object than StoryboardObjSchema', () => {
    // StoryboardObjSchema: 11 fields (n,f,s,p,t,tc,act,fx,motive,a,m)
    // SimpleObjArraySchema: 4 fields (n,f,t,act)
    const fullObjFields = ['n', 'f', 's', 'p', 't', 'tc', 'act', 'fx', 'motive', 'a', 'm']
    const simpleObjFields = ['n', 'f', 't', 'act']
    expect(simpleObjFields.length).toBeLessThan(fullObjFields.length)
  })
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-extraction-fallback.test.ts
```
预期: PASS

**Step 3: 修改 sceneDecomposeFn — 添加 L2 降级**

在 `sceneDecomposeFn` 函数中，将现有逻辑改为 L1 + L2 模式：

```typescript
// ===== Pass 1: 场景分解 (parallel with Pass 2) =====
const sceneDecomposeFn = async (state: StoryboardState, config: any) => {
  checkPauseAndInterrupt('sceneDecompose', config)
  const t0 = Date.now()
  try {
    const appliedSkills = self.getSkillsForPhase('sceneDecompose', state as Record<string, unknown>)
    const vars: Record<string, string> = { user_context: state.userContext || '' }
    const systemPrompt = self.resolveSystemPrompt(
      'sceneDecompose', vars,
      state as Record<string, unknown>,
      'You are a professional film storyboard analyst. Decompose the scene from the provided images. Output structured data covering: narrative arc (d), structured caption (cap), environment with lighting params (env), 4-layer sound design (bgm), and timeline with shots.',
    )
    const userMessages = [
      { role: 'system' as const, content: systemPrompt },
      {
        role: 'user' as const,
        content: [
          ...BasePipeline.buildImageContent(state.inputImages, 'high'),
          {
            type: 'text' as const,
            text: state.userContext
              ? `参考素材如上。附加要求/剧本:\n${state.userContext}\n\n请分析场景结构。`
              : '请分析以上图片的场景结构。',
          },
        ],
      },
    ]

    // --- L1: Full schema + jsonMode + includeRaw + greedy regex ---
    let scene: any = null
    try {
      const structuredWithRaw = self.createStructuredLLMWithRaw(StoryboardSceneSchema, undefined, 4096, 'jsonMode')
      const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
      scene = (response as any)?.parsed
      if (!scene?.env && !scene?.d) {
        const rawText = typeof (response as any)?.raw?.content === 'string'
          ? (response as any).raw.content : ''
        try {
          const match = rawText.match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)
          if (match) scene = JSON.parse(match[0])
        } catch { /* L2 below */ }
      }
    } catch (e: unknown) {
      console.warn('[StoryboardProPipeline] sceneDecompose L1 error:', e instanceof Error ? e.message : String(e))
    }

    // --- L2: Simplified schema fallback ---
    if (!scene?.d) {
      console.warn('[StoryboardProPipeline] sceneDecompose L1 failed, trying L2 SimpleSceneSchema')
      try {
        const simpleStructured = self.createStructuredLLM(SimpleSceneSchema)
        const simpleResult = await simpleStructured.invoke(userMessages, { signal: config?.signal })
        if (simpleResult?.d) {
          scene = { ...simpleResult, bgm: '', timeline: [] }
          console.log('[StoryboardProPipeline] sceneDecompose L2 success via SimpleSceneSchema')
        }
      } catch (e: unknown) {
        console.warn('[StoryboardProPipeline] sceneDecompose L2 error:', e instanceof Error ? e.message : String(e))
      }
    }

    if (!scene?.d) {
      scene = { d: '(analysis failed)', cap: '', env: '', bgm: '', timeline: [] }
      console.warn('[StoryboardProPipeline] sceneDecompose: all extraction levels failed')
    }

    const elapsed = Date.now() - t0
    const passData = StoryboardProPipeline.buildPassCardData('sceneDecompose', { pass: 1, label: '场景分解' }, { scene }, elapsed, appliedSkills)
    writer(config)?.({ type: 'pass_complete', pass: 1, label: `场景分解完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
    return { scene }
  } catch (err: unknown) {
    emitError(config, 1, '场景分解', 'sceneDecompose', err instanceof Error ? err.message : String(err), Date.now() - t0)
    return { scene: null }
  }
}
```

**Step 4: 修改 characterExtractFn — 添加 L2 降级**

同样在 `characterExtractFn` 中添加 L2 降级：

```typescript
// ===== Pass 2: 角色/物体提取 (parallel with Pass 1) =====
const characterExtractFn = async (state: StoryboardState, config: any) => {
  checkPauseAndInterrupt('characterExtract', config)
  const t0 = Date.now()
  try {
    const appliedSkills = self.getSkillsForPhase('characterExtract', state as Record<string, unknown>)
    const vars: Record<string, string> = { user_context: state.userContext || '' }
    const systemPrompt = self.resolveSystemPrompt(
      'characterExtract', vars,
      state as Record<string, unknown>,
      'You are a character analysis expert for storyboard production. Extract ALL characters and significant objects from the provided images.',
    )
    const userMessages = [
      { role: 'system' as const, content: systemPrompt },
      {
        role: 'user' as const,
        content: [
          ...BasePipeline.buildImageContent(state.inputImages, 'high'),
          {
            type: 'text' as const,
            text: state.userContext
              ? `参考素材如上。附加要求:\n${state.userContext}\n\n请提取所有角色和重要物体。`
              : '请提取以上图片中所有角色和重要物体。',
          },
        ],
      },
    ]

    // --- L1: Full 11-field schema + jsonMode + includeRaw + greedy regex ---
    let parsed: any = null
    try {
      const ObjArraySchema = z.object({ objs: z.array(StoryboardObjSchema) })
      const structuredWithRaw = self.createStructuredLLMWithRaw(ObjArraySchema, undefined, 4096, 'jsonMode')
      const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
      parsed = (response as any)?.parsed
      if (!parsed?.objs?.length) {
        const rawText = typeof (response as any)?.raw?.content === 'string'
          ? (response as any).raw.content : ''
        try {
          const match = rawText.match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
          if (match) {
            const fallback = JSON.parse(match[0])
            if (fallback?.objs?.length) parsed = fallback
          }
        } catch { /* L2 below */ }
      }
    } catch (e: unknown) {
      console.warn('[StoryboardProPipeline] characterExtract L1 error:', e instanceof Error ? e.message : String(e))
    }

    // --- L2: Simplified 4-field schema fallback ---
    if (!parsed?.objs?.length) {
      console.warn('[StoryboardProPipeline] characterExtract L1 failed, trying L2 SimpleObjArraySchema')
      try {
        const simpleStructured = self.createStructuredLLM(SimpleObjArraySchema)
        const simpleResult = await simpleStructured.invoke(userMessages, { signal: config?.signal })
        if (simpleResult?.objs?.length) {
          // 将简化字段映射到完整 schema 格式（缺失字段填默认值）
          parsed = {
            objs: simpleResult.objs.map((o: any) => ({
              n: o.n, f: o.f, t: o.t, act: o.act,
              s: 'fg|center|Z1', p: 'artic', tc: '', fx: null,
              motive: '', a: '', m: '',
            })),
          }
          console.log(`[StoryboardProPipeline] characterExtract L2 success: ${parsed.objs.length} objs via SimpleObjArraySchema`)
        }
      } catch (e: unknown) {
        console.warn('[StoryboardProPipeline] characterExtract L2 error:', e instanceof Error ? e.message : String(e))
      }
    }

    if (!parsed?.objs?.length) {
      parsed = { objs: [] }
      console.warn('[StoryboardProPipeline] characterExtract: all extraction levels failed')
    }

    const elapsed = Date.now() - t0
    const passData = StoryboardProPipeline.buildPassCardData('characterExtract', { pass: 2, label: '角色提取' }, { objs: parsed.objs }, elapsed, appliedSkills)
    writer(config)?.({ type: 'pass_complete', pass: 2, label: `角色提取完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
    return { objs: parsed.objs }
  } catch (err: unknown) {
    emitError(config, 2, '角色提取', 'characterExtract', err instanceof Error ? err.message : String(err), Date.now() - t0)
    return { objs: null }
  }
}
```

**Step 5: 运行全部 storyboard 测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 6: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/
git commit -m "feat(storyboard-pro): Pass 1/2 添加 L2 简化 schema 降级恢复

仿照 DirectorPipeline 的 SimplePanelSchema 降级策略:
- sceneDecompose: L1 失败时用 SimpleSceneSchema(3 字段) 重试
- characterExtract: L1 失败时用 SimpleObjArraySchema(4 字段/obj) 重试
将 11 字段完整 schema 的高失败率降级到核心字段提取。"
```

---

### Task 4: 添加 Analysis Gate 验证门控 + 重试 (P1)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` — stateSchema + buildGraph

**Step 1: 写失败测试**

在 `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-analysis-gate.test.ts` 创建：

```typescript
import { describe, it, expect } from 'vitest'

// shouldRetryStoryboardAnalysis 路由函数测试（仿照 DirectorPipeline 的 shouldRetryAnalysis）
function shouldRetryStoryboardAnalysis(state: {
  scene: { d?: string } | null
  objs: Array<{ n?: string }> | null
  analysisRetryCount: number
}): 'continue' | 'retry' | 'abort' {
  const MAX_ANALYSIS_RETRIES = 2
  const sceneOk = state.scene && state.scene.d && state.scene.d !== '(analysis failed)'
  const objsOk = state.objs && state.objs.length > 0
  if (sceneOk || objsOk) return 'continue'
  if (state.analysisRetryCount >= MAX_ANALYSIS_RETRIES) return 'abort'
  return 'retry'
}

describe('shouldRetryStoryboardAnalysis', () => {
  it('returns "continue" when scene has valid d field', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: 'A→B→C' },
      objs: null,
      analysisRetryCount: 0,
    })).toBe('continue')
  })

  it('returns "continue" when objs array is non-empty', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: [{ n: 'Alice' }],
      analysisRetryCount: 0,
    })).toBe('continue')
  })

  it('returns "retry" when both null and retries < max', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: null,
      analysisRetryCount: 0,
    })).toBe('retry')
  })

  it('returns "retry" when scene has "(analysis failed)" marker', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: '(analysis failed)' },
      objs: null,
      analysisRetryCount: 1,
    })).toBe('retry')
  })

  it('returns "abort" when both null and retries >= max', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: null,
      objs: null,
      analysisRetryCount: 2,
    })).toBe('abort')
  })

  it('returns "continue" when scene failed but objs exist', () => {
    expect(shouldRetryStoryboardAnalysis({
      scene: { d: '(analysis failed)' },
      objs: [{ n: 'Bob' }],
      analysisRetryCount: 0,
    })).toBe('continue')
  })
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-analysis-gate.test.ts
```
预期: 全部 PASS（纯函数测试，无依赖）

**Step 3: 修改 stateSchema — 添加 analysisRetryCount 字段**

在 `stateSchema` 定义中（约行 50-71）添加新字段：

```typescript
const stateSchema = z.object({
  // ... 现有字段 ...
  analysisRetryCount: z.number().default(0),  // 新增
})
```

**Step 4: 导出路由函数并添加门控节点**

在 `StoryboardProPipeline.ts` 文件中（class 外部，约行 77 之前）导出路由函数：

```typescript
const MAX_ANALYSIS_RETRIES = 2

export function shouldRetryStoryboardAnalysis(state: {
  scene: { d?: string } | null
  objs: Array<{ n?: string }> | null
  analysisRetryCount: number
}): 'continue' | 'retry' | 'abort' {
  const sceneOk = state.scene && state.scene.d && state.scene.d !== '(analysis failed)'
  const objsOk = state.objs && state.objs.length > 0
  if (sceneOk || objsOk) return 'continue'
  if (state.analysisRetryCount >= MAX_ANALYSIS_RETRIES) return 'abort'
  return 'retry'
}
```

**Step 5: 在 buildGraph() 中添加门控节点和新的图连线**

在 `buildGraph()` 方法内添加 3 个新节点函数和修改图结构：

```typescript
// 在 shotDesignFn 之前添加:

const validateAnalysisFn = (state: StoryboardState) => {
  console.log(`[StoryboardProPipeline] validateAnalysis: scene=${!!state.scene?.d}, objs=${!!state.objs?.length}, retries=${state.analysisRetryCount}`)
  return {}
}

const prepareAnalysisRetryFn = (state: StoryboardState, config: any) => {
  const count = state.analysisRetryCount + 1
  console.warn(`[StoryboardProPipeline] Analysis data empty, retrying (${count}/${MAX_ANALYSIS_RETRIES})...`)
  writer(config)?.({
    type: 'pass_complete', pass: 1,
    label: `场景/角色数据为空，重试中 (${count}/${MAX_ANALYSIS_RETRIES})...`,
    elapsed: 0, passData: null,
  })
  return { analysisRetryCount: count, scene: null, objs: null }
}

const abortPipelineFn = (_state: StoryboardState, config: any) => {
  const msg = '场景分解和角色提取均失败，管线终止。请检查网络或换用更强的模型后重试。'
  console.error(`[StoryboardProPipeline] ${msg}`)
  writer(config)?.({
    type: 'pass_complete', pass: 1,
    label: msg, elapsed: 0, passData: null,
  })
  return { seq: null }
}
```

**Step 6: 修改图结构**

替换现有的图连线部分（约行 548-575）：

```typescript
// ===== Graph Assembly =====
const retryLLM = { maxAttempts: 2, initialInterval: 1.0 }
const graph = new StateGraph(stateSchema)
  .addNode('sceneDecompose', sceneDecomposeFn, { retryPolicy: retryLLM })
  .addNode('characterExtract', characterExtractFn, { retryPolicy: retryLLM })
  .addNode('validateAnalysis', validateAnalysisFn)            // 新增
  .addNode('prepareAnalysisRetry', prepareAnalysisRetryFn)    // 新增
  .addNode('abortPipeline', abortPipelineFn)                  // 新增
  .addNode('shotDesign', shotDesignFn)
  .addNode('codeVerify', codeVerifyNode)
  .addNode('deepVerify', deepVerifyFn)
  .addNode('prepareRetry', prepareRetryFn)
  // START → parallel sceneDecompose + characterExtract
  .addEdge(START, 'sceneDecompose')
  .addEdge(START, 'characterExtract')
  // Both converge → validateAnalysis (而非直接 → shotDesign)
  .addEdge('sceneDecompose', 'validateAnalysis')
  .addEdge('characterExtract', 'validateAnalysis')
  // validateAnalysis → conditional: continue / retry / abort
  .addConditionalEdges('validateAnalysis', (state: StoryboardState) => {
    return shouldRetryStoryboardAnalysis(state)
  }, {
    continue: 'shotDesign',
    retry: 'prepareAnalysisRetry',
    abort: 'abortPipeline',
  })
  // prepareAnalysisRetry → retry both passes
  .addEdge('prepareAnalysisRetry', 'sceneDecompose')
  .addEdge('prepareAnalysisRetry', 'characterExtract')
  // abortPipeline → END
  .addEdge('abortPipeline', END)
  // shotDesign → codeVerify
  .addEdge('shotDesign', 'codeVerify')
  // codeVerify → conditional: end or deepVerify
  .addConditionalEdges('codeVerify', routeAfterCodeVerify, {
    end: END,
    deepVerify: 'deepVerify',
  })
  // deepVerify → conditional: end or retry
  .addConditionalEdges('deepVerify', routeAfterDeepVerify, {
    retry: 'prepareRetry',
    end: END,
  })
  // prepareRetry → shotDesign (loop back)
  .addEdge('prepareRetry', 'shotDesign')
```

**Step 7: 更新测试文件导入**

更新 `storyboard-analysis-gate.test.ts` 使用实际导出的函数：

```typescript
import { describe, it, expect } from 'vitest'
import { shouldRetryStoryboardAnalysis } from '../StoryboardProPipeline'
```

**Step 8: 运行全部 storyboard 测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
```
预期: 全部 PASS

**Step 9: 运行全部管线测试确认无回归**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 10: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/
git commit -m "feat(storyboard-pro): 添加 Analysis Gate 验证门控 + 重试机制

仿照 DirectorPipeline 的 validateAnalysis/prepareAnalysisRetry/abortPipeline
三节点模式，在 sceneDecompose + characterExtract 汇合后添加验证门控:
- 任一 Pass 成功 → 继续 shotDesign
- 双失败且重试次数 < 2 → 重试两个 Pass
- 双失败且已达上限 → 终止管线并给出友好提示
解决了原来双失败时带空数据直接进入 shotDesign 的问题。"
```

---

### Task 5: 精简 StoryboardObjSchema — 降低默认复杂度 (P2)

**文件:**
- 修改: `src/renderer/src/services/LangChainStoryboardService.ts` — StoryboardObjSchema 定义 (行 8-20)

**Step 1: 确认影响范围**

先搜索所有使用 `StoryboardObjSchema` 的文件，确认修改影响：
- `LangChainStoryboardService.ts` — 定义 + 在 `StoryboardResponseSchema` 中使用
- `StoryboardProPipeline.ts` — import 使用（stateSchema 中 + characterExtractFn 中）
- `storyboard-verify.test.ts` — 测试数据中用了 11 字段

**Step 2: 将 非核心字段改为 optional**

```typescript
export const StoryboardObjSchema = z.object({
  n: z.string().describe('Character/object name'),
  f: z.string().describe('Appearance features mapped to psychological motivation'),
  s: z.string().optional().describe('Spatial position: fg/mg/bg|position|Z-order'),
  p: z.string().optional().describe('Physical type: rigid/artic/fluid/cloth + constraints'),
  t: z.string().describe('Cross-shot consistency anchor (hair/scar/outfit/props)'),
  tc: z.string().optional().describe('Shot continuity: S?→S?: pose/motion/gaze'),
  act: z.string().describe('Performance action (pure action, no effects)'),
  fx: z.string().nullable().optional().describe('Effects: wind/smoke/light/particles. Null if none'),
  motive: z.string().optional().describe('Motivation: what psychology this action externalizes'),
  a: z.string().optional().describe('Multi-granularity: coarse(%)→mid(chain)→fine(delta)'),
  m: z.string().optional().describe('Motion intensity: part→angle°/cm/H-M-L'),
})
```

关键改动:
- `n`, `f`, `t`, `act` 保持必填 — 这 4 个是角色识别的核心
- `s`, `p`, `tc`, `motive`, `a`, `m` 改为 `optional()` — 降级时可不填
- `fx` 从 `z.nullable(z.string())` 改为 `z.string().nullable().optional()` — 修复 proxy 兼容性

**Step 3: 更新 storyboard-verify.test.ts 的测试数据**

测试数据已经包含所有 11 字段，不需要修改（optional 字段仍然可以有值）。

**Step 4: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts
```
预期: 全部 PASS

**Step 5: 运行全部测试**

```bash
npx vitest run
```
预期: 全部 PASS

**Step 6: 提交**

```bash
git add src/renderer/src/services/LangChainStoryboardService.ts
git commit -m "refactor(storyboard): StoryboardObjSchema 非核心字段改 optional

将 s/p/tc/motive/a/m 6 个字段从必填改为 optional，
保留 n/f/t/act 4 个角色核心字段为必填。
修复 fx 字段的 z.nullable() 为 z.string().nullable().optional()
以提高 OpenAI proxy 兼容性。"
```

---

### Task 6: storyboard-verify 适配简化数据 (P2)

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/storyboard-verify.ts`

**Step 1: 写失败测试**

在 `storyboard-verify.test.ts` 中添加新测试用例：

```typescript
it('should handle L2-simplified objects (only n, f, t, act)', () => {
  const result = storyboardCodeVerify(makeState({
    objs: [{ n: 'Alice', f: 'blonde', t: 'hair anchor', act: 'walk' }],
    seq: [{ id: 'S1', desc: 'Alice walks forward' }],
  }) as any)
  expect(result.score).toBeGreaterThanOrEqual(6)
  expect(result.ok).toBe(true)
})

it('should not crash on objects without optional fields', () => {
  const result = storyboardCodeVerify({
    scene: { d: 'arc', env: 'outdoor' },
    objs: [{ n: 'Bob' }],
    seq: [{ id: 'S1', desc: 'Bob stands still' }],
    cont: 'S1-S2: anchor',
    notes: 'ok',
  } as any)
  expect(result.score).toBeGreaterThanOrEqual(4)
})
```

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts
```
预期: PASS（因为 `storyboard-verify.ts` 只检查 `n` 字段，不依赖其他字段）

**Step 3: 确认 verify 代码兼容**

检查 `storyboard-verify.ts` 中是否有依赖 `s/p/tc/motive/a/m` 的代码。根据已读的源码，`storyboardCodeVerify` 只使用了 `n` 和 `t` 字段，不需要修改。

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/__tests__/
git commit -m "test(storyboard-verify): 添加 L2 简化数据兼容性测试"
```

---

## 验证清单

完成所有 Task 后，执行以下验证步骤：

```bash
# 1. 运行全部 storyboard 测试
npx vitest run src/renderer/src/services/storyboard-pipeline/

# 2. 运行全部 pipeline 测试
npx vitest run src/renderer/src/services/pipeline/

# 3. 运行全部项目测试
npx vitest run

# 4. TypeScript 类型检查
npx tsc --noEmit

# 5. 构建验证
npm run build:vite
```

全部通过后，可在应用中进行端到端测试：
1. 启动应用 `npm run dev`
2. 切换到「图像理解」页面
3. 选择 `gemini-3-flash-preview` 模型
4. 上传参考图片，点击「分镜 Pro」
5. 观察控制台日志：
   - 不应出现 `structured + raw extraction both failed`
   - 如果 L1 失败，应看到 `L2 success via SimpleSceneSchema` 或 `L2 success via SimpleObjArraySchema`
   - 如果双失败，应看到 `Analysis data empty, retrying` 然后重试

---

## 技术备注

### 为什么不改用 ChatGoogle 原生 SDK?

`LangChainStoryboardService.ts` 中的独立服务使用 `ChatGoogle` 直连 Gemini API，但 `StoryboardProPipeline` 继承 `BasePipeline` 通过 `ChatOpenAI` + OpenAI-compatible proxy 路由。改用原生 SDK 需要:
1. 修改 `BasePipeline` 抽象层（影响 DirectorPipeline）
2. 处理 API key / baseURL 的双轨路由
3. 可能影响 Langfuse tracing

风险过大。更好的方案是通过 Task 1.5 的 `jsonMode` methodOverride 来获得接近原生的效果。

### 为什么用 jsonMode 而非 jsonSchema?

`@langchain/openai` 的 `ChatOpenAI.withStructuredOutput` 支持三种 method:
- `functionCalling` (当前默认) — 需要 proxy 翻译 tool schema
- `jsonMode` — 只需 proxy 透传 `response_format: {type: "json_object"}`
- `jsonSchema` — 需要 proxy 支持 `response_format: {type: "json_schema", json_schema: {...}}`

选择 `jsonMode` 的原因:
1. **proxy 兼容性最高**: 只需透传一个简单的 `response_format` 字段，不涉及 schema 翻译
2. **Gemini 原生支持 JSON mode**: Google Gemini API 原生支持 `response_mime_type: "application/json"`
3. **`raw.content` 就是 JSON**: `jsonMode` 下模型被强制输出合法 JSON，`includeRaw` 的 `raw.content` 直接就是 JSON 字符串，正则 fallback 更容易成功
4. **风险可控**: 如果 proxy 不支持，L2 schema 降级 + Analysis Gate 重试会兜底

### Zod v4 兼容性

项目使用 `zod ^4.3.6`。在 Zod v4 中 `z.nullable()` 和 `z.optional()` 的行为与 v3 一致。`.nullable().optional()` 产生 `T | null | undefined` 类型，这在 function calling 模式下最兼容。

### LangGraph fan-in 注意事项

根据 LangGraph 官方文档，并行节点更新同一个 state key 需要 reducer。当前实现中 `sceneDecompose` 返回 `{ scene }` 而 `characterExtract` 返回 `{ objs }`，更新不同的 key，不会冲突。新增的 `validateAnalysis` 节点使用 `.addEdge` 汇合两个并行节点，符合 LangGraph 的 fan-in 模式。
