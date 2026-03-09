# DirectorPipeline + StoryboardProPipeline Verify Unwrap 修复

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复 verifyConsistency / deepVerify 中模型返回嵌套/变体 JSON 结构导致 Zod 解析失败的问题。

**Architecture:** (1) 两个 verify 函数从 `createStructuredLLM` 改为 `createStructuredLLMWithRaw` 获取 raw fallback；(2) 添加 `unwrapVerifyResult` 辅助函数，将模型的自定义嵌套格式映射到 `VerifySchema` 的 `{ score, ok, issues }` 格式。

**Tech Stack:** `@langchain/openai` ^1.2.10, `zod` ^4.3.6, `vitest` ^4.0.18

**根因（已通过端到端日志确认）:**
模型用 `jsonMode` 返回了自定义结构:
```json
{ "verification_result": { "overall_score": 6, "status": "FAIL", "dimensions": {...}, "deductions": [...] } }
```
但 `VerifySchema` 期望 `{ score: number, ok: boolean, issues: string[] }` 在根级别。
Zod 在根级找 `score` → `undefined` → 抛 `OUTPUT_PARSING_FAILURE`。

**模型输出字段映射:**
| 模型返回路径 | VerifySchema 字段 | 映射逻辑 |
|-------------|------------------|---------|
| `verification_result.overall_score` 或 `overall_score` 或 `score` | `score` | 取第一个找到的数字 |
| `verification_result.status !== "FAIL"` 或 `score >= 6` | `ok` | 从 status 或 score 推导 |
| `dimensions.*.issues[]` + `deductions[]` + `issues[]` | `issues` | 扁平化合并所有 issue 字符串 |

---

### Task 1: 添加 unwrapVerifyResult 辅助函数 + 测试

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts` — 在 `pickLowItems` 函数附近添加
- 测试: `src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts`

**Step 1: 在测试文件末尾追加测试**

在 `src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts` 末尾追加:

```typescript
describe('unwrapVerifyResult', () => {
  // 内联定义，与实际函数逻辑一致
  function unwrapVerifyResult(data: any): { score: number; ok: boolean; issues: string[] } | null {
    if (!data || typeof data !== 'object') return null

    // 已经是正确格式
    if (typeof data.score === 'number' && typeof data.ok === 'boolean') return data

    // 从嵌套 key 中提取 (verification_result, result, verify 等)
    const inner = data.verification_result || data.result || data.verify || data.report
    const source = inner || data

    const score = typeof source.overall_score === 'number' ? source.overall_score
      : typeof source.score === 'number' ? source.score : null
    if (score === null) return null

    // 收集所有 issues
    const issues: string[] = []
    if (Array.isArray(source.issues)) {
      issues.push(...source.issues.filter((i: any) => typeof i === 'string'))
    }
    if (Array.isArray(source.deductions)) {
      issues.push(...source.deductions.filter((i: any) => typeof i === 'string'))
    }
    if (source.dimensions && typeof source.dimensions === 'object') {
      for (const dim of Object.values(source.dimensions) as any[]) {
        if (Array.isArray(dim?.issues)) {
          issues.push(...dim.issues.filter((i: any) => typeof i === 'string'))
        }
      }
    }
    if (source.panel_analysis && Array.isArray(source.panel_analysis)) {
      for (const panel of source.panel_analysis) {
        if (panel?.notes && panel.status !== 'OK') issues.push(`Panel ${panel.panel}: ${panel.notes}`)
      }
    }

    const ok = source.status ? source.status !== 'FAIL' : score >= 6
    return { score, ok, issues }
  }

  it('returns data as-is when already in correct format', () => {
    const data = { score: 8, ok: true, issues: ['minor issue'] }
    const result = unwrapVerifyResult(data)
    expect(result?.score).toBe(8)
    expect(result?.ok).toBe(true)
    expect(result?.issues).toEqual(['minor issue'])
  })

  it('extracts from verification_result wrapper', () => {
    const data = {
      verification_result: {
        overall_score: 6,
        status: 'FAIL',
        deductions: ['-2: truncated prompts'],
        dimensions: {
          character_consistency: { score: 7, issues: ['anchors missing'] },
          lighting: { score: 8, issues: [] },
        },
      },
    }
    const result = unwrapVerifyResult(data)
    expect(result?.score).toBe(6)
    expect(result?.ok).toBe(false)
    expect(result?.issues).toContain('-2: truncated prompts')
    expect(result?.issues).toContain('anchors missing')
  })

  it('extracts from flat overall_score format', () => {
    const data = { overall_score: 9, status: 'PASS', issues: ['all good'] }
    const result = unwrapVerifyResult(data)
    expect(result?.score).toBe(9)
    expect(result?.ok).toBe(true)
  })

  it('collects panel_analysis notes as issues', () => {
    const data = {
      verification_result: {
        overall_score: 5,
        status: 'FAIL',
        panel_analysis: [
          { panel: 1, status: 'INCOMPLETE', notes: 'Prompt truncated' },
          { panel: 2, status: 'OK', notes: 'Fine' },
        ],
      },
    }
    const result = unwrapVerifyResult(data)
    expect(result?.issues).toContain('Panel 1: Prompt truncated')
    expect(result?.issues).not.toContain('Panel 2: Fine')
  })

  it('returns null for invalid data', () => {
    expect(unwrapVerifyResult(null)).toBeNull()
    expect(unwrapVerifyResult({})).toBeNull()
    expect(unwrapVerifyResult({ foo: 'bar' })).toBeNull()
  })
})
```

**Step 2: 运行测试验证通过**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts
```
预期: 原有测试 PASS，新测试 PASS（函数在测试内定义）

**Step 3: 在 DirectorPipeline.ts 中添加 unwrapVerifyResult 函数**

在 `pickAffectedPanels` 函数之后（约行 317）添加导出函数:

```typescript
export function unwrapVerifyResult(data: any): { score: number; ok: boolean; issues: string[] } | null {
  if (!data || typeof data !== 'object') return null
  if (typeof data.score === 'number' && typeof data.ok === 'boolean') return data

  const inner = data.verification_result || data.result || data.verify || data.report
  const source = inner || data

  const score = typeof source.overall_score === 'number' ? source.overall_score
    : typeof source.score === 'number' ? source.score : null
  if (score === null) return null

  const issues: string[] = []
  if (Array.isArray(source.issues)) {
    issues.push(...source.issues.filter((i: any) => typeof i === 'string'))
  }
  if (Array.isArray(source.deductions)) {
    issues.push(...source.deductions.filter((i: any) => typeof i === 'string'))
  }
  if (source.dimensions && typeof source.dimensions === 'object') {
    for (const dim of Object.values(source.dimensions) as any[]) {
      if (Array.isArray(dim?.issues)) {
        issues.push(...dim.issues.filter((i: any) => typeof i === 'string'))
      }
    }
  }
  if (source.panel_analysis && Array.isArray(source.panel_analysis)) {
    for (const panel of source.panel_analysis) {
      if (panel?.notes && panel.status !== 'OK') issues.push(`Panel ${panel.panel}: ${panel.notes}`)
    }
  }

  const ok = source.status ? source.status !== 'FAIL' : score >= 6
  return { score, ok, issues }
}
```

**Step 4: 更新测试使用导出的函数**

在 `evaluator-optimizer.test.ts` 中，把 import 行更新为:
```typescript
import { buildRetryFeedback, pickLowItems, shouldRetryAnalysis, unwrapVerifyResult } from '../DirectorPipeline'
```

并删除测试中内联的 `function unwrapVerifyResult` 定义。

**Step 5: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts
```
预期: 全部 PASS

**Step 6: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/evaluator-optimizer.test.ts
git commit -m "feat(pipeline): 添加 unwrapVerifyResult 处理模型嵌套/变体 verify 响应

模型用 jsonMode 返回 { verification_result: { overall_score, status, dimensions } }
而非 VerifySchema 期望的 { score, ok, issues }。
unwrapVerifyResult() 自动检测多种嵌套格式并映射字段，
包括从 dimensions.*.issues 和 deductions 扁平化收集 issues。"
```

---

### Task 2: DirectorPipeline verifyConsistency 改用 createStructuredLLMWithRaw + unwrap

**文件:**
- 修改: `src/renderer/src/services/pipeline/DirectorPipeline.ts` — verifyConsistencyFn 函数

**Step 1: 修改 verifyConsistencyFn**

将约行 1155-1212 的 verifyConsistencyFn 中的 LLM 调用和结果处理部分替换为:

```typescript
const appliedSkills = self.getSkillsForPhase('verifyConsistency', state as Record<string, unknown>)
const structuredWithRaw = self.createStructuredLLMWithRaw(VerifySchema, undefined, 4096, 'jsonMode')
const vars = extractVarsForVerify(state)
const systemPrompt = self.resolveSystemPrompt(
  'verifyConsistency', vars,
  state as Record<string, unknown>,
  `You are a continuity supervisor. Check panels for consistency.\nScene: ${vars.scene_env}`,
)
const userContent: Array<any> = []
userContent.push({
  type: 'text' as const,
  text: `Verify the following storyboard for consistency. Use a two-layer rubric and score 0-10.\n- Hard consistency (required): identity anchors for face/outfit/weapon remain recognizable.\n- Soft consistency (evolution-allowed): story-driven character/scene evolution remains plausible and aligned with narrative rhythm.\n\nScene: ${vars.scene_env}\n\nCharacter Anchors:\n${vars.character_anchors_summary}\n\nPanels:\n${vars.panels_summary_short}`,
})
const response = await structuredWithRaw.invoke(
  [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ],
  { signal: config?.signal },
)

let result = (response as any)?.parsed
// unwrap 嵌套/变体格式
if (!result || typeof result.score !== 'number') {
  const unwrapped = unwrapVerifyResult(result)
  if (unwrapped) {
    result = unwrapped
  } else {
    // 从 raw content 中尝试提取
    const rawText = typeof (response as any)?.raw?.content === 'string'
      ? (response as any).raw.content : ''
    if (rawText) {
      try {
        const match = rawText.match(/\{[\s\S]*\}/)
        if (match) {
          const parsed = JSON.parse(match[0])
          const extracted = unwrapVerifyResult(parsed)
          if (extracted) result = extracted
        }
      } catch { /* fallback below */ }
    }
  }
}

result = result ?? { score: 7, ok: true, issues: [] }
if (typeof result.score !== 'number') result.score = 7
if (typeof result.ok !== 'boolean') result.ok = result.score >= 6
if (!Array.isArray(result.issues)) result.issues = []
```

**注意:** 后续的 `elapsed`、`passData`、`threshold`、`shouldReject`、`retryFeedback` 等逻辑保持不变。

**Step 2: 运行测试**

```bash
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 3: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix(director): verifyConsistency 改用 createStructuredLLMWithRaw + unwrap

从 createStructuredLLM 改为 createStructuredLLMWithRaw，
parsed 失败时用 unwrapVerifyResult() 从 raw JSON 中提取
score/ok/issues，处理模型返回的 verification_result 嵌套格式。"
```

---

### Task 3: StoryboardProPipeline deepVerify 同步修复

**文件:**
- 修改: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` — deepVerifyFn 函数

**Step 1: 在文件顶部添加 import**

在 `StoryboardProPipeline.ts` 的 import 区域（约行 10），从 DirectorPipeline 导入 unwrapVerifyResult:

```typescript
import { VerifySchema } from '../pipeline/schemas/director-schemas'
import { unwrapVerifyResult } from '../pipeline/DirectorPipeline'
```

注意: 如果 `unwrapVerifyResult` 已经在 `VerifySchema` 同一行导入，只需追加到现有 import。如果有循环依赖问题，则把 `unwrapVerifyResult` 复制为本地函数。

**Step 2: 修改 deepVerifyFn**

将约行 576-631 的 deepVerifyFn 中的 LLM 调用和结果处理部分替换为:

```typescript
const appliedSkills = self.getSkillsForPhase('deepVerify', state as Record<string, unknown>)
const structuredWithRaw = self.createStructuredLLMWithRaw(VerifySchema, undefined, 4096, 'jsonMode')

// ... sceneSummary, characterSummary, shotsSummary, vars, systemPrompt 不变 ...

const response = await structuredWithRaw.invoke(
  [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Verify the storyboard for consistency. Check: character anchors, spatial continuity, timeline coherence, narrative arc, motion continuity. Score 0-10.`,
    },
  ],
  { signal: config?.signal },
)

let result = (response as any)?.parsed
if (!result || typeof result.score !== 'number') {
  const unwrapped = unwrapVerifyResult(result)
  if (unwrapped) {
    result = unwrapped
  } else {
    const rawText = typeof (response as any)?.raw?.content === 'string'
      ? (response as any).raw.content : ''
    if (rawText) {
      try {
        const match = rawText.match(/\{[\s\S]*\}/)
        if (match) {
          const parsed = JSON.parse(match[0])
          const extracted = unwrapVerifyResult(parsed)
          if (extracted) result = extracted
        }
      } catch { /* fallback below */ }
    }
  }
}

result = result ?? { score: 7, ok: true, issues: [] }
if (typeof result.score !== 'number') result.score = 7
if (typeof result.ok !== 'boolean') result.ok = result.score >= 6
if (!Array.isArray(result.issues)) result.issues = []
```

**Step 3: 运行测试**

```bash
npx vitest run src/renderer/src/services/storyboard-pipeline/
npx vitest run src/renderer/src/services/pipeline/
```
预期: 全部 PASS

**Step 4: 提交**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "fix(storyboard-pro): deepVerify 同步改用 createStructuredLLMWithRaw + unwrap

与 DirectorPipeline verifyConsistency 保持一致，
使用 unwrapVerifyResult() 处理模型嵌套/变体 verify 响应。"
```

---

## 验证

```bash
# 全部测试
npx vitest run src/renderer/src/services/pipeline/
npx vitest run src/renderer/src/services/storyboard-pipeline/

# 端到端 — 导演模式
npm run dev
# → 导演模式 → 上传图片 → 生成
# → 控制台应看到 "一致性校验完成 (score: X/10)" 而非 "failed"
# → 如果看到 unwrapVerifyResult 触发 raw fallback，说明映射在工作
```
