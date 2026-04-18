# Entry Rollback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch Vite/Electron entry back from `index-react.html` to `index.html` to restore the original UI.

**Architecture:** Pure config rollback — 5 edits across 2 files, no logic changes. Old `main.ts` entry loads `ServiceBridge` + `AppBootstrap` which renders the full vanilla JS UI.

**Tech Stack:** electron-vite, Vite rollupOptions, Electron BrowserWindow.loadFile

---

### Task 1: Switch Vite renderer input to index.html

**Files:**
- Modify: `electron.vite.config.ts:66`

- [ ] **Step 1: Change the renderer input entry**

In `electron.vite.config.ts`, line 66, change:

```typescript
index: resolve(__dirname, 'src/renderer/index-react.html')
```

to:

```typescript
index: resolve(__dirname, 'src/renderer/index.html')
```

### Task 2: Switch Electron loadFile to index.html

**Files:**
- Modify: `src/main/index.ts:307`

- [ ] **Step 1: Change the loadFile path**

In `src/main/index.ts`, line 307, change:

```typescript
mainWindow.loadFile(path.join(__dirname, '../renderer/index-react.html'))
```

to:

```typescript
mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
```

### Task 3: Restore server.warmup to old entry files

**Files:**
- Modify: `electron.vite.config.ts:190-196`

- [ ] **Step 1: Update warmup clientFiles**

In `electron.vite.config.ts`, replace the `clientFiles` array (lines 190-196):

```typescript
clientFiles: [
  './src/main.tsx',
  './src/services/ServiceBridge.ts',
  './src/App.tsx',
  './src/stores/index.ts',
  './src/pages-react/index.ts'
]
```

with:

```typescript
clientFiles: [
  './src/main.ts',
  './src/services/ServiceBridge.ts',
  './src/core/AppBootstrap.ts'
]
```

### Task 4: Restore optimizeDeps and manualChunks for choices.js

**Files:**
- Modify: `electron.vite.config.ts:79` (manualChunks) and `electron.vite.config.ts:201` (optimizeDeps)

- [ ] **Step 1: Add vendor-choices chunk rule**

In `electron.vite.config.ts`, inside the `manualChunks` function, after the `vendor-zustand` block (line ~79), add:

```typescript
if (id.includes('choices.js')) {
  return 'vendor-choices'
}
```

The surrounding context should look like:

```typescript
if (id.includes('zustand')) {
  return 'vendor-zustand'
}
if (id.includes('choices.js')) {
  return 'vendor-choices'
}
if (id.includes('jszip')) {
  return 'vendor-jszip'
}
```

- [ ] **Step 2: Add choices.js to optimizeDeps.include**

In `electron.vite.config.ts`, line 201, change:

```typescript
include: ['jszip', 'react', 'react-dom', 'zustand', 'react-select'],
```

to:

```typescript
include: ['choices.js', 'jszip', 'react', 'react-dom', 'zustand', 'react-select'],
```

### Task 5: Build verification

- [ ] **Step 1: Run build**

Run: `npx electron-vite build`

Expected: Build completes with exit code 0, no errors. Output includes `dist/renderer/index.html`.

- [ ] **Step 2: Verify dist output contains index.html**

Run: `ls dist/renderer/index.html`

Expected: File exists.

- [ ] **Step 3: Verify vendor-choices chunk exists**

Run: `ls dist/renderer/assets/vendor-choices-*`

Expected: At least one file matches.

### Task 6: Runtime verification

- [ ] **Step 1: Start dev server**

Run: `npx electron-vite dev`

Expected: Electron window opens. The intro animation (or fallback loader) plays, then the full original UI appears with navigation bar, 6 tab buttons, generate panel visible by default.

- [ ] **Step 2: Verify no critical console errors**

Open DevTools (Ctrl+Shift+I), check Console tab.

Expected: No errors about missing DOM elements (`modelDropdown`, `promptInput`, etc.). ServiceBridge initialization logs show success.

- [ ] **Step 3: Verify tab switching works**

Click each tab button: Generate, Batch, Compare, History, Understand, Director.

Expected: Each panel shows/hides correctly.

- [ ] **Step 4: Verify settings modal**

Click the settings button (gear icon in nav bar).

Expected: Settings modal opens with site cards, API key input, test connection button.

### Task 7: Commit

- [ ] **Step 1: Commit all changes**

```bash
git add electron.vite.config.ts src/main/index.ts
git commit -m "chore: rollback entry to index.html for visual parity"
```
