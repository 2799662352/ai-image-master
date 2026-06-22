# catimation Canvas (Image Loop) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt AI-Canvas's "generate → image holder → annotate → edit-by-annotation → new version to the right" loop into the existing catimation Electron app, reusing AI-Canvas's pure logic and the app's existing ToolRouter+IPC transport.

**Architecture:** tldraw is embedded in the renderer's Agent Workspace (Canvas tab). Pure logic (geometry/parser/prompt builders/shape ops) is ported verbatim into the renderer. Canvas MCP tools route via the existing `ToolRouter` → `agent:tool-request` IPC → `AgentToolExecutor` (renderer tools) or read/write a new main-process `EditRequestRegistry` (queue tools). The renderer parses annotations on the "按标注修图" button click and enqueues a ready edit request into the main registry; `watch_edit_requests` long-polls it.

**Tech Stack:** Electron, electron-vite, TypeScript, React, tldraw, `@modelcontextprotocol/server`, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-06-22-catimation-canvas-image-loop-design.md`

**Source to port from (in-repo, MIT):** `reference-projects/AI-Canvas/ai-canvas-codex-plugin/`

---

## File Structure

**Created:**
- `src/types/canvas.ts` — shared canvas data model (ported `shared/src/types.ts`), used by main + renderer.
- `src/renderer/src/features/agent-workspace/canvas/geometry.ts` — pure geometry (ported).
- `src/renderer/src/features/agent-workspace/canvas/annotationParser.ts` — annotation→instructions (ported).
- `src/renderer/src/features/agent-workspace/canvas/promptBuilders.ts` — generation/edit prompts + holder sizing (ported).
- `src/renderer/src/features/agent-workspace/canvas/shapeOps.ts` — tldraw editor ops (ported from `App.tsx`).
- `src/renderer/src/features/agent-workspace/canvas/__tests__/annotationParser.test.ts` — ported parser test.
- `src/main/mcp/canvas/EditRequestRegistry.ts` — main-process edit-request queue (mirrors `imageTaskRegistry.ts`).
- `src/main/mcp/canvas/__tests__/EditRequestRegistry.test.ts` — registry unit test.
- `src/main/mcp/tools/canvasTools.ts` — canvas MCP tool registration.
- `src/main/mcp/tools/__tests__/canvasTools.test.ts` — tool registration/routing test.

**Modified:**
- `src/main/mcp/tools/index.ts` — call `registerCanvasTools`.
- `src/main/agent/ipc.ts` — add `canvas:submit-edit-request` + `canvas:edit-queue-status` handlers.
- `src/preload/index.ts` — add canvas IPC channels + `canvas` API.
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` — dispatch `canvas_*` renderer tools.
- `src/renderer/src/features/agent-workspace/CanvasSection.tsx` — replace smoke surface with the real canvas (holder/image/annotation ops + button + status card).

---

## Task 1: Port the shared canvas data model

**Files:**
- Create: `src/types/canvas.ts`
- Source: `reference-projects/AI-Canvas/ai-canvas-codex-plugin/packages/shared/src/types.ts`

- [ ] **Step 1: Copy the types file**

Copy the FULL contents of the source `types.ts` into `src/types/canvas.ts`. It has no imports to fix (it is all `export interface` / `export type`). Keep every type: `AiCanvasRole`, `Bounds`, `Point`, `CanvasMetadata`, `AiCanvasShapeMeta`, `ShapeSummary`, `SelectionSnapshot`, `ImageGenerationRequest`, `ImageEditRequest`, `ImageResult`, `AnnotationInstruction`, `AnnotationPlanResult`, `PreparedImageGeneration`, `PreparedAnnotationEdit`, `EditRequestStatus`, `CanvasEditRequest`, `EditRequestPollResult`, `EditRequestQueueStatus`, `RunType`, `RunRecord`, `CanvasPendingOperationType`, `CanvasPendingOperation`, `VersionMetadata`, `CanvasStatePayload`.

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS (no new errors from `src/types/canvas.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/types/canvas.ts
git commit -m "feat(canvas): port AI-Canvas shared data model into src/types/canvas.ts"
```

---

## Task 2: Port geometry helpers

**Files:**
- Create: `src/renderer/src/features/agent-workspace/canvas/geometry.ts`
- Source: `reference-projects/AI-Canvas/ai-canvas-codex-plugin/packages/shared/src/geometry.ts`

- [ ] **Step 1: Copy the geometry file with one import edit**

Copy the FULL source `geometry.ts`. Change ONLY the import line:

```ts
// from:
import type { Bounds, Point } from './types.js'
// to:
import type { Bounds, Point } from '../../../../../types/canvas'
```

Keep every function unchanged: `clamp`, `center`, `distance`, `expanded`, `intersects`, `intersection`, `pointToRelativeRegion`, `boundsToRelativeRegion`.

- [ ] **Step 2: Verify the relative import path resolves**

Run: `npm run typecheck`
Expected: PASS. If the path is wrong, fix the number of `../` so it resolves to `src/types/canvas.ts` (from `src/renderer/src/features/agent-workspace/canvas/` that is five levels up: `../../../../../types/canvas`).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/features/agent-workspace/canvas/geometry.ts
git commit -m "feat(canvas): port geometry helpers"
```

---

## Task 3: Port the annotation parser (with its test)

**Files:**
- Create: `src/renderer/src/features/agent-workspace/canvas/annotationParser.ts`
- Create: `src/renderer/src/features/agent-workspace/canvas/__tests__/annotationParser.test.ts`
- Source: `reference-projects/AI-Canvas/ai-canvas-codex-plugin/packages/shared/src/annotationParser.ts`
- Test source: `reference-projects/AI-Canvas/ai-canvas-codex-plugin/packages/mcp-server/src/annotations/parseAnnotations.test.ts`

- [ ] **Step 1: Copy the parser test first (TDD: it should fail to import)**

Copy the FULL test source into `__tests__/annotationParser.test.ts`. Fix imports so it imports from the local parser:

```ts
import { parseAnnotations } from '../annotationParser'
import type { CanvasStatePayload } from '../../../../../types/canvas'
```

(If the test source imports `buildAnnotationEditPrompt` / `formatAnnotationInstruction`, import those from `../annotationParser` too.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/renderer/src/features/agent-workspace/canvas/__tests__/annotationParser.test.ts`
Expected: FAIL — cannot resolve `../annotationParser` (module not created yet).

- [ ] **Step 3: Copy the parser implementation**

Copy the FULL source `annotationParser.ts`. Fix the two import blocks:

```ts
import type {
  AnnotationInstruction,
  AnnotationPlanResult,
  Bounds,
  CanvasStatePayload,
  ShapeSummary
} from '../../../../../types/canvas'
import {
  boundsToRelativeRegion,
  center,
  distance,
  expanded,
  intersection,
  intersects,
  pointToRelativeRegion
} from './geometry'
```

Keep every function unchanged: `isAiImage`, `isAnnotationText`, `isArrow`, `isMark`, `nearestText`, `makeInstruction`, `chooseTarget`, `parseAnnotations`, `formatAnnotationInstruction`, `buildAnnotationEditPrompt`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/renderer/src/features/agent-workspace/canvas/__tests__/annotationParser.test.ts`
Expected: PASS (all ported cases green — proves the parser migrated correctly).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/agent-workspace/canvas/annotationParser.ts src/renderer/src/features/agent-workspace/canvas/__tests__/annotationParser.test.ts
git commit -m "feat(canvas): port annotation parser + migration test"
```

---

## Task 4: Port prompt builders + holder sizing

**Files:**
- Create: `src/renderer/src/features/agent-workspace/canvas/promptBuilders.ts`
- Source: `reference-projects/AI-Canvas/ai-canvas-codex-plugin/packages/mcp-server/src/index.ts` (functions `generationPrompt`, `editPrompt`, `holderSize`, `findPreferredHolder`, `formatAnnotation`)

- [ ] **Step 1: Create the module with the ported pure functions**

```ts
import type { AnnotationInstruction, CanvasStatePayload, ShapeSummary } from '../../../../../types/canvas'

export function holderSize(aspectRatio: string, input?: { w?: number; h?: number }): { w: number; h: number } {
  if (input?.w && input?.h) return { w: input.w, h: input.h }
  const [rawW, rawH] = aspectRatio.split(':').map((part) => Number(part))
  if (Number.isFinite(rawW) && Number.isFinite(rawH) && rawW > 0 && rawH > 0) {
    const base = 420
    return { w: base, h: Math.round((base * rawH) / rawW) }
  }
  return { w: 420, h: 588 }
}

export function findPreferredHolder(state: CanvasStatePayload): ShapeSummary | undefined {
  const selectedHolder = state.selection.shapes.find((shape) => shape.role === 'image_holder')
  if (selectedHolder) return selectedHolder
  const holders = state.shapes.filter((shape) => shape.role === 'image_holder')
  if (holders.length === 1) return holders[0]
  return undefined
}

export function generationPrompt(input: { request: string; aspectRatio: string; intendedUse?: string }): string {
  return [
    `请生成一张图片。`,
    ``,
    `用户需求：${input.request}`,
    `画面比例：${input.aspectRatio}`,
    input.intendedUse ? `用途：${input.intendedUse}` : undefined,
    `构图要求：主体明确，适合放入画布继续标注修改。`,
    `文字策略：如果用户要求标题、广告语或字体风格，请把文字作为画面创意的一部分直接设计进图片，充分发挥字体设计和排版能力。`,
    `避免：低清晰度、错乱文字、水印、畸形主体、杂乱背景。`,
  ]
    .filter(Boolean)
    .join('\n')
}

function formatAnnotation(annotation: AnnotationInstruction, index: number): string {
  const region = annotation.region
  return `${index + 1}. 在图片相对区域 x=${region.x.toFixed(2)}, y=${region.y.toFixed(2)}, w=${region.w.toFixed(2)}, h=${region.h.toFixed(2)}：${annotation.instruction}`
}

export function editPrompt(input: { userRequest?: string; annotations: AnnotationInstruction[] }): string {
  const annotationList = input.annotations.length
    ? input.annotations.map(formatAnnotation).join('\n')
    : '没有可靠的结构化标注。请优先保持原图不变，等待用户补充说明。'
  return [
    `基于输入图片进行编辑。保持整体构图、主体位置、光影风格、画面质感和品牌视觉风格不变。`,
    input.userRequest ? `用户补充要求：${input.userRequest}` : undefined,
    ``,
    `请根据以下画布标注进行修改：`,
    annotationList,
    ``,
    `不要改变：`,
    `- 未标注区域。`,
    `- 品牌名和主要标题，除非用户明确要求。`,
    `- 原图整体比例、风格和主体识别度。`,
    ``,
    `输出要求：与原图相同比例；修改自然；如果某条标注意图不明确，优先保持原样。`,
  ]
    .filter((line) => line !== undefined)
    .join('\n')
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/features/agent-workspace/canvas/promptBuilders.ts
git commit -m "feat(canvas): port prompt builders + holder sizing"
```

---

## Task 5: Port tldraw shape operations

**Files:**
- Create: `src/renderer/src/features/agent-workspace/canvas/shapeOps.ts`
- Source: `reference-projects/AI-Canvas/ai-canvas-codex-plugin/packages/canvas-app/src/App.tsx` (functions `getBounds`, `extractText`, `summarizeShape`, `loadImageDimensions`, and the bodies of `createHolder`, `insertImageIntoHolder`, `createImageVersion`)

This module wraps a tldraw `Editor` with the canvas operations. It is framework-free (no React) so it is unit-testable later and reusable from `CanvasSection`. The image source passed in is already a browser-loadable URL (data: URL); resolving an OS path → data URL happens in `CanvasSection` (Task 10) via `attachments.readThumb`.

- [ ] **Step 1: Create the module**

```ts
import { AssetRecordType, type Editor, createShapeId, getSnapshot, toRichText } from 'tldraw'
import type { Bounds, CanvasStatePayload, ShapeSummary } from '../../../../../types/canvas'

export function getBounds(editor: Editor, shape: { id: string; x?: number; y?: number; props?: { w?: number; h?: number } }): Bounds {
  const box = editor.getShapePageBounds(shape.id as never)
  if (box) return { x: box.x, y: box.y, w: box.w, h: box.h }
  return { x: shape.x ?? 0, y: shape.y ?? 0, w: shape.props?.w ?? 160, h: shape.props?.h ?? 120 }
}

export function extractText(editor: Editor, shape: { props?: Record<string, unknown> }): string | undefined {
  const props = shape.props ?? {}
  if (typeof props.text === 'string' && props.text.trim()) return props.text.trim()
  if (typeof props.label === 'string' && props.label.trim()) return props.label.trim()
  const richText = props.richText as { content?: unknown[] } | undefined
  if (!richText) return undefined
  const parts: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: unknown; content?: unknown[] }
    if (typeof n.text === 'string') parts.push(n.text)
    if (Array.isArray(n.content)) n.content.forEach(visit)
  }
  visit(richText)
  return parts.join('').trim() || undefined
}

export function summarizeShape(editor: Editor, shape: any): ShapeSummary {
  const meta = shape.meta ?? {}
  const bounds = getBounds(editor, shape)
  const summary: ShapeSummary = {
    id: shape.id,
    type: shape.type,
    role: meta.aiCanvasRole,
    bounds,
    text: extractText(editor, shape),
    color: shape.props?.color,
    aspectRatio: meta.aspectRatio,
    version: meta.version,
    parentShapeId: meta.parentShapeId,
    assetPath: meta.assetPath,
    assetUrl: meta.assetUrl,
    meta,
  }
  if (shape.type === 'arrow') {
    const start = shape.props?.start
    const end = shape.props?.end
    if (start && end) {
      summary.arrowStart = { x: (shape.x ?? 0) + start.x, y: (shape.y ?? 0) + start.y }
      summary.arrowEnd = { x: (shape.x ?? 0) + end.x, y: (shape.y ?? 0) + end.y }
    }
  }
  return summary
}

export function readCanvasState(editor: Editor, base: CanvasStatePayload): CanvasStatePayload {
  const shapes = editor.getCurrentPageShapes().map((shape) => summarizeShape(editor, shape))
  const selectedShapeIds = editor.getSelectedShapeIds().map(String)
  const selectionShapes = shapes.filter((shape) => selectedShapeIds.includes(shape.id))
  return {
    ...base,
    snapshot: getSnapshot(editor.store),
    shapes,
    selection: {
      canvasId: base.canvasId,
      pageId: base.metadata.activePageId,
      selectedShapeIds,
      shapes: selectionShapes,
    },
  }
}

function loadImageDimensions(src: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve({ w: image.naturalWidth || 1024, h: image.naturalHeight || 1024 })
    image.onerror = () => reject(new Error(`Could not load image: ${src}`))
    image.src = src
  })
}

export function createHolder(editor: Editor, payload: Record<string, unknown>): { shapeId: string; bounds: Bounds } {
  const shapeId = (payload.shapeId ? String(payload.shapeId) : createShapeId(`holder_${crypto.randomUUID().slice(0, 8)}`)) as never
  const x = Number(payload.x ?? 100)
  const y = Number(payload.y ?? 100)
  const w = Number(payload.w ?? 403)
  const h = Number(payload.h ?? 567)
  const label = String(payload.label ?? 'AI 图片')
  if (editor.getShape(shapeId)) {
    editor.select(shapeId)
    return { shapeId: String(shapeId), bounds: { x, y, w, h } }
  }
  editor.createShape({
    id: shapeId,
    type: 'geo',
    x,
    y,
    props: { w, h, geo: 'rectangle', dash: 'dashed', color: 'blue', fill: 'none', size: 'm', richText: toRichText(label), align: 'middle', verticalAlign: 'middle' },
    meta: { aiCanvasRole: 'image_holder', aspectRatio: String(payload.aspectRatio ?? '5:7'), acceptsGeneratedImage: true, title: label },
  } as never)
  editor.select(shapeId)
  return { shapeId: String(shapeId), bounds: { x, y, w, h } }
}

export async function insertImageIntoHolder(
  editor: Editor,
  payload: { holderShapeId: string; assetUrl: string; assetPath?: string; imageShapeId?: string; title?: string; runId?: string },
): Promise<{ imageShapeId: string; bounds: Bounds; version: number }> {
  const holder = editor.getShape(payload.holderShapeId as never) as any
  if (!holder) throw new Error(`Holder not found: ${payload.holderShapeId}`)
  const bounds = getBounds(editor, holder)
  const natural = await loadImageDimensions(payload.assetUrl)
  const assetId = AssetRecordType.createId()
  const imageShapeId = (payload.imageShapeId ? String(payload.imageShapeId) : createShapeId(`image_${crypto.randomUUID().slice(0, 8)}`)) as never
  const title = String(payload.title ?? holder.meta?.title ?? 'AI 图片')
  editor.createAssets([
    { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: 'image/png', isAnimated: false }, meta: { assetPath: payload.assetPath, sourceRunId: payload.runId } } as never,
  ])
  editor.createShape({
    id: imageShapeId,
    type: 'image',
    x: bounds.x,
    y: bounds.y,
    props: { assetId, w: bounds.w, h: bounds.h, altText: title },
    meta: { aiCanvasRole: 'ai_image', holderId: payload.holderShapeId, sourceRunId: payload.runId, version: 1, assetPath: payload.assetPath, assetUrl: payload.assetUrl, title },
  } as never)
  editor.bringToFront([imageShapeId])
  editor.select(imageShapeId)
  return { imageShapeId: String(imageShapeId), bounds, version: 1 }
}

export async function createImageVersion(
  editor: Editor,
  payload: { sourceShapeId: string; assetUrl: string; assetPath?: string; newShapeId?: string; title?: string; runId?: string; version?: number },
): Promise<{ newShapeId: string; version: number; parentShapeId: string }> {
  const source = editor.getShape(payload.sourceShapeId as never) as any
  if (!source) throw new Error(`Source image not found: ${payload.sourceShapeId}`)
  const sourceBounds = getBounds(editor, source)
  const natural = await loadImageDimensions(payload.assetUrl)
  const assetId = AssetRecordType.createId()
  const newShapeId = (payload.newShapeId ? String(payload.newShapeId) : createShapeId(`image_${crypto.randomUUID().slice(0, 8)}`)) as never
  const version = Number(payload.version ?? Number(source.meta?.version ?? 1) + 1)
  const x = sourceBounds.x + sourceBounds.w + 80
  const y = sourceBounds.y
  const title = String(payload.title ?? `AI 图片 v${version}`)
  editor.createAssets([
    { id: assetId, typeName: 'asset', type: 'image', props: { name: title, src: payload.assetUrl, w: natural.w, h: natural.h, mimeType: 'image/png', isAnimated: false }, meta: { assetPath: payload.assetPath, sourceRunId: payload.runId } } as never,
  ])
  editor.createShape({
    id: newShapeId,
    type: 'image',
    x,
    y,
    props: { assetId, w: sourceBounds.w, h: sourceBounds.h, altText: title },
    meta: { aiCanvasRole: 'ai_image', holderId: source.meta?.holderId, parentShapeId: payload.sourceShapeId, sourceRunId: payload.runId, version, assetPath: payload.assetPath, assetUrl: payload.assetUrl, title },
  } as never)
  editor.createShape({
    id: createShapeId(`version_arrow_${crypto.randomUUID().slice(0, 8)}`) as never,
    type: 'arrow',
    x: sourceBounds.x + sourceBounds.w + 20,
    y: sourceBounds.y + sourceBounds.h / 2,
    props: { start: { x: 0, y: 0 }, end: { x: 42, y: 0 }, color: 'blue', size: 's', arrowheadEnd: 'arrow', text: '', bend: 0 },
    meta: { aiCanvasRole: 'version_group', parentShapeId: payload.sourceShapeId },
  } as never)
  editor.select(newShapeId)
  return { newShapeId: String(newShapeId), version, parentShapeId: payload.sourceShapeId }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS. tldraw's editor types are loose around `createShape`; the `as never` casts mirror the `as any` casts in the AI-Canvas source and are expected.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/features/agent-workspace/canvas/shapeOps.ts
git commit -m "feat(canvas): port tldraw shape operations (holder/insert/version/summarize)"
```

---

## Task 6: Main-process EditRequestRegistry (mirrors imageTaskManager)

**Files:**
- Create: `src/main/mcp/canvas/EditRequestRegistry.ts`
- Test: `src/main/mcp/canvas/__tests__/EditRequestRegistry.test.ts`
- Pattern reference: `src/main/mcp/tools/imageTaskRegistry.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { EditRequestRegistry } from '../EditRequestRegistry'
import type { CanvasEditRequest } from '../../../../types/canvas'

function makeRequest(): Omit<CanvasEditRequest, 'requestId' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'> {
  return {
    targetShapeId: 'shape:img1',
    targetImagePath: 'C:/tmp/img1.png',
    annotationPlan: [],
    needsClarification: false,
    storagePath: '',
    editPrompt: 'edit it',
    readyToEdit: true,
    canAutoEdit: true,
    source: 'canvas_button',
    codexInstruction: 'edit it',
  }
}

describe('EditRequestRegistry', () => {
  it('enqueues and returns a queued request via waitForNext', async () => {
    const reg = new EditRequestRegistry()
    const enqueued = reg.enqueue(makeRequest())
    const poll = await reg.waitForNext(50, { claim: true })
    expect(poll.request?.requestId).toBe(enqueued.requestId)
    expect(poll.timedOut).toBe(false)
  })

  it('times out when no request is queued', async () => {
    const reg = new EditRequestRegistry()
    const poll = await reg.waitForNext(30, { claim: true })
    expect(poll.request).toBeUndefined()
    expect(poll.timedOut).toBe(true)
  })

  it('marks claimed requests processing so they are not handed out twice', async () => {
    const reg = new EditRequestRegistry()
    reg.enqueue(makeRequest())
    const first = await reg.waitForNext(30, { claim: true })
    const second = await reg.waitForNext(30, { claim: true })
    expect(first.request).toBeDefined()
    expect(second.request).toBeUndefined()
  })

  it('updates status and is readable by id', () => {
    const reg = new EditRequestRegistry()
    const r = reg.enqueue(makeRequest())
    reg.update(r.requestId, 'completed', { ok: true })
    expect(reg.get(r.requestId)?.status).toBe('completed')
  })

  it('reports queue status counts and listener activity', async () => {
    const reg = new EditRequestRegistry()
    reg.enqueue(makeRequest())
    const status = reg.getStatus()
    expect(status.queuedCount).toBe(1)
    const wait = reg.waitForNext(40, { claim: true })
    expect(reg.getStatus().listenerActive).toBe(true)
    await wait
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/mcp/canvas/__tests__/EditRequestRegistry.test.ts`
Expected: FAIL — cannot resolve `../EditRequestRegistry`.

- [ ] **Step 3: Implement the registry**

```ts
import { randomUUID } from 'node:crypto'
import type { CanvasEditRequest, EditRequestPollResult, EditRequestQueueStatus } from '../../../types/canvas'

type NewRequest = Omit<CanvasEditRequest, 'requestId' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'>

const TTL_AFTER_TERMINAL_MS = 30 * 60_000
const LISTENER_ACTIVE_WINDOW_MS = 30_000

export class EditRequestRegistry {
  private requests = new Map<string, CanvasEditRequest>()
  private waiters = new Set<() => void>()
  private lastListenerSeenAt = 0

  enqueue(input: NewRequest): CanvasEditRequest {
    this.gc()
    const now = new Date().toISOString()
    const request: CanvasEditRequest = { ...input, requestId: randomUUID(), status: 'queued', attempts: 0, createdAt: now, updatedAt: now }
    this.requests.set(request.requestId, request)
    for (const wake of this.waiters) wake()
    return request
  }

  get(requestId: string): CanvasEditRequest | undefined {
    return this.requests.get(requestId)
  }

  update(requestId: string, status: CanvasEditRequest['status'], result?: Record<string, unknown>, error?: string): CanvasEditRequest | undefined {
    const request = this.requests.get(requestId)
    if (!request) return undefined
    request.status = status
    request.updatedAt = new Date().toISOString()
    if (result !== undefined) request.result = result
    if (error !== undefined) request.error = error
    if (status === 'completed') request.completedAt = request.updatedAt
    return request
  }

  /** Long-poll for the next queued request. Marks it processing when `claim`. */
  async waitForNext(timeoutMs: number, opts: { claim: boolean }): Promise<EditRequestPollResult> {
    this.lastListenerSeenAt = Date.now()
    const take = (): CanvasEditRequest | undefined => {
      const next = [...this.requests.values()].find((r) => r.status === 'queued')
      if (next && opts.claim) {
        next.status = 'processing'
        next.claimedAt = new Date().toISOString()
        next.updatedAt = next.claimedAt
      }
      return next
    }
    const immediate = take()
    if (immediate) return { request: immediate, timedOut: false, message: 'Edit request ready.' }

    await new Promise<void>((resolve) => {
      let settled = false
      const wake = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      this.waiters.add(wake)
    })

    this.lastListenerSeenAt = Date.now()
    const after = take()
    return after
      ? { request: after, timedOut: false, message: 'Edit request ready.' }
      : { request: undefined, timedOut: true, message: 'No queued edit request yet. Waiting for the user to annotate and click 按标注修图.' }
  }

  getStatus(): EditRequestQueueStatus {
    const values = [...this.requests.values()]
    return {
      listenerActive: Date.now() - this.lastListenerSeenAt < LISTENER_ACTIVE_WINDOW_MS,
      listenerLastSeenAt: this.lastListenerSeenAt ? new Date(this.lastListenerSeenAt).toISOString() : undefined,
      listenerActiveWindowMs: LISTENER_ACTIVE_WINDOW_MS,
      queuedCount: values.filter((r) => r.status === 'queued').length,
      processingCount: values.filter((r) => r.status === 'processing').length,
      latestRequest: values.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0],
      updatedAt: new Date().toISOString(),
    }
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, r] of this.requests) {
      const terminal = r.status === 'completed' || r.status === 'failed'
      if (terminal && now - Date.parse(r.updatedAt) > TTL_AFTER_TERMINAL_MS) this.requests.delete(id)
    }
  }
}

export const editRequestRegistry = new EditRequestRegistry()
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/main/mcp/canvas/__tests__/EditRequestRegistry.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/mcp/canvas/EditRequestRegistry.ts src/main/mcp/canvas/__tests__/EditRequestRegistry.test.ts
git commit -m "feat(canvas): add main-process EditRequestRegistry with long-poll"
```

---

## Task 7: Canvas IPC (renderer → main enqueue + status)

**Files:**
- Modify: `src/preload/index.ts` (IPC_CHANNELS.AGENT block near line 224, and the agent API block near line 957)
- Modify: `src/main/agent/ipc.ts` (near the `image:task-update` handler at line 368)

- [ ] **Step 1: Add channel constants in preload**

In `src/preload/index.ts`, inside `IPC_CHANNELS.AGENT` (after `IMAGE_TASK_UPDATE: 'image:task-update',`), add:

```ts
    CANVAS_SUBMIT_EDIT_REQUEST: 'canvas:submit-edit-request',
    CANVAS_EDIT_QUEUE_STATUS: 'canvas:edit-queue-status',
```

- [ ] **Step 2: Expose the canvas API in preload**

In `src/preload/index.ts`, in the exposed `agent` API object (where `sendImageTaskUpdate` is defined near line 968), add two methods. Use `ipcRenderer.send` for the fire-and-forget enqueue and `ipcRenderer.invoke` for status:

```ts
    submitCanvasEditRequest: (request: unknown) => {
      ipcRenderer.send('canvas:submit-edit-request', request)
    },
    getCanvasEditQueueStatus: () => ipcRenderer.invoke('canvas:edit-queue-status'),
```

Also add their types to the `agent` interface declaration near line 455:

```ts
    submitCanvasEditRequest: (request: unknown) => void
    getCanvasEditQueueStatus: () => Promise<import('../types/canvas').EditRequestQueueStatus>
```

- [ ] **Step 3: Handle the channels in main**

In `src/main/agent/ipc.ts`, import the registry at the top (with the other imports):

```ts
import { editRequestRegistry } from '../mcp/canvas/EditRequestRegistry'
```

Then, right after the `image:task-update` handler (line ~370), add:

```ts
  // Renderer enqueues a fully-parsed edit request (annotation plan + edit
  // prompt + input image path) when the user clicks 按标注修图. watch_edit_requests
  // (MCP tool) long-polls the registry for it.
  ipcMain.on('canvas:submit-edit-request', (_event, request) => {
    if (request && typeof request === 'object') editRequestRegistry.enqueue(request)
  })

  ipcMain.handle('canvas:edit-queue-status', () => editRequestRegistry.getStatus())
```

- [ ] **Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/main/agent/ipc.ts
git commit -m "feat(canvas): wire canvas edit-request IPC (submit + status)"
```

---

## Task 8: Canvas MCP tools

**Files:**
- Create: `src/main/mcp/tools/canvasTools.ts`
- Test: `src/main/mcp/tools/__tests__/canvasTools.test.ts`
- Modify: `src/main/mcp/tools/index.ts`
- Pattern reference: `src/main/mcp/tools/uiTools.ts` (renderer tool), `src/main/mcp/tools/imageTools.ts` (main long-poll)

Renderer tools call `router.call(name, params)`. Queue tools (`watch_edit_requests`, `get_edit_request`, `update_edit_request`) read/write `editRequestRegistry` directly via `router.registerMain`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from 'vitest'
import { registerCanvasTools } from '../canvasTools'
import { editRequestRegistry } from '../../canvas/EditRequestRegistry'

function fakeServerAndRouter() {
  const tools = new Map<string, (params: any, ctx?: unknown) => Promise<unknown>>()
  const server = { registerTool: (name: string, _schema: unknown, handler: any) => tools.set(name, handler) } as any
  const mains = new Map<string, (params: any) => Promise<unknown>>()
  const router = {
    registerMain: (name: string, h: any) => mains.set(name, h),
    call: vi.fn(async () => ({ ok: true })),
  } as any
  return { tools, server, router, mains }
}

describe('registerCanvasTools', () => {
  it('registers renderer + queue tools', () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerCanvasTools(server, router)
    for (const name of ['canvas_open', 'create_image_holder', 'insert_image_into_holder', 'collect_annotations', 'create_image_version', 'save_snapshot', 'watch_edit_requests', 'get_edit_request', 'update_edit_request']) {
      expect(tools.has(name)).toBe(true)
    }
  })

  it('routes create_image_holder to the renderer via router.call', async () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerCanvasTools(server, router)
    await tools.get('create_image_holder')!({ label: 'x', aspectRatio: '1:1' })
    expect(router.call).toHaveBeenCalledWith('create_image_holder', expect.objectContaining({ label: 'x' }), undefined)
  })

  it('watch_edit_requests returns a queued request from the registry', async () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerCanvasTools(server, router)
    editRequestRegistry.enqueue({
      targetShapeId: 'shape:i', annotationPlan: [], needsClarification: false, storagePath: '',
      editPrompt: 'p', readyToEdit: true, canAutoEdit: true, source: 'canvas_button', codexInstruction: 'p',
    })
    const res: any = await tools.get('watch_edit_requests')!({ waitMs: 50 })
    expect(JSON.stringify(res)).toContain('requestId')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/mcp/tools/__tests__/canvasTools.test.ts`
Expected: FAIL — cannot resolve `../canvasTools`.

- [ ] **Step 3: Implement the tools**

```ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { editRequestRegistry } from '../canvas/EditRequestRegistry'

function asResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> }
}

const WATCH_LONG_POLL_MS = 25_000

export function registerCanvasTools(server: McpServer, router: ToolRouter): void {
  // ---- Renderer-routed tools ----
  server.registerTool('canvas_open', {
    description: 'Open the CATIMATION canvas (Agent Workspace → Canvas tab). Call this first before creating holders or inserting images.',
    inputSchema: z.object({}),
  }, async () => asResult(await router.call('canvas_open', {})))

  server.registerTool('prepare_image_generation', {
    description: 'Open the canvas, ensure an image holder exists, and return the holder id + a suggested generation prompt. Then call generate_image, then insert_image_into_holder.',
    inputSchema: z.object({
      request: z.string().min(1).describe('What the user wants the image to be.'),
      aspectRatio: z.string().default('5:7').describe('Aspect ratio like 1:1, 16:9, 5:7.'),
      intendedUse: z.string().optional(),
      label: z.string().optional(),
    }),
  }, async (params) => asResult(await router.call('prepare_image_generation', params as Record<string, unknown>)))

  server.registerTool('create_image_holder', {
    description: 'Create a dashed image-holder rectangle on the canvas to receive a generated image.',
    inputSchema: z.object({
      label: z.string().optional(),
      aspectRatio: z.string().default('5:7'),
      x: z.number().optional(),
      y: z.number().optional(),
      w: z.number().optional(),
      h: z.number().optional(),
    }),
  }, async (params, ctx?: unknown) => asResult(await router.call('create_image_holder', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('insert_image_into_holder', {
    description: 'Place a generated image (local file path from generate_image) over a holder as version 1.',
    inputSchema: z.object({
      holderShapeId: z.string().min(1),
      imagePath: z.string().min(1).describe('Local file path returned by generate_image.'),
      title: z.string().optional(),
    }),
  }, async (params, ctx?: unknown) => asResult(await router.call('insert_image_into_holder', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('collect_annotations', {
    description: 'Read the canvas and return the structured annotation plan (arrows/text/circles) for the target AI image.',
    inputSchema: z.object({ targetShapeId: z.string().optional(), radius: z.number().default(420) }),
  }, async (params) => asResult(await router.call('collect_annotations', params as Record<string, unknown>)))

  server.registerTool('prepare_annotation_edit', {
    description: 'Collect annotations and return a ready edit prompt + input image path for the target AI image.',
    inputSchema: z.object({ targetShapeId: z.string().optional(), radius: z.number().default(420), userRequest: z.string().optional() }),
  }, async (params) => asResult(await router.call('prepare_annotation_edit', params as Record<string, unknown>)))

  server.registerTool('create_image_version', {
    description: 'Place an edited image (local file path) as a new version to the RIGHT of the source image, keeping the old one.',
    inputSchema: z.object({ sourceShapeId: z.string().min(1), imagePath: z.string().min(1), title: z.string().optional() }),
  }, async (params, ctx?: unknown) => asResult(await router.call('create_image_version', params as Record<string, unknown>, extractThreadId(ctx))))

  server.registerTool('save_snapshot', {
    description: 'Force-persist the current canvas snapshot.',
    inputSchema: z.object({}),
  }, async () => asResult(await router.call('save_snapshot', {})))

  // ---- Queue tools (main process) ----
  router.registerMain('__noop_canvas__', async () => ({ ok: true })) // ensures ToolRouter is the main-tool owner; harmless.

  server.registerTool('watch_edit_requests', {
    description: 'Wait for an edit request submitted from the canvas 按标注修图 button (auto-edit mode). Long-polls ~25s; keep calling until a request arrives. When one arrives, call generate_image with its editPrompt + targetImagePath as referenceImages, then create_image_version, then update_edit_request(completed).',
    inputSchema: z.object({ waitMs: z.number().int().min(0).max(WATCH_LONG_POLL_MS).optional(), claim: z.boolean().default(true) }),
  }, async (params) => {
    const p = params as { waitMs?: number; claim?: boolean }
    const result = await editRequestRegistry.waitForNext(Math.min(p.waitMs ?? WATCH_LONG_POLL_MS, WATCH_LONG_POLL_MS), { claim: p.claim !== false })
    return asResult(result)
  })

  server.registerTool('get_edit_request', {
    description: 'Read one edit request by id.',
    inputSchema: z.object({ requestId: z.string().min(1) }),
  }, async (params) => asResult(editRequestRegistry.get((params as { requestId: string }).requestId) ?? { error: 'not found' }))

  server.registerTool('update_edit_request', {
    description: 'Mark an edit request completed / failed / processing / needs_clarification.',
    inputSchema: z.object({
      requestId: z.string().min(1),
      status: z.enum(['queued', 'processing', 'completed', 'failed', 'needs_clarification']),
      result: z.record(z.unknown()).optional(),
      error: z.string().optional(),
    }),
  }, async (params) => {
    const p = params as { requestId: string; status: any; result?: Record<string, unknown>; error?: string }
    return asResult(editRequestRegistry.update(p.requestId, p.status, p.result, p.error) ?? { error: 'not found' })
  })
}

/** Pull the codex thread id from a tool-call ctx (same shape as imageTools.extractCodexThreadId). */
function extractThreadId(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: { threadId?: unknown } } } | undefined)?.mcpReq?._meta
  return typeof meta?.threadId === 'string' && meta.threadId.length > 0 ? meta.threadId : undefined
}
```

> Note: remove the `__noop_canvas__` line if `ToolRouter` already has main handlers registered elsewhere — it exists only to document that queue tools resolve in-process and is safe to delete. If kept, it does nothing.

- [ ] **Step 4: Register in tools/index.ts**

In `src/main/mcp/tools/index.ts`, add the import and call:

```ts
import { registerCanvasTools } from './canvasTools'
// ...inside registerTools(server, router):
  registerCanvasTools(server, router)
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/main/mcp/tools/__tests__/canvasTools.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/tools/canvasTools.ts src/main/mcp/tools/__tests__/canvasTools.test.ts src/main/mcp/tools/index.ts
git commit -m "feat(canvas): add canvas MCP tools (renderer ops + edit-request queue)"
```

---

## Task 9: Dispatch canvas_* renderer tools in AgentToolExecutor

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` (the `call()` switch near line 191, and the `AgentElectronApi.agent` type near line 60)

The executor needs a handle to the live tldraw editor + canvas state. Task 10 exposes those through a small module-level bridge `canvasBridge` so the executor (which is not a React component) can reach the editor.

- [ ] **Step 1: Add canvas tool cases to the `call()` switch**

In `AgentToolExecutor.call()`, add cases before `default:`:

```ts
      case 'canvas_open':
      case 'prepare_image_generation':
      case 'create_image_holder':
      case 'insert_image_into_holder':
      case 'collect_annotations':
      case 'prepare_annotation_edit':
      case 'create_image_version':
      case 'save_snapshot':
        return this.callCanvas(toolName, params)
```

- [ ] **Step 2: Add the `callCanvas` method**

Add this import at the top of the file:

```ts
import { canvasBridge } from '../agent-workspace/canvas/canvasBridge'
```

Add this method to the class:

```ts
  private async callCanvas(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    return canvasBridge.handle(toolName, params)
  }
```

- [ ] **Step 3: Verify typecheck (will fail until Task 10 creates canvasBridge)**

Run: `npm run typecheck`
Expected: FAIL — cannot find `../agent-workspace/canvas/canvasBridge`. This is expected; Task 10 creates it. Proceed to Task 10 before committing.

- [ ] **Step 4: Defer commit to end of Task 10**

(Do not commit a non-compiling state; Task 10 completes this.)

---

## Task 10: CanvasSection — real canvas surface + bridge + button + status card

**Files:**
- Create: `src/renderer/src/features/agent-workspace/canvas/canvasBridge.ts`
- Modify: `src/renderer/src/features/agent-workspace/CanvasSection.tsx`

`canvasBridge` is a module-level singleton holding the live `Editor` and base `CanvasStatePayload`. `CanvasSection` registers the editor on mount; the bridge implements each `canvas_*` tool against `shapeOps`, resolving image paths to data URLs via `attachments.readThumb`.

- [ ] **Step 1: Create the bridge**

```ts
import type { Editor } from 'tldraw'
import type { CanvasStatePayload } from '../../../../../types/canvas'
import { createHolder, createImageVersion, insertImageIntoHolder, readCanvasState } from './shapeOps'
import { parseAnnotations } from './annotationParser'
import { editPrompt, findPreferredHolder, generationPrompt, holderSize } from './promptBuilders'

type AttachmentsApi = { readThumb: (p: string) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }> }

const BASE_STATE: CanvasStatePayload = {
  canvasId: 'catimation-canvas',
  metadata: { canvasId: 'catimation-canvas', name: 'CATIMATION Canvas', createdAt: '', updatedAt: '', workspaceRoot: '', activePageId: 'page:main', appVersion: '1' },
  storagePath: '',
  selection: { canvasId: 'catimation-canvas', pageId: 'page:main', selectedShapeIds: [], shapes: [] },
  shapes: [],
}

class CanvasBridge {
  private editor: Editor | null = null

  setEditor(editor: Editor | null): void {
    this.editor = editor
  }

  private requireEditor(): Editor {
    if (!this.editor) throw new Error('Canvas is not open. Ask the user to open the Canvas tab, or call canvas_open first.')
    return this.editor
  }

  private state(): CanvasStatePayload {
    return readCanvasState(this.requireEditor(), BASE_STATE)
  }

  /** Resolve a local file path (or data/http URL) to a browser-loadable src. */
  private async toLoadable(pathOrUrl: string): Promise<string> {
    if (pathOrUrl.startsWith('data:') || pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl
    const api = (window as Window & { electronAPI?: { attachments?: AttachmentsApi } }).electronAPI?.attachments
    if (!api?.readThumb) throw new Error('attachments API unavailable to load image')
    const res = await api.readThumb(pathOrUrl)
    if (!res.ok) throw new Error(`Cannot read image ${pathOrUrl}: ${res.reason}`)
    return `data:${res.mime};base64,${res.base64}`
  }

  async handle(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'canvas_open':
        return { opened: true }
      case 'prepare_image_generation': {
        const editor = this.requireEditor()
        const aspectRatio = String(params.aspectRatio ?? '5:7')
        let holder = findPreferredHolder(this.state())
        if (!holder) {
          const size = holderSize(aspectRatio)
          const created = createHolder(editor, { label: params.label, aspectRatio, ...size })
          holder = this.state().shapes.find((s) => s.id === created.shapeId)
        }
        return {
          readyToGenerate: true,
          holderShapeId: holder?.id,
          holderBounds: holder?.bounds,
          aspectRatio: holder?.aspectRatio ?? aspectRatio,
          suggestedPrompt: generationPrompt({ request: String(params.request ?? ''), aspectRatio: holder?.aspectRatio ?? aspectRatio, intendedUse: params.intendedUse as string | undefined }),
        }
      }
      case 'create_image_holder':
        return createHolder(this.requireEditor(), params)
      case 'insert_image_into_holder': {
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return insertImageIntoHolder(this.requireEditor(), { holderShapeId: String(params.holderShapeId), assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined })
      }
      case 'collect_annotations':
        return parseAnnotations({ state: this.state(), targetShapeId: params.targetShapeId as string | undefined, radius: Number(params.radius ?? 420) })
      case 'prepare_annotation_edit': {
        const plan = parseAnnotations({ state: this.state(), targetShapeId: params.targetShapeId as string | undefined, radius: Number(params.radius ?? 420) })
        return { ...plan, editPrompt: editPrompt({ userRequest: params.userRequest as string | undefined, annotations: plan.annotationPlan }) }
      }
      case 'create_image_version': {
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return createImageVersion(this.requireEditor(), { sourceShapeId: String(params.sourceShapeId), assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined })
      }
      case 'save_snapshot':
        // tldraw persistenceKey already persists; reading state is enough to flush listeners.
        this.state()
        return { ok: true }
      default:
        throw new Error(`Unknown canvas tool: ${toolName}`)
    }
  }

  /** Build + submit an edit request from the current annotations (button click). */
  buildEditRequest(targetShapeId: string | undefined): { ok: boolean; reason?: string; requestPayload?: Record<string, unknown> } {
    const state = this.state()
    const plan = parseAnnotations({ state, targetShapeId, radius: 420 })
    const target = state.shapes.find((s) => s.id === plan.targetShapeId)
    if (!plan.targetShapeId || !target) return { ok: false, reason: plan.clarificationReason ?? '没有可修改的 AI 图片。' }
    const prompt = editPrompt({ annotations: plan.annotationPlan })
    return {
      ok: true,
      requestPayload: {
        targetShapeId: plan.targetShapeId,
        targetImagePath: target.assetPath,
        annotationPlan: plan.annotationPlan,
        needsClarification: plan.needsClarification,
        clarificationReason: plan.clarificationReason,
        storagePath: '',
        editPrompt: prompt,
        readyToEdit: !plan.needsClarification,
        canAutoEdit: !plan.needsClarification,
        source: 'canvas_button',
        codexInstruction: prompt,
      },
    }
  }
}

export const canvasBridge = new CanvasBridge()
```

- [ ] **Step 2: Rewrite CanvasSection to register the editor + button + status**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import { type Editor, Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import type { EditRequestQueueStatus } from '../../../../types/canvas'
import { canvasBridge } from './canvas/canvasBridge'

type CanvasAgentApi = {
  submitCanvasEditRequest: (request: unknown) => void
  getCanvasEditQueueStatus: () => Promise<EditRequestQueueStatus>
}

function getCanvasApi(): CanvasAgentApi | undefined {
  return (window as Window & { electronAPI?: { agent?: CanvasAgentApi } }).electronAPI?.agent
}

export function CanvasSection(): React.JSX.Element {
  const editorRef = useRef<Editor | null>(null)
  const [status, setStatus] = useState<EditRequestQueueStatus | null>(null)
  const [notice, setNotice] = useState<string>('图片好了就可以标注，标完点「按标注修图」。')

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    canvasBridge.setEditor(editor)
    return () => {
      canvasBridge.setEditor(null)
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const poll = async () => {
      const api = getCanvasApi()
      if (!api) return
      try {
        const s = await api.getCanvasEditQueueStatus()
        if (!disposed) setStatus(s)
      } catch { /* ignore */ }
    }
    void poll()
    const id = window.setInterval(poll, 5000)
    return () => { disposed = true; window.clearInterval(id) }
  }, [])

  const onSubmitEdit = useCallback(() => {
    const target = editorRef.current?.getSelectedShapeIds().map(String)[0]
    const built = canvasBridge.buildEditRequest(target)
    if (!built.ok || !built.requestPayload) {
      setNotice(built.reason ?? '无法提交修图。')
      return
    }
    getCanvasApi()?.submitCanvasEditRequest(built.requestPayload)
    setNotice('已提交标注。Codex 监听到后会自动修图，新版放到旧图右侧。')
  }, [])

  const listenerLabel = status?.processingCount
    ? 'Codex 正在修图…'
    : status?.listenerActive
      ? 'Codex 监听中：标完点「按标注修图」'
      : 'Codex 未监听：回到聊天说「开启自动修图」'

  return (
    <div className="flex h-[80vh] w-full gap-3">
      <div className="relative flex-1 overflow-hidden rounded-lg border border-zinc-800/60">
        <Tldraw persistenceKey="catimation-canvas" onMount={handleMount} />
      </div>
      <aside className="flex w-64 shrink-0 flex-col gap-3 rounded-lg border border-zinc-800/60 p-3 text-sm">
        <div className="rounded bg-zinc-900/60 p-2 text-zinc-300">{listenerLabel}</div>
        <button
          type="button"
          onClick={onSubmitEdit}
          className="rounded bg-blue-600 px-3 py-2 font-medium text-white hover:bg-blue-500"
        >
          按标注修图
        </button>
        <p className="text-zinc-400">{notice}</p>
        {status ? (
          <div className="mt-auto text-xs text-zinc-500">
            queued {status.queuedCount} · processing {status.processingCount}
          </div>
        ) : null}
      </aside>
    </div>
  )
}
```

- [ ] **Step 3: Verify typecheck now passes (completes Task 9 + 10)**

Run: `npm run typecheck`
Expected: PASS (AgentToolExecutor's `canvasBridge` import now resolves).

- [ ] **Step 4: Build the renderer**

Run: `npm run build:vite`
Expected: build completes with no errors.

- [ ] **Step 5: Commit (Tasks 9 + 10 together)**

```bash
git add src/renderer/src/features/agent-chat/AgentToolExecutor.ts src/renderer/src/features/agent-workspace/canvas/canvasBridge.ts src/renderer/src/features/agent-workspace/CanvasSection.tsx
git commit -m "feat(canvas): wire canvas bridge, renderer tool dispatch, button + status card"
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all new + related unit tests**

Run: `npx vitest run src/renderer/src/features/agent-workspace/canvas src/main/mcp/canvas src/main/mcp/tools/__tests__/canvasTools.test.ts`
Expected: all PASS.

- [ ] **Step 2: Typecheck + lint the touched files**

Run: `npm run typecheck`
Expected: PASS (no NEW errors vs. the pre-existing baseline).

- [ ] **Step 3: Build**

Run: `npm run build:vite`
Expected: PASS.

- [ ] **Step 4: Manual smoke (user-driven, documented for the report)**

In the running app: open Agent Workspace → Canvas tab. In chat ask the agent to "打开画布做一张拉面广告". Verify: holder appears → image inserted (v1) → draw an arrow + text → click 按标注修图 → agent picks it up via `watch_edit_requests` → edited image appears to the right (v2) with arrow.

- [ ] **Step 5: Commit any verification fixups**

```bash
git add -A
git commit -m "test(canvas): verification pass for image-loop MVP"
```

---

## Self-Review

**Spec coverage:**
- §2 复用边界 (port/drop/rewrite): Tasks 1–5 (port pure logic + shape ops), Task 8 (rewrite tool shells to router/registry). ✅
- §3 代码落位: matches File Structure above. ✅
- §4 队列放主进程: Task 6 (EditRequestRegistry) + Task 7 (IPC enqueue) + Task 8 (watch/get/update). ✅
- §5 MCP 工具清单: all 11 tools registered in Task 8; `generate_image` untouched (reused). ✅
- §6 数据流: exercised by Task 11 Step 4 manual smoke. ✅
- §7 图片加载 via `attachments.readThumb`: `canvasBridge.toLoadable` (Task 10). ✅
- §7 needsClarification handling: `update_edit_request` status `needs_clarification` (Task 8) + `buildEditRequest` returns reason (Task 10). ✅
- §7 long-poll < codex timeout: `WATCH_LONG_POLL_MS = 25_000` (Task 8). ✅
- §8 测试: parser test (Task 3), registry test (Task 6), tools test (Task 8). ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code. Ports reference exact in-repo source files + explicit import edits. ✅

**Type consistency:** `CanvasEditRequest`/`EditRequestQueueStatus`/`EditRequestPollResult` from `src/types/canvas.ts` used consistently across Tasks 6–10. `editRequestRegistry` singleton shared by Task 7 (IPC) and Task 8 (tools). Tool names match across `canvasTools.ts` (Task 8), `AgentToolExecutor` switch (Task 9), and `canvasBridge.handle` (Task 10): `canvas_open`, `prepare_image_generation`, `create_image_holder`, `insert_image_into_holder`, `collect_annotations`, `prepare_annotation_edit`, `create_image_version`, `save_snapshot`. ✅

**Note:** Task 9 intentionally leaves the tree non-compiling until Task 10 creates `canvasBridge`; the two tasks share one commit. Execute them together.
