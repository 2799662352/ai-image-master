# 导演规划 Skill 注入 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让导演规划 (Task Planning, Pass 0) 也能读取和注入 Skill 规则，与其他 Pass 保持一致的 Skill 感知能力。

**Architecture:** 将 Task Planning 的裸 `llm.invoke()` 改造为与其他 Pass 完全一致的模式：`SkillsMW` + `runSkillDiscovery()` LLM 发现 + prompt 模板 + `injectTaskPlan`。同时更新关键 skill 的 `appliesTo` 添加 `taskPlanning` phase。新建 `config/prompts/director/pass0-task-planning.md` 模板。

**Tech Stack:** TypeScript, Markdown prompt templates, SKILL.md frontmatter

---

## 现状

| 维度 | Pass 0 导演规划 (当前) | Pass 1-5 (当前) |
|------|----------------------|----------------|
| System prompt | 硬编码字符串 | `.md` 模板 + skill 注入 |
| Skill 注入 | 无 | `buildSystemPrompt()` 或 `runSkillDiscovery()` |
| 对领域知识的感知 | 零 — 不知道任何 skill 规则 | 有 — 注入相关 skill rules |
| `appliesTo` 覆盖 | 无 skill 声明 `taskPlanning` | 各 skill 按 phase 声明 |

---

### Task 1: 创建 pass0-task-planning.md 模板

**Files:**
- Create: `config/prompts/director/pass0-task-planning.md`

**Step 1: 创建模板文件**

```markdown
---
pass: 0
name: taskPlanning
label: 导演规划
vision: true
---

You are an experienced film director planning a storyboard shoot. You analyze reference images and creative briefs to create specific, actionable shooting plans.

Your plan will guide ALL downstream passes:
- Scene analysis (environment, atmosphere, spatial layout)
- Character anchoring (visual identity, consistency features)
- Style extraction (medium, palette, lighting, texture)
- Panel design (shot sequence, composition, pacing)
- Consistency verification (continuity checks)

Output a structured plan covering:
1. Scene setting — core environment and atmosphere
2. Key characters — who appears, their visual identity anchors
3. Visual style direction — medium, palette, lighting mood
4. Narrative arc — how the story flows across panels (pacing, tension)
5. Consistency priorities — what must stay consistent vs what can evolve

IMPORTANT: Write the ENTIRE plan in English, regardless of the creative brief language. All downstream passes consume English only.
Be specific to THESE images — not generic. Keep the entire plan under 300 words.
```

**Step 2: Verify file created**

Run: `ls config/prompts/director/pass0-task-planning.md`

---

### Task 2: 更新关键 Skill 的 appliesTo 添加 taskPlanning

**Files:**
- Modify: `skills/director-narrative-flow/SKILL.md`
- Modify: `skills/director-cinematic-composition/SKILL.md`
- Modify: `skills/director-shot-sequence-patterns/SKILL.md`
- Modify: `skills/director-scene-analysis-depth/SKILL.md`
- Modify: `skills/director-character-consistency/SKILL.md`
- Modify: `skills/director-style-consistency/SKILL.md`

**Step 1: 给 6 个核心 skill 添加 taskPlanning phase**

对每个 skill 的 frontmatter，在 `appliesTo` 数组中添加 `taskPlanning`：

`director-narrative-flow/SKILL.md`:
```yaml
appliesTo: [taskPlanning, designAndAssemble, verifyConsistency]
```

`director-cinematic-composition/SKILL.md`:
```yaml
appliesTo: [taskPlanning, analyzeScene]
```

`director-shot-sequence-patterns/SKILL.md`:
```yaml
appliesTo: [taskPlanning, designAndAssemble]
```

`director-scene-analysis-depth/SKILL.md`:
```yaml
appliesTo: [taskPlanning, analyzeScene]
```

`director-character-consistency/SKILL.md`:
```yaml
appliesTo: [taskPlanning, extractCharacterAnchors, verifyConsistency]
```

`director-style-consistency/SKILL.md`:
```yaml
appliesTo: [taskPlanning, extractStyleAnchor, verifyConsistency, designAndAssemble, generateImages]
```

**Step 2: Verify frontmatter parses correctly**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts --reporter=verbose`

Expected: PASS (or adjust if this test verifies exact skill counts)

---

### Task 3: 改造 taskPlanningFn 使用模板 + Skill 注入

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (taskPlanningFn 函数, 约 line 1347-1420)

**Step 1: 替换 taskPlanningFn — 完整 SkillsMW + runSkillDiscovery 模式**

将当前的硬编码 system prompt 替换为与 Pass 1-5 完全一致的模式。

当前代码 (约 line 1347-1390) 中，在 `const llm = self.createLLM()` 之后、`userContent.push(...)` 之前，插入 skill discovery 块：

```typescript
    const taskPlanningFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const skillsMw = new SkillsMW(self.matchSkillsForPhase('taskPlanning', state as Record<string, unknown>))
        const appliedSkills = skillsMw.getAllSkillIds('taskPlanning', state as Record<string, unknown>)

        let discoveredSkillRules = ''
        try {
          const discoveryResult = await skillsMw.runSkillDiscovery({
            llm: self.createLLM(),
            phase: 'taskPlanning',
            context: state as Record<string, unknown>,
            basePrompt: 'You are an experienced film director. Before planning, review available skills for relevant techniques.',
            userMessage: 'Read any relevant skills for director planning, then confirm you are ready.',
            maxIterations: 3,
            signal: config?.signal,
          })
          discoveredSkillRules = discoveryResult.loadedSkillBodies
        } catch (e: unknown) {
          console.warn('[DirectorPipeline] Pass 0 skill discovery failed:', e instanceof Error ? e.message : String(e))
        }

        const tpl = getPromptTemplate('taskPlanning')
        const basePrompt = tpl
          ? renderTemplate(tpl.template, {})
          : 'You are an experienced film director planning a storyboard shoot. You analyze reference images and creative briefs to create specific, actionable shooting plans. Your plan will guide scene analysis, character anchoring, style extraction, panel design, and consistency verification.'
        const systemPromptBase = discoveredSkillRules
          ? `${basePrompt}\n\n--- Loaded Skills ---\n${discoveredSkillRules}`
          : basePrompt

        const llm = self.createLLM()
        const userContent: Array<any> = []

        if (state.inputImages.length > 0) {
          userContent.push(
            ...BasePipeline.buildImageContent(state.inputImages, 'low'),
          )
        }

        userContent.push({
          type: 'text' as const,
          text: [
            `Creative brief: ${state.sceneDescription || '(free creation)'}`,
            `Style: ${state.styleInstructions || '(extract from reference images)'}`,
            `Template: ${state.template || 'default'}`,
            `Panels: ${state.layout?.panelCount || 4}`,
            '',
            'Based on the reference images and the brief above, create the director\'s shooting plan following the system prompt structure.',
          ].join('\n'),
        })

        const response = await llm.invoke(
          [
            { role: 'system' as const, content: systemPromptBase },
            { role: 'user' as const, content: userContent },
          ],
          { signal: config?.signal },
        )
```

关键点：
- `SkillsMW` + `runSkillDiscovery()` 与 Pass 1-5 完全一致
- `maxIterations: 3` 与其他 Pass 对齐
- `discoveredSkillRules` 拼接到 system prompt
- `appliedSkills` 传入 `buildPassCardData`

**Step 2: 更新 passData 中的 appliedSkills**

将 `buildPassCardData` 调用中的空数组 `[]` 改为 `appliedSkills`：

```typescript
        // Before (约 line 1402-1408):
          passData: DirectorPipeline.buildPassCardData(
            'taskPlanning',
            { pass: 0, label: '导演规划' },
            { planText },
            elapsed,
            [],
          ),

        // After:
          passData: DirectorPipeline.buildPassCardData(
            'taskPlanning',
            { pass: 0, label: '导演规划' },
            { planText },
            elapsed,
            appliedSkills,
          ),
```

同样更新 catch 块中的 `buildPassCardData`（约 line 1418）。

**Step 3: 同步更新 user message 中的硬编码指令**

当前 user message 中有重复的指令（"Output a structured plan covering: 1. Scene setting..."），这些指令已经在模板中了。简化 user message 为只传递动态变量：

```typescript
        userContent.push({
          type: 'text' as const,
          text: [
            `Creative brief: ${state.sceneDescription || '(free creation)'}`,
            `Style: ${state.styleInstructions || '(extract from reference images)'}`,
            `Template: ${state.template || 'default'}`,
            `Panels: ${state.layout?.panelCount || 4}`,
            '',
            'Based on the reference images and the brief above, create the director\'s shooting plan following the system prompt structure.',
          ].join('\n'),
        })
```

---

### Task 4: 运行完整测试验证

**Step 1: 运行 pipeline 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All pass (185/186, 1 pre-existing)

**Step 2: 验证 skill 加载**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/runtime-skills-regression.test.ts --reporter=verbose`

Expected: PASS

**Step 3: 验证 prompt-loader 识别新模板**

新模板 `pass0-task-planning.md` 使用 `name: taskPlanning`，`getPromptTemplate('taskPlanning')` 应该能找到它。

---

## 改动总结

| 文件 | 改动 |
|------|------|
| `config/prompts/director/pass0-task-planning.md` | **新建** — 导演规划的 prompt 模板 |
| `skills/director-narrative-flow/SKILL.md` | `appliesTo` 添加 `taskPlanning` |
| `skills/director-cinematic-composition/SKILL.md` | `appliesTo` 添加 `taskPlanning` |
| `skills/director-shot-sequence-patterns/SKILL.md` | `appliesTo` 添加 `taskPlanning` |
| `skills/director-scene-analysis-depth/SKILL.md` | `appliesTo` 添加 `taskPlanning` |
| `skills/director-character-consistency/SKILL.md` | `appliesTo` 添加 `taskPlanning` |
| `skills/director-style-consistency/SKILL.md` | `appliesTo` 添加 `taskPlanning` |
| `DirectorPipeline.ts` | taskPlanningFn 改用 `getPromptTemplate` + `buildSystemPrompt` + `appliedSkills` |

**设计决策：** 使用 `SkillsMW` + `runSkillDiscovery()` LLM 发现模式，与 Pass 1-5 完全一致。导演规划是管线的"大脑"，应该有最完整的领域知识感知。LLM 自选 skill 可以根据具体的 creative brief 做更精准的匹配。

**预期效果：** 导演规划现在能读到叙事节奏、镜头序列、角色一致性、风格一致性等领域知识，输出质量会更有方向性。UI 的 passCard 中也会显示 `appliedSkills` 列表。未来 `skipSkillDiscovery` 开关也会同样适用于此 Pass。
