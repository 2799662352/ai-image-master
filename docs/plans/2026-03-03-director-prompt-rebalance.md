# Director Prompt Rebalance Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Downgrade user sceneDescription from "HIGHEST PRIORITY / MUST FOLLOW" to "Creative Brief", giving the Director AI full authority over shot design, composition, lighting, and pacing.

**Architecture:** Only prompt string changes in DirectorPipeline.ts. No logic, no architecture, no new files. 4 string replacements in 1 file.

**Tech Stack:** TypeScript (prompt strings only)

---

### Task 1: Pass 1 — 场景分析 user message 降级

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:350-352`

**Step 1: Replace the Pass 1 user message string**

In `DirectorPipeline.ts`, around line 350-352, replace:

```typescript
? `【用户创意方向】${state.sceneDescription}\n\n请基于用户的创意方向分析参考图片。用户描述的场景意图优先于图片中的细节。`
```

with:

```typescript
? `【导演创意简报】${state.sceneDescription}\n\n以参考图片的视觉信息为基础进行场景分析，同时将上述创意简报作为补充上下文。图片中的视觉事实优先，创意简报提供叙事方向。`
```

**Step 2: Run tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`
Expected: All existing tests PASS (no logic changed)

---

### Task 2: Pass 3 — 分镜设计 system prompt (userDirective) 降级

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:491-497`

**Step 1: Replace the userDirective block**

Around line 491-497, replace:

```typescript
const userDirective = state.sceneDescription
  ? [
      `## HIGHEST PRIORITY — User's Creative Direction (MUST FOLLOW)`,
      `"${state.sceneDescription}"`,
      `This is the user's explicit creative intent. Every panel MUST directly serve this direction.`,
      `If any AI-analyzed detail conflicts with the user's direction, the user's direction ALWAYS wins.`,
    ].join('\n')
  : ''
```

with:

```typescript
const userDirective = state.sceneDescription
  ? [
      `## Director's Creative Brief`,
      `"${state.sceneDescription}"`,
      `This is the creative brief setting the theme and narrative direction. As the professional director, you have full authority over shot design, composition, lighting, pacing, and visual storytelling.`,
      `Use the brief as your creative compass — not a shot-by-shot script. Elevate the vision with your cinematic expertise.`,
    ].join('\n')
  : ''
```

---

### Task 3: Pass 3 — 分镜设计 user message 降级

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:504-506`

**Step 1: Replace the user message string**

Around line 504-506, replace:

```typescript
const userText = state.sceneDescription
  ? `【最高优先级指令】用户明确要求："${state.sceneDescription}"\n\n请严格按照用户意图，为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词。每个分镜都必须服务于用户描述的场景和叙事。`
  : `为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词`
```

with:

```typescript
const userText = state.sceneDescription
  ? `【创意简报】"${state.sceneDescription}"\n\n围绕上述创意方向，发挥你作为专业导演的演出能力，为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词。镜头设计、构图、光影、叙事节奏由你全权决定。`
  : `为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词`
```

---

### Task 4: Pass 5 — 图像生成 userDirection 降级

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:179-181`

**Step 1: Replace the userDirection string**

Around line 179-181, replace:

```typescript
const userDirection = state.sceneDescription
  ? `\n\nUSER'S CREATIVE DIRECTION (highest priority): "${state.sceneDescription}"`
  : ''
```

with:

```typescript
const userDirection = state.sceneDescription
  ? `\n\nCREATIVE BRIEF (narrative context): "${state.sceneDescription}"`
  : ''
```

**Step 2: Run all tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "refactor: downgrade user input from HIGHEST PRIORITY to Creative Brief for director autonomy"
```
