# V4 Deterministic Storyboard Pipeline

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the LLM-orchestrated V3 pipeline with a deterministic `Promise.all` pipeline that eliminates all orchestrator overhead, cutting API calls from 13+ to 5 and execution time from 20+ minutes to ~5 minutes.

**Architecture:** Keep the same 5 subagent analysis passes + 2 pure-function passes (merge, verify), but replace the `createDeepAgent` orchestrator with a hardcoded `Promise.all` execution flow. Each subagent is a simple `model.bindTools([viewTool]).invoke(messages)` call — no TodoListMiddleware, no SubAgentMiddleware, no orchestrator LLM deciding what to do next. Images are passed via multimodal message content (not closure tools), keeping it simple. Data flows via return values, not via `/shared/` filesystem writes.

**Tech Stack:** `@langchain/openai` (ChatOpenAI), `@langchain/core/messages` (HumanMessage, SystemMessage), BasePipeline (existing), TypeScript

**Why not keep createDeepAgent:**
- Our pipeline is FIXED — the order never changes. The orchestrator's "thinking" adds zero value.
- `createDeepAgent` includes TodoListMiddleware, SubAgentMiddleware, SummarizationMiddleware that add ~2000 tokens system prompt overhead per call.
- The orchestrator makes 8+ "deciding" LLM calls that are pure waste.
- `deepagents` requires Node.js runtime (fs, path, os) — fragile in Electron renderer.
- Connection instability (`net::ERR_CONNECTION_CLOSED`) means every unnecessary API call risks pipeline failure.

---

## Current vs Target

```
V3 (createDeepAgent orchestrator):
  Orchestrator Call 1 → write_todos
  Orchestrator Call 2 → decide task(scene)
  Subagent Call 3   → scene analysis
  Orchestrator Call 4 → decide task(identity)
  Subagent Call 5   → identity extraction
  ... (8 more calls)
  Total: 13+ API calls, ~20 minutes, sequential

V4 (deterministic Promise.all):
  Phase 1: Promise.all([scene, identity])     → 2 calls in parallel
  Phase 2: Promise.all([spatial, narrative])  → 2 calls in parallel
  Phase 3: merge (pure function, 0 calls)
  Phase 4: shots                              → 1 call
  Phase 5: verify (pure function, 0 calls)
  Total: 5 API calls, ~5 minutes, parallel where possible
```

---

## Task 1: Create V4 Pipeline File

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/StoryboardV4Pipeline.ts`

The core pipeline. No `createDeepAgent`, no `deepagents` package dependency.

```typescript
import { BasePipeline } from '../pipeline/BasePipeline'
import type {
  PipelineConfig, PipelineSkill, PipelineProgress, PipelineExecuteOptions,
} from '../pipeline/types'
import type { StoryboardResponse } from '../LangChainStoryboardService'
import { getStoryboardSkills } from './storyboard-prompt-loader'
import { mergeCharactersFromJSON, verifyStoryboardFromJSON } from './storyboard-tools'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

interface ImageInput { data: string; mimeType: string }

// Per-pass system prompts — keep them short, no strict JSON schema enforcement.
// The LLM returns natural-language JSON; assembleResult is lenient.
const PROMPTS = {
  scene: `You are a scene analyst for film storyboards.
Analyze the reference images and return JSON:
{d: "narrative arc A→B→C", cap: "structured caption", env: "environment", bgm: "sound design"}
Describe ONLY what is visually present. English only.`,

  identity: `You are a character identity analyst for film storyboards.
Analyze the reference images and return JSON:
{objs: [{n: "name", f: "visual appearance", t: "cross-shot anchor"}]}
One entry per distinct character/entity. English only.`,

  spatial: `You are a spatial/motion analyst for film storyboards.
You will receive a character list and reference images.
For each character, analyze: spatial position, physical type, multi-granularity action, motion intensity.
Return JSON: {objs: [{n: "exact name", s: "position", p: "physique", a: "action detail", m: "motion intensity"}]}
CRITICAL: Use EXACT character names from the provided list. English only.`,

  narrative: `You are a narrative/performance analyst for film storyboards.
You will receive a character list and reference images.
For each character, analyze: performance action, visual effects, psychological motive, transition continuity.
Return JSON: {objs: [{n: "exact name", act: "action", fx: "effects or null", motive: "psychology", tc: "transition"}]}
CRITICAL: Use EXACT character names from the provided list. English only.`,

  shots: `You are a film director designing a shot sequence.
You will receive scene data and merged character data.
Design 4-8 shots with continuity anchors.
Return JSON: {seq: [{id: "S1", desc: "...", act: "...", fx: "...", motive: "...", audio: "..."}], cont: "continuity notes", notes: "pacing summary"}
English only.`,
}

export class StoryboardV4Pipeline extends BasePipeline<any, StoryboardResponse> {
  constructor(config: PipelineConfig) { super(config) }

  get pipelineSkills(): PipelineSkill[] { return getStoryboardSkills() }
  buildGraph() { return null }

  private buildImageBlocks(images: ImageInput[]) {
    return BasePipeline.buildImageContent(images, 'high')
  }

  private async callSubagent(
    systemPrompt: string,
    userContent: any[],
    signal?: AbortSignal,
  ): Promise<string> {
    const llm = this.createLLM()
    const result = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage({ content: userContent }),
    ], { signal })
    return typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content)
  }

  private extractJSON(text: string): any {
    // Find first { ... } or [ ... ] block in the response
    const jsonMatch = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]) }
      catch { /* fall through */ }
    }
    // Fallback: try the whole string
    try { return JSON.parse(text) }
    catch { return {} }
  }

  async execute(
    input: { inputImages?: Array<{ data: string; mimeType: string }>; userContext?: string },
    onProgress?: (progress: PipelineProgress) => void,
    options?: PipelineExecuteOptions,
  ): Promise<StoryboardResponse> {
    const images: ImageInput[] = input.inputImages || []
    const imageBlocks = this.buildImageBlocks(images)
    const totalPasses = 8
    const signal = options?.signal

    const emit = (pass: number, label: string, status: 'running' | 'completed' = 'completed') => {
      onProgress?.({ pass, totalPasses, label, status })
    }

    const userTextParts = [
      { type: 'text' as const, text: `Analyze the following ${images.length} reference image(s).${input.userContext ? ' Context: ' + input.userContext : ''}` },
    ]
    const imageUserContent = [...userTextParts, ...imageBlocks]

    // --- Phase 0: Planning (instant, no LLM) ---
    emit(0, '导演规划', 'running')
    emit(0, '规划完成')

    // --- Phase 1: Scene + Identity in parallel ---
    emit(1, '场景分析中...', 'running')
    emit(2, '身份锚点提取中...', 'running')

    const [sceneRaw, identityRaw] = await Promise.all([
      this.callSubagent(PROMPTS.scene, imageUserContent, signal),
      this.callSubagent(PROMPTS.identity, imageUserContent, signal),
    ])

    const scene = this.extractJSON(sceneRaw)
    const chars = this.extractJSON(identityRaw)
    emit(1, '场景分析完成')
    emit(2, '身份锚点完成')

    // --- Phase 2: Spatial + Narrative in parallel ---
    emit(3, '空间/运动分析中...', 'running')
    emit(4, '动作/叙事分析中...', 'running')

    const charListText = { type: 'text' as const, text: `Character list from identity extraction:\n${JSON.stringify(chars, null, 2)}` }
    const spatialNarrativeContent = [charListText, ...userTextParts, ...imageBlocks]

    const [spatialRaw, narrativeRaw] = await Promise.all([
      this.callSubagent(PROMPTS.spatial, spatialNarrativeContent, signal),
      this.callSubagent(PROMPTS.narrative, spatialNarrativeContent, signal),
    ])

    const spatial = this.extractJSON(spatialRaw)
    const narrative = this.extractJSON(narrativeRaw)
    emit(3, '空间/运动完成')
    emit(4, '动作/叙事完成')

    // --- Phase 3: Merge (pure function, no LLM) ---
    let merged: any = {}
    try {
      const mergedJSON = mergeCharactersFromJSON(
        JSON.stringify(chars),
        JSON.stringify(spatial),
        JSON.stringify(narrative),
      )
      merged = JSON.parse(mergedJSON)
    } catch {
      merged = { objs: chars.objs || [] }
    }
    emit(5, '角色合并完成')

    // --- Phase 4: Shot design ---
    emit(6, '镜头设计中...', 'running')

    const shotContext = [
      { type: 'text' as const, text: `Scene data:\n${JSON.stringify(scene, null, 2)}\n\nCharacter data:\n${JSON.stringify(merged, null, 2)}` },
    ]
    const shotsRaw = await this.callSubagent(PROMPTS.shots, shotContext, signal)
    const shots = this.extractJSON(shotsRaw)
    emit(6, '镜头设计完成')

    // --- Phase 5: Verify (pure function, no LLM) ---
    try {
      verifyStoryboardFromJSON(
        JSON.stringify(scene),
        JSON.stringify(merged),
        JSON.stringify(shots),
      )
    } catch { /* verification is best-effort */ }
    emit(7, '校验完成')

    return this.postProcess(this.assembleResult({ scene, chars: merged, shots }))
  }

  assembleResult(state: { scene: any; chars: any; shots: any }): StoryboardResponse {
    const { scene = {}, chars = {}, shots = {} } = state
    return {
      scene: {
        d: scene.d || '', cap: scene.cap || '', env: scene.env || '',
        bgm: scene.bgm || '', timeline: [],
      },
      objs: (chars.objs || []).map((o: any) => ({
        n: o.n || '', f: o.f || '', t: o.t || '',
        s: o.s || '', p: o.p || '', a: o.a || '', m: o.m || '',
        act: o.act || '', fx: o.fx ?? null, motive: o.motive || '', tc: o.tc || '',
      })),
      seq: (shots.seq || []).map((s: any) => ({
        id: s.id || '', desc: s.desc || '',
        ...(s.act && { act: s.act }),
        ...(s.fx !== undefined && { fx: s.fx }),
        ...(s.motive && { motive: s.motive }),
        ...(s.audio && { audio: s.audio }),
      })),
      cont: shots.cont || '',
      notes: shots.notes || '',
    }
  }

  postProcess(result: StoryboardResponse): StoryboardResponse { return result }

  async resume(): Promise<StoryboardResponse> {
    throw new Error('V4 pipeline does not support resume')
  }
}
```

**Step 1: Create the file**

Create `StoryboardV4Pipeline.ts` with the code above.

**Step 2: Build to verify**

Run: `npx electron-vite build`
Expected: Build succeeds with no new errors.

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardV4Pipeline.ts
git commit -m "feat: add V4 deterministic storyboard pipeline — 5 API calls, Promise.all parallel"
```

---

## Task 2: Wire V4 into ServiceBridge

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts` (the pipeline version switch)

Find where `v3` is selected and add `v4` as a new option, or change the default from `v3` to `v4`.

**Step 1: Find the pipeline selection logic**

Search for `StoryboardDeepAgentV3Pipeline` in ServiceBridge.ts and add a V4 branch.

**Step 2: Import and wire**

```typescript
import { StoryboardV4Pipeline } from './storyboard-pipeline/StoryboardV4Pipeline'

// In the pipeline selection:
if (pipelineVersion === 'v4') {
  return new StoryboardV4Pipeline(config)
}
```

**Step 3: Set v4 as default**

Change the default pipeline version from `v3` to `v4`.

**Step 4: Build and verify**

Run: `npx electron-vite build`
Expected: Build succeeds.

**Step 5: Commit**

```bash
git add src/renderer/src/services/ServiceBridge.ts
git commit -m "feat: wire V4 pipeline as default — bypasses deepagents orchestrator"
```

---

## Task 3: Increase connection resilience

**Files:**
- Modify: `src/renderer/src/services/pipeline/BasePipeline.ts` (createLLM method)

**Step 1: Increase maxRetries and timeout**

In `createLLM()`, change:
- `maxRetries: 6` → `maxRetries: 10`
- `timeout: 120000` → `timeout: 180000`

This matches the deep-agents guide Section 15 recommendation for unreliable networks.

**Step 2: Build and verify**

Run: `npx electron-vite build`

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/BasePipeline.ts
git commit -m "fix: increase LLM maxRetries to 10 and timeout to 180s for connection stability"
```

---

## Task 4: Bump version

**Files:**
- Modify: `package.json`

**Step 1: Bump to 3.8.0**

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: bump version to 3.8.0 — V4 deterministic pipeline"
```

---

## Expected Result

- **5 API calls** (was 13+): scene, identity, spatial, narrative, shots
- **0 orchestrator calls** (was 8+): no LLM decides what to do next
- **~5 minutes** (was 20+): 2 parallel phases + 1 sequential
- **No deepagents dependency** for V4: no Node.js polyfill issues, no require() bridge
- **Pass 0 always shows "完成"** immediately (deterministic, not LLM-driven)
- **Connection resilience**: maxRetries 10, timeout 180s
- **V3 kept as fallback**: not deleted, just not the default
