# Director Phase 3-4 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 仅执行 Phase 3（语言策略统一）和 Phase 4（一致性评分回路），在不改变模型能力的前提下提升人物一致性与可控性。

**Architecture:** 继续沿用现有 `DirectorPipeline`。Phase 3 在 Pass1/Pass2 与 guardrails 层做 English-first 统一、中文简报轻量英文摘要、角色主键规范化（英文 canonical name + 中文 alias）。Phase 4 在 Pass4 扩展可量化分项评分（face/outfit/weapon/style），并在低分时只触发一次差项定向软修正重试，不重写全部分镜。

**Tech Stack:** TypeScript, LangGraphJS (`StateGraph`), LangChain structured output + Zod, Vitest

---

## Context7 对齐要点（已纳入本计划）

- LangChain：优先结构化输出（Zod），并为解析失败提供自动重试与兜底（避免自由文本脆弱解析）。
- LangGraph：节点职责单一，条件路由明确，节点级重试策略可配置，不把重试逻辑混入业务逻辑。
- DeepAgents/skills：system prompt 与技能说明保持精简分层，避免冗长冲突指令占用上下文窗口。

---

### Task 1: Phase 3 失败测试先行（语言与实体名）

**Files:**
- Create: `src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts`
- Modify: `src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts`
- Test: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 写失败测试（guardrails 含英文摘要 + 原文上下文块）**

```ts
it('should include english summary and raw brief context block', () => {
  const out = buildNarrativeRhythmGuardrails('前慢后快，先压抑后释放')
  expect(out).toContain('ENGLISH BRIEF SUMMARY')
  expect(out).toContain('BEGIN_USER_BRIEF_CONTEXT')
  expect(out).toContain('END_USER_BRIEF_CONTEXT')
})
```

**Step 2: 写失败测试（角色主键稳定 + 中文别名不分裂实体）**

```ts
it('should keep canonical english key and retain chinese alias', () => {
  const lock = buildCharacterIdentityLock([
    { name: 'Liu Yunfeng', anchor: '... (柳云峰)' },
    { name: 'Green-haired Girl', anchor: '...' },
  ])
  expect(lock).toContain('Liu Yunfeng')
  expect(lock).toContain('柳云峰')
})
```

**Step 3: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts --reporter=verbose`  
Expected: FAIL（缺少英文摘要块/别名规则）

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts
git commit -m "test: add failing tests for phase3 language and canonical identity"
```

---

### Task 2: Phase 3 最小实现（English-first + canonical 名称）

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`

**Step 1: 增加轻量英文摘要函数**

```ts
function buildEnglishBriefSummary(sceneDescription: string): string {
  // 规则：确定性摘要（不依赖额外 LLM 调用），不改意图，仅提炼叙事节奏和核心动作为英文要点
}
```

**Step 2: 在 `buildNarrativeRhythmGuardrails` 注入摘要块**

```ts
return [
  '## Narrative Rhythm Guardrails',
  englishSummaryBlock,
  wrappedBrief,
  ...constraints,
].join('\n')
```

**Step 3: 角色命名规范化（英文主键 + 中文 alias）**

```ts
// canonical key 用英文主名；中文仅作 alias 文本展示，不参与新 key 派生
// 需要显式实现 extractAliasesFromNameOrAnchor()，处理 "Liu Yunfeng (柳云峰)" 场景
```

**Step 4: 更新 schema 描述（English-first 主干）**

```ts
name: z.string().describe('Canonical English name first; non-English aliases optional.')
```

**Step 5: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts --reporter=verbose`  
Expected: PASS

**Step 6: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/schemas/director-schemas.ts src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts
git commit -m "feat: unify english-first brief and canonical character naming"
```

---

### Task 3: Phase 4 失败测试先行（分项一致性评分）

**Files:**
- Create: `src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts`
- Test: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`
- Test: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 写失败测试（VerifySchema 分项）**

```ts
expect(report).toHaveProperty('faceConsistency')
expect(report).toHaveProperty('outfitConsistency')
expect(report).toHaveProperty('weaponConsistency')
expect(report).toHaveProperty('styleContinuity')
```

**Step 2: 写失败测试（低分只触发差项软修正）**

```ts
expect(retryFeedback).toContain('Fix only:')
expect(retryFeedback).toContain('weapon consistency')
expect(retryFeedback).not.toContain('rewrite all panels')
expect(routeDecision).toBe('retry') // 当任一分项低于阈值
```

**Step 3: 跑测试确认失败**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts --reporter=verbose`  
Expected: FAIL（字段不存在/反馈文案不匹配）

**Step 4: 提交**

```bash
git add src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts
git commit -m "test: add failing tests for phase4 sub-scores and targeted retry"
```

---

### Task 4: Phase 4 最小实现（分项评分 + 一次定向软修正）

**Files:**
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 扩展 `VerifySchema` 分项评分字段**

```ts
faceConsistency: z.number().min(0).max(10).optional(),
outfitConsistency: z.number().min(0).max(10).optional(),
weaponConsistency: z.number().min(0).max(10).optional(),
styleContinuity: z.number().min(0).max(10).optional(),
```

**Step 2: Pass4 结果做兼容回填（旧模型输出兜底）**

```ts
result.faceConsistency ??= result.score
result.outfitConsistency ??= result.score
result.weaponConsistency ??= result.score
result.styleContinuity ??= result.score
```

**Step 2.1: 配置 `verifyConsistency` 节点重试策略（LangGraph 节点级）**

```ts
const retryLLM = { maxAttempts: 2, initialInterval: 1.0 }
.addNode('verifyConsistency', verifyConsistencyFn, { retryPolicy: retryLLM })
```

**Step 2.2: 增加低分项提取函数（确定性、可测）**

```ts
function pickLowItems(report: VerifyReport, threshold: number): string[] {
  const pairs: Array<[string, number | undefined]> = [
    ['face consistency', report.faceConsistency],
    ['outfit consistency', report.outfitConsistency],
    ['weapon consistency', report.weaponConsistency],
    ['style continuity', report.styleContinuity],
  ]
  return pairs
    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v < threshold)
    .map(([k]) => k)
}
```

约束：
- 去重：同名项只出现一次
- 顺序固定：face -> outfit -> weapon -> style（便于 snapshot 测试）
- 空结果时：不返回 `Fix only:` 空列表，改为默认文案（见 Step 3）

**Step 2.3: 增加受影响面板提取函数（支持“只重试一部分”）**

```ts
function pickAffectedPanels(report: VerifyReport): number[] {
  const text = (report.issues || []).join('\n')
  const ids = Array.from(text.matchAll(/panel\s*(\d+)/gi)).map((m) => Number(m[1]))
  return Array.from(new Set(ids)).filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
}
```

约束：
- 若 `issues` 里无明确 panel 编号，默认回退为“最小局部修复”：仅允许调整最多 1-2 个最相关面板
- `affectedPanels` 必须按升序、去重输出，便于测试断言与日志比对

**Step 3: `prepareRetryFn` 仅拼接低分差项**

```ts
const lowItems = pickLowItems(result, threshold)
const affectedPanels = pickAffectedPanels(result)
const feedback = lowItems.length > 0
  ? `Soft correction only. Fix only: ${lowItems.join(', ')}. Affected panels: ${affectedPanels.join(', ') || 'minimal local subset'}. Keep all other panels unchanged.`
  : 'Soft correction only. Keep character identity and narrative rhythm stable; apply minimal local fixes.'
```

补充要求：
- 仍保留 `state.report?.issues` 的人工可读问题文本（附在 feedback 末尾）
- 禁止出现 “rewrite all panels / redesign entire storyboard” 类全量改写措辞
- 明确禁止全量重试：仅允许修改 `affectedPanels` 列表中的面板提示词
- 若 `affectedPanels` 为空，回退策略为“局部最小改动”，不得触发整套分镜重写

**Step 4: `routeVerify` 改为“总分 + 分项阈值”联合判定**

```ts
const hasLowSubScore = [result.faceConsistency, result.outfitConsistency, result.weaponConsistency, result.styleContinuity]
  .some((v) => typeof v === 'number' && v < threshold)
if (result.score < threshold || hasLowSubScore) return 'retry'
```

边界条件：
- `report` 为空：直接 `generate`（保持现有容错逻辑）
- `retryCount >= MAX_RETRIES`：直接 `generate`
- 分项为 `undefined`：不计入低分（由 Step 2 回填保障）

**Step 5: 保持现有 `MAX_RETRIES=1`（只拉回一次）**

```ts
// 不增加二次以上重试，避免牺牲演出多样性
```

**Step 6: 跑测试确认通过**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts --reporter=verbose`  
Expected: PASS

附加断言（加入 `director-consistency-scoring.test.ts`）：

```ts
it('pickLowItems should return stable ordered labels', () => {
  const low = pickLowItems({
    score: 8, ok: true, issues: [],
    faceConsistency: 5, outfitConsistency: 9, weaponConsistency: 4, styleContinuity: 7,
  } as any, 6)
  expect(low).toEqual(['face consistency', 'weapon consistency'])
})

it('prepareRetry feedback should be targeted and non-global', () => {
  expect(feedback).toContain('Fix only: weapon consistency')
  expect(feedback).toContain('Affected panels:')
  expect(feedback).not.toContain('rewrite all panels')
})
```

**Step 7: 提交**

```bash
git add src/renderer/src/services/pipeline/schemas/director-schemas.ts src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts
git commit -m "feat: add phase4 consistency sub-scores and targeted soft-correction retry"
```

---

### Task 5: 回归与验收

**Files:**
- Validate: `src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts`
- Validate: `src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts`
- Validate: `src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts`
- Validate: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: 跑核心测试集**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-language-unification.test.ts src/renderer/src/services/pipeline/__tests__/director-consistency-scoring.test.ts src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts --reporter=verbose`  
Expected: PASS

**Step 2: 跑 pipeline 全量测试**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`  
Expected: PASS

**Step 3: 验收清单（与你要求对齐）**

- Pass1/Pass2：English-first 主干稳定（中文简报被摘要但原文仍保留上下文块）
- 实体名：`Liu Yunfeng` 为主键，不与 `柳云峰` 分裂为两个实体
- Pass4：可量化 4 项评分（face/outfit/weapon/style）
- 低分案例：当总分或任一分项低于阈值时，触发一次差项定向软修正
- 低分案例：非差项不被重写，演出多样性保留

