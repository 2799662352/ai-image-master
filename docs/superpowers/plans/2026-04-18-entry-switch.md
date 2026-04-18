# React 入口切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the Vite build entry from the old `index.html` to `index-react.html` so the React app becomes the running default in Electron.

**Architecture:** Two config files are modified (`electron.vite.config.ts`, `src/main/index.ts`). Within the Vite config, four sections change: build input, manualChunks (dead-code-only cleanup), server.warmup, and optimizeDeps. All old files are preserved for rollback safety.

**Tech Stack:** electron-vite, Vite 8, Rollup, TypeScript 6, React 19, Electron 41

**Spec:** `docs/superpowers/specs/2026-04-18-entry-switch-design.md`

---

### Task 1: Switch Vite Build Input to React Entry

**Files:**
- Modify: `electron.vite.config.ts:49`

- [ ] **Step 1: Change the renderer input path**

Open `electron.vite.config.ts` and replace line 49:

```typescript
// Before (line 49):
          index: resolve(__dirname, 'src/renderer/index.html')
// After:
          index: resolve(__dirname, 'src/renderer/index-react.html')
```

- [ ] **Step 2: Verify the target file exists**

Run:
```bash
ls src/renderer/index-react.html
```
Expected: file exists (30 lines, contains `<div id="root">` and `<script type="module" src="./src/main.tsx">`)

- [ ] **Step 3: Commit**

```bash
git add electron.vite.config.ts
git commit -m "feat: switch Vite renderer input to index-react.html"
```

---

### Task 2: Switch Electron Main Process loadFile Path

**Files:**
- Modify: `src/main/index.ts:307`

- [ ] **Step 1: Change the loadFile path**

Open `src/main/index.ts` and replace line 307:

```typescript
// Before (line 307):
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
// After:
    mainWindow.loadFile(path.join(__dirname, '../renderer/index-react.html'))
```

Note: Line 304-305 handles dev mode via `ELECTRON_RENDERER_URL` — no change needed there; electron-vite dev server automatically serves whichever HTML is configured in the build input.

- [ ] **Step 2: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: switch Electron loadFile to index-react.html"
```

---

### Task 3: Remove Dead manualChunks Rules

**Files:**
- Modify: `electron.vite.config.ts:63-65,122-124`

- [ ] **Step 1: Delete the vendor-choices rule**

Remove these 3 lines (currently lines 63-65):

```typescript
              if (id.includes('choices.js')) {
                return 'vendor-choices'
              }
```

- [ ] **Step 2: Delete the feature-accessibility rule**

Remove these 3 lines (currently lines 122-124, will shift after step 1 deletion):

```typescript
            if (id.includes('src/renderer/src/features/accessibility')) {
              return 'feature-accessibility'
            }
```

- [ ] **Step 3: Commit**

```bash
git add electron.vite.config.ts
git commit -m "chore: remove dead manualChunks rules (vendor-choices, feature-accessibility)"
```

---

### Task 4: Update server.warmup to React Entry Files

**Files:**
- Modify: `electron.vite.config.ts:180-188`

- [ ] **Step 1: Replace the warmup clientFiles array**

Replace the full `clientFiles` array (lines 180-188):

```typescript
// Before:
        clientFiles: [
          './src/main.ts',
          './src/services/ServiceBridge.ts',
          './src/pages/GeneratePage.ts',
          './src/pages/BasePage.ts',
          './src/features/history/index.ts',
          './src/features/model-selector/index.ts',
          './src/features/toast/index.ts'
        ]
// After:
        clientFiles: [
          './src/main.tsx',
          './src/services/ServiceBridge.ts',
          './src/App.tsx',
          './src/stores/index.ts',
          './src/pages-react/index.ts'
        ]
```

- [ ] **Step 2: Commit**

```bash
git add electron.vite.config.ts
git commit -m "chore: update server.warmup to React entry modules"
```

---

### Task 5: Update optimizeDeps

**Files:**
- Modify: `electron.vite.config.ts:193`

- [ ] **Step 1: Replace the include list**

Replace line 193 (note: line number may have shifted due to Task 3 deletions — find the `include:` line inside `optimizeDeps`):

```typescript
// Before:
      include: ['choices.js', 'jszip', 'react', 'react-dom', 'zustand'],
// After:
      include: ['jszip', 'react', 'react-dom', 'zustand', 'react-select'],
```

- [ ] **Step 2: Commit**

```bash
git add electron.vite.config.ts
git commit -m "chore: update optimizeDeps - remove choices.js, add react-select"
```

---

### Task 6: Build Verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run the test suite**

Run:
```bash
npx vitest run
```
Expected: 79 tests pass, 0 failures.

- [ ] **Step 2: Run electron-vite build**

Run:
```bash
npx electron-vite build
```
Expected: Build completes with no errors. Output shows chunks being generated in `dist/renderer/assets/`.

- [ ] **Step 3: Verify dead chunks are gone**

Run (PowerShell):
```powershell
Get-ChildItem dist/renderer/assets/*.js | Select-Object Name
```

Verify:
- No file named `vendor-choices-*.js`
- No file named `feature-accessibility-*.js`
- Files like `vendor-react-*.js`, `vendor-zustand-*.js`, `core-services-*.js`, `page-generate-*.js` etc. **should** still exist (ServiceBridge keeps them alive)

- [ ] **Step 4: Verify the HTML entry in build output**

Run (PowerShell):
```powershell
Get-ChildItem dist/renderer/*.html | Select-Object Name
```

Expected: `index.html` (electron-vite renames the input to `index.html` in the output regardless of source filename).

- [ ] **Step 5: Commit verification notes (optional)**

If all passes, no additional commit needed. The implementation is complete.

---

### Task 7: Runtime Verification Checklist (Manual)

**Files:**
- None (manual testing)

- [ ] **Step 1: Start dev server**

Run:
```bash
npx electron-vite dev
```

Verify: Electron window opens, shows the React app with the loading spinner, then renders the main UI.

- [ ] **Step 2: Walk through all 8 tabs**

Click through each tab in order and verify it renders:
1. GeneratePage — prompt input, ratio selector, model selector visible
2. BatchPage — add task button, bulk import visible
3. ComparePage — two model dropdowns visible
4. HistoryPage — grid or empty state visible
5. UnderstandPage — image upload area visible
6. PromptTemplatesPage — category filter, search bar visible
7. SettingsPage — site selector, API key fields visible
8. DirectorPage — stub content visible

- [ ] **Step 3: Verify core functionality**

Test at least one key flow:
- SettingsPage: select a site, enter key, click test connection
- GeneratePage: enter a prompt, select model, click generate (verify API call fires)

- [ ] **Step 4: Check console for errors**

Open DevTools (Ctrl+Shift+I), check Console tab:
- No React runtime errors
- No "module not found" errors
- No "Failed to load" errors
- Toast notifications work (trigger one via settings test or generate)

- [ ] **Step 5: Verify HMR**

Edit a React component (e.g., add a space in `App.tsx`), save, verify the page updates without full reload.

---

## Rollback Procedure

If any verification step fails, revert all changes with:

```bash
git checkout HEAD~5 -- electron.vite.config.ts src/main/index.ts
git commit -m "revert: roll back entry switch"
```

This restores both files to their pre-switch state. Adjust `HEAD~5` based on how many task commits were made.
