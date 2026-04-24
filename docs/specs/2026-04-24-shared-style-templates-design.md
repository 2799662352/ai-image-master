# Shared Style Templates for Generate & Batch Pages

**Date:** 2026-04-24
**Status:** Approved
**Scope:** Extract Director's style template system into a shared module; add style template selection to Generate and Batch pages via React islands.

---

## 1. Problem

The style template system (prefix/suffix prompt wrapping, template selection modal, CRUD for custom templates) is locked inside the Director page's React ecosystem. Generate and Batch pages — which are vanilla JS — have no way to use it. Users who want consistent style control across all generation modes must manually copy-paste prompt prefixes.

## 2. Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Integration approach | React island (not vanilla JS rewrite) | Reuses existing 358-line TemplateSelector; zero duplicate maintenance |
| State isolation | Separate Zustand store per page context | Generate selecting "anime" must not change Director's selection |
| Template data layer | Keep `templates.ts` as-is | Already framework-agnostic; exports pure functions |
| Prompt injection point | API call time, not textarea mutation | User sees their own text; style wrapping is transparent |

## 3. Architecture

### 3.1 Data Layer (no changes)

`src/renderer/src/react-app/constants/templates.ts` already exports:
- `BUILTIN_TEMPLATES: TemplateData[]`
- `TEMPLATE_MAP: Record<string, TemplateData>`
- `getAllTemplates(): TemplateData[]`
- `getStyleInstructions(key): string` → returns `prefix + [SUBJECT] + suffix`
- CRUD: `addCustomTemplate()`, `deleteCustomTemplate()`, `updateCustomTemplate()`, `persistTemplateOverride()`, `resetTemplateOverride()`

All consumers share the same template data and localStorage persistence.

### 3.2 New Built-in Template: `cinematic-art-design`

Add to `BUILTIN_TEMPLATES`:

```typescript
{
  key: 'cinematic-art-design',
  displayName: '电影美术设定图',
  desc: '场景平面图+分镜+材质灯光+角色设定',
  icon: '🎬',
  prefix: `{完整 JSON 模板，原样保留}`,
  suffix: '',
  negative: 'blurry, lowres, bad anatomy, worst quality, text overlap, illegible labels',
  negativeEnabled: false,
}
```

The prefix is the full `templateMeta` → `outputSpec` JSON structure provided by the user, used verbatim as a structured prompt prefix. The JSON instructs the model to generate a cinematic art design reference sheet with floor plans, shot correspondence boards, character design sections, material/lighting references, and plot/atmosphere notes.

### 3.3 State Layer — `useTemplateStore.ts`

New file: `src/renderer/src/react-app/stores/useTemplateStore.ts`

```typescript
interface TemplateStoreState {
  // Keyed by page context to isolate selections
  selections: Record<string, string | null>  // e.g. { generate: 'anime', batch: null }
  getSelection(context: string): string | null
  setSelection(context: string, key: string | null): void
}
```

- Each page passes its own context key (`'generate'`, `'batch'`)
- Director continues using `useDirectorStore.currentTemplate` unchanged
- Persisted to localStorage under `template-selections.v1`

### 3.4 UI Layer — Component Split

Current `TemplateSelector.tsx` (358 lines) → split into:

**`TemplatePickerModal.tsx`** (~250 lines)
- The full-screen modal with grid of templates
- Edit/create/delete functionality
- Accepts props: `isOpen`, `onClose`, `currentTemplate`, `onSelect`
- Pure presentational — no store dependency

**`TemplateInline.tsx`** (~60 lines)
- Compact single-line trigger: `[icon + name] [选择模板] [清除]`
- Accepts props: `context: string` (page key)
- Uses `useTemplateStore` internally
- Opens `TemplatePickerModal` on click

**`TemplateSelector.tsx`** (refactored, ~20 lines)
- Director's existing component becomes a thin wrapper:
  ```typescript
  export function TemplateSelector() {
    // Delegates to TemplateInline with Director-specific store binding
  }
  ```
- Backward compatible — Director page unchanged

### 3.5 Mount Points — React Islands

In `index.html` (or dynamically created by AppBootstrap):

**Generate page** — insert `<div id="generate-template-root">` above `#promptInput` textarea, inside `#generatePanel`.

**Batch page** — insert `<div id="batch-template-root">` above the prompt area (between mode selector and prompt inputs), inside `#batchPanel`.

In `AppBootstrap.ts`, add React island mounting logic (following the existing Director pattern):

```typescript
// After DOM ready, mount template selectors
const genRoot = document.getElementById('generate-template-root')
if (genRoot) {
  createRoot(genRoot).render(<TemplateInline context="generate" />)
}

const batchRoot = document.getElementById('batch-template-root')
if (batchRoot) {
  createRoot(batchRoot).render(<TemplateInline context="batch" />)
}
```

### 3.6 Prompt Injection

When the user triggers generation:

1. Read selected template key from `useTemplateStore.getSelection('generate')` (or `'batch'`)
2. If a template is selected, call `getStyleInstructions(key)` to get `prefix + [SUBJECT] + suffix`
3. Replace `[SUBJECT]` with the user's raw prompt text
4. Send the composed prompt to the API

**Generate page:** Hook into `ApiService.generateImage()` or `preparePrompt()` — check for active template before sending.

**Batch card mode:** Same as Generate, wraps `#cardPromptInput` value.

**Batch multi mode:** Each prompt (separated by blank lines in `#batchPrompts`) is individually wrapped with the template's prefix/suffix.

The user's textarea content is never mutated. Style wrapping is applied at call time only.

### 3.7 UI Layout Adaptation

All pages use the existing cyberpunk dark theme tokens:
- `bg-[#27272A]` card background
- `border-[#3F3F46]` borders
- `bg-[#09090B]` inner display area
- Pink accent (`pink-500`) for action buttons
- `#FCE300` yellow for selected state

**Generate page (`TemplateInline`):**
```
┌─────────────────────────────────────────────┐
│ 🎨 风格模板  [日式动画 ×]  [选择模板]      │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ prompt textarea (#promptInput)              │
│                                             │
└─────────────────────────────────────────────┘
```

Single-line compact bar. When no template selected: `默认（无模板）`.

**Batch page (`TemplateInline`):**
Same compact bar, placed between mode selector (card/multi radio) and the prompt input area. Applies to both card and multi modes.

**Director page:**
No visual change. `TemplateSelector` refactored internally but renders identically.

## 4. File Changes Summary

| File | Action |
|------|--------|
| `react-app/constants/templates.ts` | Add `cinematic-art-design` to `BUILTIN_TEMPLATES` |
| `react-app/stores/useTemplateStore.ts` | **New** — shared template selection store |
| `react-app/components/TemplatePickerModal.tsx` | **New** — extracted modal from TemplateSelector |
| `react-app/components/TemplateInline.tsx` | **New** — compact inline trigger |
| `react-app/components/TemplateSelector.tsx` | Refactor to compose TemplateInline + TemplatePickerModal |
| `core/AppBootstrap.ts` | Add React island mounts for generate/batch |
| `index.html` | Add `#generate-template-root` and `#batch-template-root` divs |
| API call sites (generate/batch) | Add template prompt wrapping before API call |

## 5. Out of Scope

- Migrating Generate/Batch pages to full React
- Adding template thumbnails/preview images
- Template categories/tags filtering
- Template sharing/import/export
