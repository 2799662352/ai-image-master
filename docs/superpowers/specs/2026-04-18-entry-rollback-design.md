# Entry Rollback Design

**Date:** 2026-04-18
**Goal:** Switch Vite/Electron entry back from `index-react.html` to `index.html` to restore the original UI with full visual fidelity. All React code stays in the codebase but is not activated.

## Context

The entry was switched to `index-react.html` in a previous iteration. The React UI lacks visual parity with the original vanilla JS UI. Strategy shift: keep old UI as-is, upgrade incrementally later.

## Changes

### 1. Vite renderer input

**File:** `electron.vite.config.ts` line 66

```diff
- index: resolve(__dirname, 'src/renderer/index-react.html')
+ index: resolve(__dirname, 'src/renderer/index.html')
```

### 2. Electron loadFile

**File:** `src/main/index.ts` line 307

```diff
- mainWindow.loadFile(path.join(__dirname, '../renderer/index-react.html'))
+ mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
```

### 3. server.warmup (dev HMR)

**File:** `electron.vite.config.ts` lines 190-196

Restore to old `main.ts` entry:

```diff
  clientFiles: [
-   './src/main.tsx',
-   './src/services/ServiceBridge.ts',
-   './src/App.tsx',
-   './src/stores/index.ts',
-   './src/pages-react/index.ts'
+   './src/main.ts',
+   './src/services/ServiceBridge.ts',
+   './src/core/AppBootstrap.ts'
  ]
```

### 4. optimizeDeps.include

**File:** `electron.vite.config.ts` line 201

Add back `choices.js` (used by old `main.ts`); keep React deps since they're still used by `#director-react-root`:

```diff
- include: ['jszip', 'react', 'react-dom', 'zustand', 'react-select'],
+ include: ['choices.js', 'jszip', 'react', 'react-dom', 'zustand', 'react-select'],
```

### 5. manualChunks: restore vendor-choices

**File:** `electron.vite.config.ts` manualChunks function

Add back the `vendor-choices` chunk rule (was removed in entry-switch):

```typescript
if (id.includes('choices.js')) {
  return 'vendor-choices'
}
```

Insert after the `vendor-zustand` rule (line ~79).

## What stays unchanged

- `index-react.html` — preserved for future use
- `src/renderer/src/main.tsx` — React entry, not loaded
- All React pages, Zustand stores, hooks, tests — preserved
- `ServiceBridge.ts` — unchanged
- `package.json` `"main"` field — stays `"dist/main/index.js"`
- CJS output format and external config for main/preload — stays

## Rollback

If this rollback itself causes issues, revert the 5 changes above (restore `index-react.html` as input).

## Success criteria

1. `npx electron-vite build` completes without errors
2. `npx electron-vite dev` launches Electron with the original UI
3. Intro animation, navigation bar, all 6 tab panels, settings modal all render correctly
4. No console errors related to missing modules or DOM elements
5. Director tab React mount (`#director-react-root`) still works
