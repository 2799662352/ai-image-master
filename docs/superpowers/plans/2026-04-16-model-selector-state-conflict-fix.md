# Model Selector State Conflict Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two bugs causing state conflict on first model selection: (1) `api.model` returns display name instead of model key, and (2) event double-firing in Choices.js handlers.

**Architecture:** Add `getModelKey()` to `ApiService`, fix `ServiceBridge.model` getter to return key, add re-entrancy guard and deduplicate events in `ModelSelectorManager`.

**Tech Stack:** TypeScript, Choices.js, Electron (renderer process)

---

## Root Cause Analysis

### Bug 1: `api.model` returns display name, not model key

```
ServiceBridge.ts:581    get model() { return apiService.getCurrentModel()?.name }
                                                                         ^^^^^ returns "🍌 Nano Banana 2"

ModelSelectorManager.ts:105   this.currentModelKey = api?.model || ''
                                                     ^^^^^^^^^^  gets "🍌 Nano Banana 2" instead of "gemini-3.1-flash-image-preview"

ModelSelectorManager.ts:214   if (modelKey === currentModelKey) option.selected = true
                                  NEVER matches → no option pre-selected → initial state broken
```

### Bug 2: Event double-firing cascade

`bindSelectorEvents` binds both `choice` and `change` events to the same select element. Both call `handleModelSwitch`. Per Choices.js docs:
- `choice` event: user interaction only
- `change` event: user interaction only, but `setChoiceByValue` may trigger it in some versions

`handleModelSwitch` calls `setChoiceByValue` on both desktop and mobile selectors → potential cascade. No guard exists (`if (modelKey === this.currentModelKey) return`).

### Reference: Choices.js Best Practices (from Context7)

- `choice` event fires on user selection with full choice payload (`event.detail.choice.value`)
- `change` event fires on user add/remove with simple value (`event.detail.value`)
- `setChoiceByValue(value)` programmatically selects — docs say `change` is "by a user" but `addItem` fires "either programmatically or by user interaction"
- Recommended pattern for syncing two instances: listen on `change` of instance A, call API on instance B (not both listening + both syncing)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/renderer/src/services/api/ApiService.ts` | Add `getModelKey()` method |
| Modify | `src/renderer/src/services/ServiceBridge.ts` | Fix `model` getter, add `modelKey` |
| Modify | `src/renderer/src/features/model-selector/ModelSelectorManager.ts` | Fix init + events |
| Modify | `tests/features/ModelSelectorManager.test.ts` | Add regression tests |

---

### Task 1: Add `getModelKey()` to ApiService

**Files:**
- Modify: `src/renderer/src/services/api/ApiService.ts:1323-1330`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/services/ApiService.test.ts (or add to existing)
describe('ApiService.getModelKey', () => {
  it('returns the current model key, not the display name', () => {
    const api = new ApiService()
    api.setModel('gemini-3.1-flash-image-preview')
    expect(api.getModelKey()).toBe('gemini-3.1-flash-image-preview')
    expect(api.getModelKey()).not.toBe('🍌 Nano Banana 2')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/ApiService.test.ts --reporter=verbose`
Expected: FAIL with "getModelKey is not a function"

- [ ] **Step 3: Add `getModelKey()` method to ApiService**

In `src/renderer/src/services/api/ApiService.ts`, after the `setModel` method (line ~1330):

```typescript
  /**
   * 获取当前模型 key
   */
  getModelKey(): string {
    return this.currentModel
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/ApiService.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts tests/services/ApiService.test.ts
git commit -m "fix: add getModelKey() to ApiService to expose model key"
```

---

### Task 2: Fix ServiceBridge `model` getter

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts:577-581`

- [ ] **Step 1: Locate and fix the getter**

In `src/renderer/src/services/ServiceBridge.ts`, change line 581:

Before:
```typescript
      get model() { return apiService.getCurrentModel()?.name },
```

After:
```typescript
      get model() { return apiService.getModelKey() },
```

This is a **breaking change audit** — we need to check all consumers of `api.model`:

- [ ] **Step 2: Search for all `api.model` / `api?.model` usages**

Run: `rg "api[?\.]model\b" src/renderer/src/ --type ts -n`

For each usage, verify it expects a key (like `"gemini-3.1-flash-image-preview"`) not a display name (like `"🍌 Nano Banana 2"`). If any consumer uses `api.model` for display purposes, they should switch to `api.getCurrentModel()?.name`.

- [ ] **Step 3: Fix any display-name consumers**

If any consumer uses `api.model` to display the name to the user (e.g., in a toast or label), change it to `api.getCurrentModel()?.name` instead.

- [ ] **Step 4: Verify existing tests pass**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass (or only unrelated failures)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/services/ServiceBridge.ts
git commit -m "fix: ServiceBridge model getter returns key instead of display name"
```

---

### Task 3: Fix ModelSelectorManager event handling

**Files:**
- Modify: `src/renderer/src/features/model-selector/ModelSelectorManager.ts:275-300, 305-335`
- Test: `tests/features/ModelSelectorManager.test.ts`

- [ ] **Step 1: Add re-entrancy guard and dedup flag**

Add a private field to `ModelSelectorManager`:

```typescript
  private switching = false
```

- [ ] **Step 2: Add guard to `handleModelSwitch`**

In `handleModelSwitch`, add early return if already switching or same model:

```typescript
  private handleModelSwitch(modelKey: string): void {
    if (this.switching || modelKey === this.currentModelKey) return
    this.switching = true

    console.log('🔄 切换模型到:', modelKey)

    try {
      const api = (window as any).aiImageAPI
      const saved = api?.setModel?.(modelKey) ?? api?.saveModel?.(modelKey)
      if (saved) {
        this.currentModelKey = modelKey

        if (this.desktopChoice) {
          this.desktopChoice.setChoiceByValue(modelKey)
        }
        if (this.mobileChoice) {
          this.mobileChoice.setChoiceByValue(modelKey)
        }

        const currentModel = api.getCurrentModel?.() as ModelConfig
        this.config.onModelChange?.(modelKey, currentModel)

        this.updateUIForModel()

        if (this.config.showToast) {
          this.config.showToast(`已切换到模型: ${currentModel?.name || modelKey}`, 'success')
        }

        console.log('✅ 模型切换完成')
      } else {
        this.config.showToast?.('模型切换失败', 'error')
      }
    } finally {
      this.switching = false
    }
  }
```

- [ ] **Step 3: Simplify event binding — use only `choice` event**

Replace `bindSelectorEvents` to only listen to the `choice` event (per Choices.js docs, this is the user-initiated selection event with the full payload):

```typescript
  private bindSelectorEvents(selectElement: HTMLSelectElement, prefix: string): void {
    const handleChoice = (event: CustomEvent) => {
      const value = event.detail?.choice?.value
      if (value) {
        console.log(`${prefix} 模型已切换:`, value)
        this.handleModelSwitch(value)
      }
    }

    selectElement.addEventListener('choice', handleChoice as EventListener)

    console.log(`✅ ${prefix} 事件监听器已绑定`)
  }
```

Removed: the redundant `change` event handler that caused double-firing.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/features/ModelSelectorManager.test.ts --reporter=verbose`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/model-selector/ModelSelectorManager.ts
git commit -m "fix: prevent model selector event cascade with re-entrancy guard"
```

---

### Task 4: Verify init path uses correct model key

**Files:**
- Modify: `src/renderer/src/features/model-selector/ModelSelectorManager.ts:78-120`

- [ ] **Step 1: Verify `init()` reads the model key correctly**

After Task 2, `api?.model` now returns the key. Verify:

```typescript
  init(retryCount = 0): void {
    // ... existing code ...
    const api = (window as any).aiImageAPI
    const models = api?.getAllModels?.() || {}
    this.currentModelKey = api?.model || ''  // ← Now correctly returns key after Task 2 fix
    
    console.log('📊 当前模型 key:', this.currentModelKey, '所有模型数:', Object.keys(models).length)
    // ...
  }
```

If `api.model` is still used elsewhere for display, add a defensive check:

```typescript
    // Defensive: if model returns a name instead of key, try to reverse-lookup
    if (this.currentModelKey && !models[this.currentModelKey]) {
      const foundKey = Object.keys(models).find(k => models[k].name === this.currentModelKey)
      if (foundKey) {
        console.warn('⚠️ api.model returned name instead of key, auto-correcting:', this.currentModelKey, '→', foundKey)
        this.currentModelKey = foundKey
      }
    }
```

- [ ] **Step 2: Run full test suite**

Run: `npx vitest run --reporter=verbose`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/features/model-selector/ModelSelectorManager.ts
git commit -m "fix: add defensive model key lookup in init for backward compatibility"
```

---

### Task 5: Manual integration verification

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Open the app and check console**

Verify these log messages:
1. `📊 当前模型 key: gemini-3.1-flash-image-preview` (should be a key, NOT "🍌 Nano Banana 2")
2. `✅ 模型选择器初始化完成`
3. The selector displays the correct current model

- [ ] **Step 3: First model selection test**

1. Click the model dropdown
2. Select a different model (e.g., switch from Nano Banana 2 to another)
3. Verify console shows EXACTLY ONE `🔄 切换模型到:` log (not 2-4)
4. Verify the model name updates in both desktop and mobile selectors
5. Verify ratio/resolution buttons update correctly

- [ ] **Step 4: Rapid switching test**

1. Quickly click between 3 different models
2. Verify no console errors
3. Verify final state matches the last selected model

- [ ] **Step 5: Commit all changes**

```bash
git add -A
git commit -m "fix: resolve model selector state conflict on first selection

- ApiService.getModelKey() exposes model key (not display name)
- ServiceBridge.model getter returns key instead of name
- ModelSelectorManager: re-entrancy guard prevents event cascade
- ModelSelectorManager: use only 'choice' event (remove redundant 'change')
- Defensive reverse-lookup for backward compatibility"
```

---

## Summary of Changes

| File | Change | Why |
|------|--------|-----|
| `ApiService.ts` | Add `getModelKey()` | Expose model key (was only accessible internally) |
| `ServiceBridge.ts` | `get model()` → returns key | Was returning `.name` ("🍌 Nano Banana 2") instead of key |
| `ModelSelectorManager.ts` | `switching` guard in `handleModelSwitch` | Prevent re-entrancy from event cascade |
| `ModelSelectorManager.ts` | Remove `change` event handler | Redundant — `choice` event suffices per Choices.js docs |
| `ModelSelectorManager.ts` | Defensive key lookup in `init()` | Backward compatibility if any code path still returns name |
