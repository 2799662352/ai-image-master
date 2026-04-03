# Seed / Web Search / Dead Code 集中修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Forward seed parameter to Seedance 2.0 API, add seed input UI, unrestrict web search toggle, clean up ~650 lines of dead code, and display seed in task details.

**Architecture:** Backend receives seed from frontend and writes it into the Seedance 2.0 metadata object. Frontend adds a Popover-based seed pill to the editor bottom bar, pipes it through state → props → request → API layer. Dead code blocks wrapped in `{false && ...}` are deleted. Seed echo captures actual seed from polling response and displays it in the task detail drawer.

**Tech Stack:** React 18, TypeScript, Ant Design (InputNumber, Popover, Switch, Descriptions), Prisma, Express

**Spec:** `docs/superpowers/specs/2026-04-03-seed-websearch-cleanup-design.md`

**Working directory:** All commands (`cd`, `git add`, `npx`) assume CWD is `25/soraui_4.0/` unless otherwise noted.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `sora-ui-backend/src/controllers/volcengineArkRelayController.ts` | Modify | Module 1: seed forwarding in metadata. Module 5: requestedSeed in task creation, actualSeed in polling |
| `sora-ui/src/types/index.ts` | Modify | Module 2: add `arkSeed` field to `SoraRequest` |
| `sora-ui/src/api/volcengine-ark.ts` | Modify | Module 2: seed source priority (request > config) |
| `sora-ui/src/components/JimengStyleEditor.tsx` | Modify | Module 2: seed Popover pill + props. Module 3: web search unrestriction. Seed reset on model change |
| `sora-ui/src/components/VideoGenerator.tsx` | Modify | Module 2: arkSeed state + props passing + request body. Module 4: delete ~650 lines dead code |
| `sora-ui/src/components/TaskList/BackendTaskList.tsx` | Modify | Module 5: seed display in task detail drawer |

---

### Task 1: Backend — Seed forwarding in Seedance 2.0 metadata

**Files:**
- Modify: `sora-ui-backend/src/controllers/volcengineArkRelayController.ts:490-499`

- [ ] **Step 1: Fix pre-existing paste error on line 147**

In `sora-ui-backend/src/controllers/volcengineArkRelayController.ts`, find line 147:

```typescript
          externalTaskId,https://www.volcengine.com/docs/82379/2291680?lang=zh#46d77653
```

Replace with:

```typescript
          externalTaskId,
```

- [ ] **Step 2: Add seed to Seedance 2.0 metadata object**

In the same file, find the `isSeedance2` block at line 490. After line 495 (`if (webSearch) metadata.tools = ...`), add:

```typescript
if (seed !== undefined && seed !== null && seed !== -1) {
  metadata.seed = Number(seed);
}
```

- [ ] **Step 3: Add seed to the metadata log**

On line 498, the existing log prints `generate_audio` and `tools`. Add `seed: metadata.seed` to the log object:

```typescript
console.log('[Volcengine Ark Relay] 🔧 2.0 metadata 参数:', {
  resolution, ratio, duration: Number(duration),
  generate_audio: metadata.generate_audio, tools: metadata.tools,
  seed: metadata.seed,
});
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd sora-ui-backend && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 5: Commit**

```bash
git add sora-ui-backend/src/controllers/volcengineArkRelayController.ts
git commit -m "feat(backend): forward seed param to Seedance 2.0 metadata, fix line 147 paste error"
```

---

### Task 2: Frontend — Add `arkSeed` to SoraRequest type

**Files:**
- Modify: `sora-ui/src/types/index.ts:89`

- [ ] **Step 1: Add arkSeed field to SoraRequest**

In `sora-ui/src/types/index.ts`, find line 89 (`arkWebSearch?: boolean;`). After it, add:

```typescript
arkSeed?: number;
```

- [ ] **Step 2: Commit**

```bash
git add sora-ui/src/types/index.ts
git commit -m "feat(types): add arkSeed field to SoraRequest"
```

---

### Task 3: Frontend — Seed source priority in API layer

**Files:**
- Modify: `sora-ui/src/api/volcengine-ark.ts:78`

- [ ] **Step 1: Change seed source to prioritize request.arkSeed**

In `sora-ui/src/api/volcengine-ark.ts`, find line 78:

```typescript
seed: arkConfig.seed,
```

Replace with:

```typescript
seed: request.arkSeed !== undefined ? request.arkSeed : arkConfig.seed,
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Commit**

```bash
git add sora-ui/src/api/volcengine-ark.ts
git commit -m "feat(api): prioritize request.arkSeed over config seed"
```

---

### Task 4: Frontend — Seed state, props, and request body in VideoGenerator

**Files:**
- Modify: `sora-ui/src/components/VideoGenerator.tsx`

- [ ] **Step 1: Add arkSeed state**

In `VideoGenerator.tsx`, find the existing `arkWebSearch` state declaration (search for `useState.*arkWebSearch`). After it, add:

```typescript
const [arkSeed, setArkSeed] = useState<number | undefined>(undefined);
```

- [ ] **Step 2: Add arkSeed to request body**

Find line 905 (`arkWebSearch: isSeedance2 ? arkWebSearch : undefined,`). After it, add:

```typescript
arkSeed: isSeedance2 && arkSeed !== undefined ? arkSeed : undefined,
```

- [ ] **Step 3: Add arkSeed to handleGenerate dependency array**

Find the `handleGenerate` `useCallback` dependency array (line ~1482). It ends with `arkRatio, arkDuration, arkResolution]);`. Add `arkSeed` to the array:

```typescript
arkRatio, arkDuration, arkResolution, arkSeed]);
```

Without this, the memoized `handleGenerate` closure would capture a stale `arkSeed` value.

- [ ] **Step 4: Pass arkSeed props to JimengStyleEditor**

Find the `<JimengStyleEditor` JSX block (line ~2060). After line 2080 (`arkWebSearch={arkWebSearch}` / `setArkWebSearch={setArkWebSearch}`), add:

```typescript
arkSeed={arkSeed}
setArkSeed={setArkSeed}
```

- [ ] **Step 5: Do NOT commit yet**

Task 4 changes `VideoGenerator.tsx` which passes `arkSeed`/`setArkSeed` props to `JimengStyleEditor`, but the editor's type interface hasn't been updated yet (that's Task 5). **Commit both Task 4 and Task 5 together** after Task 5 is complete to keep every commit compilable.

---

### Task 5: Frontend — Seed Popover pill + web search unrestriction in JimengStyleEditor

**Files:**
- Modify: `sora-ui/src/components/JimengStyleEditor.tsx`

- [ ] **Step 1: Add arkSeed props to interface**

In `JimengStyleEditor.tsx`, find the `interface JimengStyleEditorProps` (line 42). After line 62 (`setArkWebSearch: (v: boolean) => void;`), add:

```typescript
arkSeed: number | undefined;
setArkSeed: (v: number | undefined) => void;
```

- [ ] **Step 2: Destructure arkSeed from props**

Find the component function's props destructuring (search for `const { prompt, setPrompt`). Add `arkSeed, setArkSeed,` to the destructured props.

- [ ] **Step 3: Add InputNumber to imports**

Find the `antd` import line (search for `import {` from `'antd'`). Ensure `InputNumber` is in the import list. If not present, add it.

- [ ] **Step 4: Add seed reset to handleModelChange**

Find the `handleModelChange` callback (line ~178). After line 189 (`resetMedia();`), add:

```typescript
setArkSeed(undefined);
```

Also add `setArkSeed` to the `useCallback` dependency array on line 191.

- [ ] **Step 5: Replace the isSeedance2 JSX block with combined Module 2+3 result**

Find lines 1152-1166 (the `{/* Audio & Web Search */}` comment and `{isSeedance2 && (...)}` block). Replace the entire block:

**Before** (lines 1152-1166):
```tsx
          {/* Audio & Web Search */}
          {isSeedance2 && (
            <>
              <div className="jm-toggle-pill" title="有声视频">
                <span style={{ fontSize: 14 }}>🔊</span>
                <Switch checked={arkGenerateAudio} onChange={setArkGenerateAudio} size="small" />
              </div>
              {volcengineArkMode === 'text2video' && (
                <div className="jm-toggle-pill" title="联网搜索">
                  <span style={{ fontSize: 14 }}>🌐</span>
                  <Switch checked={arkWebSearch} onChange={setArkWebSearch} size="small" />
                </div>
              )}
            </>
          )}
```

**After:**
```tsx
          {/* Seed / Audio / Web Search */}
          {isSeedance2 && (
            <>
              <Popover
                content={
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <InputNumber
                      min={0} max={4294967295} step={1} precision={0}
                      placeholder="留空=随机"
                      value={arkSeed}
                      onChange={(v) => setArkSeed(v ?? undefined)}
                      style={{ width: 160 }}
                    />
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>固定值→类似结果</span>
                  </div>
                }
                trigger="click" placement="top" arrow={false}
              >
                <div className="jm-pill">
                  <span style={{ fontSize: 14 }}>🎲</span>
                  <span>{arkSeed !== undefined ? arkSeed : '随机'}</span>
                </div>
              </Popover>
              <div className="jm-toggle-pill" title="有声视频">
                <span style={{ fontSize: 14 }}>🔊</span>
                <Switch checked={arkGenerateAudio} onChange={setArkGenerateAudio} size="small" />
              </div>
              <div className="jm-toggle-pill" title="联网搜索">
                <span style={{ fontSize: 14 }}>🌐</span>
                <Switch checked={arkWebSearch} onChange={setArkWebSearch} size="small" />
              </div>
            </>
          )}
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 7: Check lints**

Use `ReadLints` on `sora-ui/src/components/JimengStyleEditor.tsx`
Expected: No new lint errors

- [ ] **Step 8: Commit Task 4 + Task 5 together**

```bash
git add sora-ui/src/components/VideoGenerator.tsx sora-ui/src/components/JimengStyleEditor.tsx
git commit -m "feat: add seed pill UI, unrestrict web search, wire arkSeed state"
```

---

### Task 6: Frontend — Dead code cleanup in VideoGenerator

**Files:**
- Modify: `sora-ui/src/components/VideoGenerator.tsx:2311-2963`

- [ ] **Step 1: Delete all 5 dead code blocks**

In `VideoGenerator.tsx`, delete lines 2311 through 2963 (inclusive). This removes:

1. Lines 2311-2516: Old mode selector card (`{false && isVolcengineArkApi && (<Card ...`)
2. Lines 2518-2809: Old image upload area (`{false && isVolcengineArkApi && volcengineArkMode !== 'text2video' && ...`)
3. Lines 2811-2865: Old reference video upload card (`{false && isVolcengineArkApi && ...`)
4. Lines 2867-2907: Old reference audio upload card (`{false && isVolcengineArkApi && ...`)
5. Lines 2911-2963: Old multimodal reference image upload (`{false && isVolcengineArkApi && ...`)

Also delete line 2909 (`{/* ⏩ 延长视频模式提示 */}`) and the blank line 2310 before the first block.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit`
Expected: No new errors. If unused import warnings appear (e.g., `CloudUploadOutlined`, `Alert`, `Card`, `Select`), proceed to Step 3.

- [ ] **Step 3: Remove newly-unused imports (if any)**

Check the top of `VideoGenerator.tsx` for any imports that are now unused after deleting the dead code blocks. Common candidates: `CloudUploadOutlined`, `Alert` (if not used elsewhere). Remove only imports that are confirmed unused by the TypeScript compiler or linter.

- [ ] **Step 4: Check lints**

Use `ReadLints` on `sora-ui/src/components/VideoGenerator.tsx`
Expected: No new lint errors

- [ ] **Step 5: Verify Vite build**

Run: `cd sora-ui && npx vite build`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add sora-ui/src/components/VideoGenerator.tsx
git commit -m "cleanup: remove ~650 lines of dead code from VideoGenerator"
```

---

### Task 7: Backend — Seed echo (requestedSeed + actualSeed)

**Files:**
- Modify: `sora-ui-backend/src/controllers/volcengineArkRelayController.ts`

- [ ] **Step 1: Store requestedSeed in task creation metadata**

Find the `prisma.videoTask.create()` call (line ~528). Inside the `metadata` object (line ~542-566), after line 549 (`webSearch: isSeedance2 ? (webSearch || false) : undefined,`), add:

```typescript
requestedSeed: seed !== undefined && seed !== null && seed !== -1 ? Number(seed) : undefined,
```

- [ ] **Step 2: Capture actualSeed in polling success branch**

Find the polling success branch (line ~153, `if (isSuccess)`). After line 169 (`if (response.data.metadata?.upstream_task_id) usageMetadata.upstreamTaskId = ...`), add:

```typescript
const actualSeed = response.data.seed ?? response.data.metadata?.seed;
if (actualSeed !== undefined) {
  usageMetadata.actualSeed = Number(actualSeed);
}
console.log('[Volcengine Ark Polling] 🔍 seed echo:', { actualSeed, rawSeed: response.data.seed, metaSeed: response.data.metadata?.seed });
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd sora-ui-backend && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
git add sora-ui-backend/src/controllers/volcengineArkRelayController.ts
git commit -m "feat(backend): save requestedSeed on create, capture actualSeed on poll"
```

---

### Task 8: Frontend — Seed display in task detail drawer

**Files:**
- Modify: `sora-ui/src/components/TaskList/BackendTaskList.tsx:1573-1580`

- [ ] **Step 1: Add seed Descriptions.Item to task detail**

In `BackendTaskList.tsx`, find the closing of the `upstreamTaskId` block (line ~1579-1580, `</Descriptions.Item>` then `)}` closing the conditional). After line 1580 (before `<Descriptions.Item label="状态">` on line 1581), add:

```tsx
{(() => {
  const meta = selectedTask.metadata as any;
  const seedValue = meta?.actualSeed ?? meta?.requestedSeed;
  return seedValue !== undefined ? (
    <Descriptions.Item label="Seed">
      <Text copyable style={{ fontFamily: 'monospace' }}>🎲 {seedValue}</Text>
      {meta?.actualSeed !== undefined && meta?.requestedSeed === undefined && (
        <Tag color="blue" style={{ marginLeft: 8 }}>随机</Tag>
      )}
    </Descriptions.Item>
  ) : null;
})()}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit`
Expected: No new errors

- [ ] **Step 3: Check lints**

Use `ReadLints` on `sora-ui/src/components/TaskList/BackendTaskList.tsx`
Expected: No new lint errors

- [ ] **Step 4: Commit**

```bash
git add sora-ui/src/components/TaskList/BackendTaskList.tsx
git commit -m "feat(TaskList): display seed value in task detail drawer"
```

---

### Task 9: Integration verification

- [ ] **Step 1: Full TypeScript compile check**

Run: `cd sora-ui && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Full Vite build**

Run: `cd sora-ui && npx vite build`
Expected: Build succeeds

- [ ] **Step 3: Backend TypeScript compile check**

Run: `cd sora-ui-backend && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Lint check all modified files**

Use `ReadLints` on:
- `sora-ui/src/types/index.ts`
- `sora-ui/src/api/volcengine-ark.ts`
- `sora-ui/src/components/JimengStyleEditor.tsx`
- `sora-ui/src/components/VideoGenerator.tsx`
- `sora-ui/src/components/TaskList/BackendTaskList.tsx`
- `sora-ui-backend/src/controllers/volcengineArkRelayController.ts`

Expected: No new lint errors

- [ ] **Step 5: Final check complete**

All modules verified. No additional commit needed unless lint/compile issues were found above.
