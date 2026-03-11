# Storyboard UI Stability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stabilize the image-understanding UI so repeated runs render reliably, every storyboard pass shows the correct status, and the result panel never appears blank due to pipeline progress mismatches.

**Architecture:** Keep the current V4 Deep Agents pipeline, but make the UI depend on deterministic progress events instead of fragile assumptions about stream message shapes. The fix has three parts: lock down the current failure modes with tests, make `StoryboardV4Pipeline` emit pass updates from a normalized tool-message parser, and make the React mount/store lifecycle resilient across repeated analyses.

**Tech Stack:** TypeScript, Vitest, React Testing Library, Zustand, Electron renderer, LangGraph/Deep Agents

---

### Task 1: Lock Down Store and React Mount Regressions

**Files:**
- Modify: `src/renderer/src/react-app/understand/main.tsx`
- Test: `src/renderer/src/react-app/understand/__tests__/main.test.tsx`
- Test: `src/renderer/src/react-app/understand/__tests__/useStoryboardStore.test.ts`

**Step 1: Write the failing repeated-mount test**

```ts
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { mountStoryboardReact, unmountStoryboardReact } from '../main'

describe('mountStoryboardReact', () => {
  afterEach(() => {
    cleanup()
    unmountStoryboardReact()
    document.body.innerHTML = ''
  })

  it('recreates the React root when the container DOM node is replaced', () => {
    document.body.innerHTML = '<div id="a"></div>'
    const first = document.getElementById('a')!
    mountStoryboardReact(first)

    document.body.innerHTML = '<div id="b"></div>'
    const second = document.getElementById('b')!

    expect(() => mountStoryboardReact(second)).not.toThrow()
    expect(second.textContent).toContain('分析')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- src/renderer/src/react-app/understand/__tests__/main.test.tsx`

Expected: FAIL because the old root is reused after the DOM node is replaced.

**Step 3: Write the failing store regression test**

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { useStoryboardStore } from '../stores/useStoryboardStore'

describe('useStoryboardStore', () => {
  beforeEach(() => {
    useStoryboardStore.getState().resetProgress()
  })

  it('keeps non-completed passes pending when only merge and verify complete', () => {
    const push = useStoryboardStore.getState().pushProgress

    push({ pass: 0, totalPasses: 8, label: '规划完成', status: 'completed' })
    push({ pass: 5, totalPasses: 8, label: '角色合并完成', status: 'completed' })
    push({ pass: 7, totalPasses: 8, label: '校验完成', status: 'completed' })

    const state = useStoryboardStore.getState()
    expect(state.passStatuses[1]).toBe('pending')
    expect(state.passStatuses[2]).toBe('pending')
    expect(state.passStatuses[6]).toBe('pending')
    expect(state.analysisStatus).toBe('idle')
  })
})
```

**Step 4: Run test to verify it passes after the existing `main.tsx` fix**

Run: `npm run test:run -- src/renderer/src/react-app/understand/__tests__/main.test.tsx src/renderer/src/react-app/understand/__tests__/useStoryboardStore.test.ts`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/understand/main.tsx src/renderer/src/react-app/understand/__tests__/main.test.tsx src/renderer/src/react-app/understand/__tests__/useStoryboardStore.test.ts
git commit -m "test: lock down storyboard ui mount lifecycle"
```

### Task 2: Normalize `task` Tool Tracking in `StoryboardV4Pipeline`

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardV4Pipeline.ts`
- Test: `src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts`

**Step 1: Write the failing progress-parser test**

```ts
import { describe, expect, it } from 'vitest'

describe('task progress tracking', () => {
  it('matches task completion messages back to dispatched subagents', () => {
    const dispatchMessage = {
      tool_calls: [
        {
          id: 'call_scene',
          name: 'task',
          args: { subagent_type: 'scene-analyzer', description: 'Analyze scene' },
        },
      ],
    }

    const completionMessage = {
      name: 'task',
      tool_call_id: 'call_scene',
      content: 'Scene analysis completed.',
    }

    const map = new Map<string, { pass: number; doneLabel: string }>()
    map.set('call_scene', { pass: 1, doneLabel: '场景分析完成' })

    expect(map.get(completionMessage.tool_call_id)?.doneLabel).toBe('场景分析完成')
  })
})
```

**Step 2: Run test to verify it fails in the current implementation**

Run: `npm run test:run -- src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts`

Expected: FAIL after you replace the naive stub with a real helper imported from `StoryboardV4Pipeline.ts`, because current stream parsing does not robustly normalize `tool_calls`, `args`, and `tool_call_id`.

**Step 3: Extract and implement minimal normalization helpers**

```ts
type SubagentProgressInfo = { pass: number; runLabel: string; doneLabel: string }

export function normalizeToolCall(tc: any) {
  return {
    name: tc?.function?.name || tc?.name || '',
    id: tc?.id || tc?.function?.id || '',
    args: typeof tc?.args === 'string'
      ? safeParseJSON(tc.args)
      : typeof tc?.function?.arguments === 'string'
        ? safeParseJSON(tc.function.arguments)
        : (tc?.args || tc?.function?.arguments || {}),
  }
}

export function normalizeToolMessage(msg: any) {
  return {
    name: msg?.name || '',
    toolCallId: msg?.tool_call_id || msg?.toolCallId || msg?.additional_kwargs?.tool_call_id || '',
    content: typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content || ''),
  }
}
```

**Step 4: Wire the helpers into the stream loop**

```ts
for (const rawToolCall of toolCalls) {
  const tc = normalizeToolCall(rawToolCall)
  if (tc.name !== 'task') continue
  const info = resolveFromArgs(tc.args)
  if (!info) continue
  if (tc.id) toolCallToPass.set(tc.id, info)
  emitProgress(info.pass, info.runLabel, 'running')
}

const toolMsg = normalizeToolMessage(msg)
if (toolMsg.name === 'task') {
  const info = toolMsg.toolCallId ? toolCallToPass.get(toolMsg.toolCallId) ?? null : null
  if (info) emitProgress(info.pass, info.doneLabel, 'completed', toolMsg.content)
}
```

**Step 5: Run test to verify it passes**

Run: `npm run test:run -- src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts`

Expected: PASS, including object-form args, stringified args, and alternate `tool_call_id` shapes.

**Step 6: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardV4Pipeline.ts src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts
git commit -m "fix: stabilize storyboard task progress mapping"
```

### Task 3: Prevent Blank Result Panels While Analysis Is Running

**Files:**
- Modify: `src/renderer/src/react-app/understand/StoryboardAnalysisApp.tsx`
- Modify: `src/renderer/src/react-app/understand/StoryboardResult.tsx`
- Test: `src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx`

**Step 1: Write the failing UI-state test**

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StoryboardAnalysisApp } from '../StoryboardAnalysisApp'
import { useStoryboardStore } from '../stores/useStoryboardStore'

describe('StoryboardAnalysisApp', () => {
  it('shows progress UI instead of an empty panel during active analysis', () => {
    useStoryboardStore.setState({
      analysisStatus: 'running',
      passStatuses: ['completed', 'pending', 'pending', 'pending', 'pending', 'completed', 'pending', 'completed'],
      passCards: [],
      progressPercentage: 38,
      formattedText: null,
      jsonText: null,
      storyboardResult: null,
    })

    render(<StoryboardAnalysisApp />)
    expect(screen.getByText('分析结果')).toBeInTheDocument()
    expect(screen.getByText(/步骤/)).toBeInTheDocument()
  })
})
```

**Step 2: Run test to verify the current empty-state problem**

Run: `npm run test:run -- src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx`

Expected: FAIL if the render tree still allows an empty dark panel with no fallback copy when status is `running` and result payloads are null.

**Step 3: Add a deterministic placeholder/fallback block**

```tsx
const hasResult = Boolean(formattedText || jsonText)

if (!hasResult && status === 'running') {
  return (
    <div className="p-6 text-sm text-white/60">
      正在生成分镜结果，请等待当前阶段完成。
    </div>
  )
}
```

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/understand/StoryboardAnalysisApp.tsx src/renderer/src/react-app/understand/StoryboardResult.tsx src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx
git commit -m "fix: add storyboard analysis loading fallback"
```

### Task 4: Verify the Full Image-Understanding Flow End to End

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardV4Pipeline.ts`
- Modify: `src/renderer/src/react-app/understand/main.tsx`
- Modify: `src/renderer/src/react-app/understand/StoryboardAnalysisApp.tsx`
- Test: `src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts`
- Test: `src/renderer/src/react-app/understand/__tests__/main.test.tsx`
- Test: `src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx`

**Step 1: Run the focused automated checks**

Run: `npm run test:run -- src/renderer/src/react-app/understand/__tests__/main.test.tsx src/renderer/src/react-app/understand/__tests__/useStoryboardStore.test.ts src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts`

Expected: PASS.

**Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS with no new TypeScript errors.

**Step 3: Manual verification in the Electron app**

Run: `npm run dev`

Expected:
- First analysis shows pass 0-7 in plausible order.
- `场景分析` / `身份锚点` / `空间/运动` / `动作/叙事` / `分镜生成` no longer stay at `等待中`.
- Second analysis can start immediately after the first without the result panel disappearing.
- While analysis is still running, the result area never renders as an empty dark rectangle.

**Step 4: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardV4Pipeline.ts src/renderer/src/react-app/understand/main.tsx src/renderer/src/react-app/understand/StoryboardAnalysisApp.tsx src/renderer/src/react-app/understand/StoryboardResult.tsx src/renderer/src/services/storyboard-pipeline/__tests__/StoryboardV4Pipeline.progress.test.ts src/renderer/src/react-app/understand/__tests__/main.test.tsx src/renderer/src/react-app/understand/__tests__/useStoryboardStore.test.ts src/renderer/src/react-app/understand/__tests__/StoryboardAnalysisApp.test.tsx
git commit -m "fix: stabilize storyboard analysis ui"
```

## Notes for Execution

- Use `@systematic-debugging` before changing progress logic again; the failure is specifically in the handoff between `task` dispatch messages and `task` completion messages.
- Use `@test-driven-development` for each task: write the regression first, then implement the smallest fix.
- Use `@verification-before-completion` before claiming the UI is fixed.
- Do not replace the whole pipeline architecture just to fix the UI; keep the solution DRY and narrowly focused on progress normalization and render safety.
