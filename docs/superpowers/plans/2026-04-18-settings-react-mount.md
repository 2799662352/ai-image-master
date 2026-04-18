# Settings React Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mount the existing React `SettingsPage` into the vanilla `#settingsModal` in `index.html`, replacing the static form HTML with a live React root.

**Architecture:** Follow the proven Director mount/unmount pattern from `react-app/main.tsx`. Replace the modal body/footer HTML with a `<div id="settings-react-root">`. `SiteManager.ts` calls `mountSettingsReact()` on open and `unmountSettingsReact()` on close. Cross-framework communication uses `CustomEvent`.

**Tech Stack:** React 19, Zustand, TypeScript, electron-vite

---

### Task 1: Replace modal body HTML with React root in `index.html`

**Files:**
- Modify: `src/renderer/index.html:2178-2268`

- [ ] **Step 1: Replace the modal content and footer**

In `src/renderer/index.html`, replace lines 2178-2268 (from `<!-- 模态框内容 - 可滚动 -->` through the closing `</div>` of the footer) with a single React mount point:

```html
            <!-- Settings content rendered by React -->
            <div id="settings-react-root" class="flex-1 overflow-y-auto"></div>
```

The resulting structure should be:
```
line 2165: <div id="settingsModal" ...>        (overlay)
line 2166:   <div ...>                          (modal frame)
line 2168:     <div ...>                        (header with title + close button)
line 2176:     </div>
line 2177:     
line 2178:     <!-- Settings content rendered by React -->
line 2179:     <div id="settings-react-root" class="flex-1 overflow-y-auto"></div>
line 2180:   </div>
line 2181: </div>
```

- [ ] **Step 2: Verify no broken HTML**

Run: `npx electron-vite build 2>&1 | head -20`

Expected: Build succeeds with no HTML parse errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/index.html
git commit -m "feat: replace settings modal body with React mount point"
```

---

### Task 2: Add mount/unmount functions in `react-app/main.tsx`

**Files:**
- Modify: `src/renderer/src/react-app/main.tsx`

- [ ] **Step 1: Add SettingsPage import and settingsRoot variable**

At the top of `src/renderer/src/react-app/main.tsx`, after the existing imports, add:

```typescript
import SettingsPage from '../pages-react/SettingsPage'
```

After the existing `let root: Root | null = null` line, add:

```typescript
let settingsRoot: Root | null = null
```

- [ ] **Step 2: Add mountSettingsReact function**

After the `unmountDirectorReact()` function (after line 66), add:

```typescript
export function mountSettingsReact(): void {
  const container = document.getElementById('settings-react-root')
  if (!container) {
    console.warn('[React] settings-react-root not found')
    return
  }
  if (!settingsRoot) {
    settingsRoot = createRoot(container)
  }
  settingsRoot.render(<SettingsPage />)
  console.log('[React] SettingsPage mounted')
}

export function unmountSettingsReact(): void {
  if (settingsRoot) {
    settingsRoot.unmount()
    settingsRoot = null
    console.log('[React] SettingsPage unmounted')
  }
}
```

- [ ] **Step 3: Verify file compiles**

Run: `npx tsc --noEmit src/renderer/src/react-app/main.tsx 2>&1 | head -20`

If tsc can't be run standalone, verify via full build:
Run: `npx electron-vite build 2>&1 | tail -10`

Expected: No type errors in `react-app/main.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/react-app/main.tsx
git commit -m "feat: add mountSettingsReact/unmountSettingsReact functions"
```

---

### Task 3: Adapt SettingsPage for modal embedding

**Files:**
- Modify: `src/renderer/src/pages-react/SettingsPage.tsx`

- [ ] **Step 1: Remove the `<h1>` title**

The modal header in `index.html` already shows "API设置". Remove lines 52-54 from `SettingsPage.tsx`:

```typescript
// REMOVE these lines:
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow flex items-center gap-2">
        <span>{'\u2699\uFE0F'}</span> API 设置
      </h1>
```

- [ ] **Step 2: Update handleSave to dispatch event and sync API status**

Replace the existing `handleSave` function (lines 39-46) with:

```typescript
  const handleSave = async () => {
    try {
      await saveAll(api)
      addToast({ message: '配置已保存', type: 'success' })
      const vanillaApi = (window as any).aiImageAPI
      vanillaApi?.updateApiStatus?.()
      window.dispatchEvent(new CustomEvent('settings-saved'))
    } catch {
      addToast({ message: '保存失败', type: 'error' })
    }
  }
```

- [ ] **Step 3: Adjust container styling for modal fit**

The outer `<div>` wrapper currently has `max-w-2xl mx-auto`. Since the modal already constrains width to `max-w-lg`, remove `max-w-2xl mx-auto` to let the content fill the modal. Change line 51 from:

```typescript
    <div className="max-w-2xl mx-auto p-6 space-y-8">
```

to:

```typescript
    <div className="p-6 space-y-6">
```

(Also tightened `space-y-8` to `space-y-6` to fit better in the constrained modal height.)

- [ ] **Step 4: Verify file compiles**

Run: `npx electron-vite build 2>&1 | tail -10`

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/pages-react/SettingsPage.tsx
git commit -m "feat: adapt SettingsPage for modal embedding"
```

---

### Task 4: Hook mount/unmount into SiteManager.ts

**Files:**
- Modify: `src/renderer/src/features/settings/SiteManager.ts`

- [ ] **Step 1: Add import for mount functions**

At the top of `SiteManager.ts`, after the existing imports/declarations (after line 7 `declare const i18n: any`), add:

```typescript
import { mountSettingsReact, unmountSettingsReact } from '../../react-app/main'
```

- [ ] **Step 2: Simplify `openSettingsModal()`**

Replace the current `openSettingsModal()` method (lines 337-364) with:

```typescript
  openSettingsModal(): void {
    const modal = document.getElementById('settingsModal')
    if (!modal) return

    modal.classList.remove('hidden')
    mountSettingsReact()
  }
```

This removes the vanilla DOM manipulation (`renderSiteCards`, `apiKeyInput` value setting, `updateModalI18n`) since React handles all of it.

- [ ] **Step 3: Update `closeSettingsModal()` to unmount React**

Replace the current `closeSettingsModal()` method (lines 369-372) with:

```typescript
  closeSettingsModal(): void {
    unmountSettingsReact()
    const modal = document.getElementById('settingsModal')
    if (modal) modal.classList.add('hidden')
  }
```

- [ ] **Step 4: Update `initSettingsModalEvents()` close handlers**

In `initSettingsModalEvents()` (around line 488), the local `closeSettingsModal` function (lines 500-502) duplicates logic. Update it to call `this.closeSettingsModal()` instead:

Replace lines 500-502:
```typescript
    const closeSettingsModal = () => {
      if (settingsModal) settingsModal.classList.add('hidden')
    }
```

with:
```typescript
    const closeSettingsModal = () => this.closeSettingsModal()
```

- [ ] **Step 5: Add `settings-saved` event listener**

At the end of `initSettingsModalEvents()`, before the closing `}`, add:

```typescript
    window.addEventListener('settings-saved', () => this.closeSettingsModal())
```

- [ ] **Step 6: Mark deprecated methods**

Add `// @deprecated: replaced by React SettingsPage` comment above these methods:
- `renderSiteCards()` 
- `saveApiKeyPublic()`
- The `saveApiConfig` and `testConnection` event bindings in `initSettingsModalEvents()`

Do NOT delete any of these methods.

- [ ] **Step 7: Verify file compiles**

Run: `npx electron-vite build 2>&1 | tail -10`

Expected: Build succeeds.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/features/settings/SiteManager.ts
git commit -m "feat: hook React mount/unmount into SiteManager open/close"
```

---

### Task 5: Build verification

**Files:** None (verification only)

- [ ] **Step 1: Clean build**

```bash
cd d:\tecx\text\temp-ai-image-master-source
rm -rf dist
npx electron-vite build
```

Expected: Build completes with no errors. `dist/renderer/` contains the built files.

- [ ] **Step 2: Check for missing imports**

Run: `npx electron-vite build 2>&1 | grep -i error`

Expected: No error lines.

- [ ] **Step 3: Run existing tests**

```bash
npx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: All existing tests pass. No regressions from the changes.

- [ ] **Step 4: Commit (if any fixes were needed)**

If build or test fixes were required, commit them:

```bash
git add -A
git commit -m "fix: address build/test issues from settings mount"
```

---

### Task 6: Runtime verification

**Files:** None (manual verification)

- [ ] **Step 1: Launch dev server**

```bash
npx electron-vite dev
```

Expected: Electron app launches, shows the original UI with intro animation.

- [ ] **Step 2: Open settings modal**

Click the gear icon / "设置" button in the top navigation area.

Expected: Settings modal opens. The React `SettingsPage` renders inside the modal body with:
- Site selection grid (React `SiteGrid` component)
- API Key input (React `ApiKeyInput` component)
- Vision API Key input
- Test connection + Save buttons at the bottom

- [ ] **Step 3: Verify functionality**

1. Select a different API site → site card highlights
2. Type an API key → input accepts text
3. Click "测试连接" → shows testing state, then result toast
4. Click "保存配置" → shows "配置已保存" toast, modal closes automatically
5. Click X button → modal closes cleanly

- [ ] **Step 4: Re-open modal**

Click "设置" again after closing.

Expected: Modal opens fresh, state loads from service (not stale from previous mount).

- [ ] **Step 5: Check console for errors**

Open DevTools (Ctrl+Shift+I), check console.

Expected: 
- `[React] SettingsPage mounted` on open
- `[React] SettingsPage unmounted` on close  
- No errors about missing DOM elements (`#apiKeyInput`, `#siteCardsContainer`, etc.)
- No React errors or warnings

- [ ] **Step 6: Verify other tabs still work**

Switch between Generate, Batch, Compare, History, Understand, Templates, Director tabs.

Expected: All tabs function normally. No interference from settings mount changes.
