# Story-Driven Scene Evolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让场景可随故事推进自然变化，不再被“固定场景一致性”卡死，同时继续保持人物身份一致性与叙事主线稳定。

**Architecture:** 在 `DirectorPipeline` 中把“场景一致性”从硬性连续改为“故事驱动的连续性”：允许跨 panel 的场景切换，但必须由故事节奏或叙事节点触发。Pass4 校验提示词同步更新为“允许叙事驱动转场”，避免把合理转场误判为不一致。通过测试先行锁定行为，确保只放松场景约束，不放松人物身份约束。

**Tech Stack:** TypeScript, LangGraphJS (`StateGraph`), Zod, Vitest

---

### Task 1: 放松场景硬约束为故事驱动转场（单任务）

**Skills:** `@test-driven-development` `@verification-before-completion`

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts`

**Step 1: 写失败测试（先锁定新规则）**

```ts
it('narrative guardrails should allow story-driven scene evolution', () => {
  const guardrails = buildNarrativeRhythmGuardrails('先在学院中庭追逐，后转入地下遗迹对决')
  expect(guardrails).toContain('Scene evolution is allowed when it serves story progression')
  expect(guardrails).toContain('Do not treat every panel as a fixed same-location requirement')
})
```

**Step 2: 运行测试验证失败**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts --reporter=verbose`  
Expected: FAIL（当前 guardrails 尚未包含“故事驱动场景演进”语义）

**Step 3: 最小实现（仅改约束语义，不改其他流程）**

```ts
// DirectorPipeline.ts -> buildNarrativeRhythmGuardrails()
return [
  '## Narrative Rhythm Guardrails',
  wrappedBrief,
  'Identity anchors: prioritize consistency for face, hairstyle, outfit, primary color palette, and signature weapon/accessory.',
  'Narrative anchors: keep the user\'s narrative direction and rhythm as the main line.',
  'Director authority: you may freely design shots, composition, lighting, blocking, and pacing, as long as identity and narrative recognizability are preserved.',
  'Scene evolution is allowed when it serves story progression and user narrative rhythm.',
  'Do not treat every panel as a fixed same-location requirement; allow cinematic transitions with clear narrative motivation.',
  'Preserve the user\'s intended narrative rhythm and progression.',
  'Enhance cinematic expression without changing story direction.',
  'Optimize pacing through shot language, not by rewriting narrative intent.',
].join('\\n')
```

**Step 4: 运行测试验证通过**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts --reporter=verbose`  
Expected: PASS

**Step 5: 回归检查（最小范围）**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`  
Expected: PASS（无既有一致性回归）

**Step 6: 提交**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-pronoun-reuse.test.ts
git commit -m "feat: allow story-driven scene evolution while preserving identity constraints"
```

