# Custom Templates — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to create custom style templates that persist in localStorage, displayed alongside built-in templates in the template selector.

**Architecture:** Add CRUD functions for custom templates in `templates.ts`, update `TemplateSelector.tsx` to show custom templates and a "新建模板" button. No pipeline changes needed — custom template keys fall back to styleAnchor-based inference.

**Tech Stack:** TypeScript, React, Zustand, localStorage, Vitest

**Design Doc:** `docs/plans/2026-03-05-custom-templates-design.md`

---

### Task 1: Add Custom Template Storage Functions

**Files:**
- Modify: `src/renderer/src/react-app/constants/templates.ts`
- Create: `src/renderer/src/react-app/__tests__/custom-templates.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/react-app/__tests__/custom-templates.test.ts
import { describe, expect, it, beforeEach, vi } from 'vitest'

// Mock localStorage
const store: Record<string, string> = {}
const localStorageMock = {
  getItem: vi.fn((key: string) => store[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value }),
  removeItem: vi.fn((key: string) => { delete store[key] }),
}
Object.defineProperty(globalThis, 'window', {
  value: { localStorage: localStorageMock },
  writable: true,
})

import {
  addCustomTemplate,
  getCustomTemplates,
  deleteCustomTemplate,
  getAllTemplates,
  BUILTIN_TEMPLATES,
  TEMPLATE_MAP,
} from '../constants/templates'

describe('Custom Templates', () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key]
    vi.clearAllMocks()
  })

  it('should add a custom template and return its key', () => {
    const key = addCustomTemplate({
      displayName: 'My Style',
      desc: 'test',
      icon: '✏️',
      prefix: 'my prefix, ',
      suffix: ', my suffix',
      negative: 'blurry',
      negativeEnabled: true,
    })
    expect(key).toMatch(/^custom-/)
    expect(TEMPLATE_MAP[key]).toBeDefined()
    expect(TEMPLATE_MAP[key].displayName).toBe('My Style')
  })

  it('should persist custom templates to localStorage', () => {
    addCustomTemplate({
      displayName: 'Saved',
      desc: '',
      icon: '✏️',
      prefix: 'p',
      suffix: 's',
      negative: 'n',
      negativeEnabled: false,
    })
    expect(localStorageMock.setItem).toHaveBeenCalled()
    const saved = getCustomTemplates()
    expect(saved.length).toBe(1)
    expect(saved[0].displayName).toBe('Saved')
  })

  it('should delete a custom template', () => {
    const key = addCustomTemplate({
      displayName: 'ToDelete',
      desc: '',
      icon: '✏️',
      prefix: '',
      suffix: '',
      negative: '',
      negativeEnabled: false,
    })
    expect(TEMPLATE_MAP[key]).toBeDefined()
    deleteCustomTemplate(key)
    expect(TEMPLATE_MAP[key]).toBeUndefined()
    expect(getCustomTemplates().length).toBe(0)
  })

  it('should not delete builtin templates', () => {
    deleteCustomTemplate('cinematic')
    expect(TEMPLATE_MAP['cinematic']).toBeDefined()
  })

  it('getAllTemplates should return builtin + custom', () => {
    addCustomTemplate({
      displayName: 'Extra',
      desc: '',
      icon: '✏️',
      prefix: '',
      suffix: '',
      negative: '',
      negativeEnabled: false,
    })
    const all = getAllTemplates()
    expect(all.length).toBe(BUILTIN_TEMPLATES.length + 1)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/__tests__/custom-templates.test.ts`
Expected: FAIL — `addCustomTemplate`, `getCustomTemplates`, `deleteCustomTemplate`, `getAllTemplates` not exported

**Step 3: Write minimal implementation**

Add to the end of `src/renderer/src/react-app/constants/templates.ts` (before the closing), after `getStyleInstructions`:

```typescript
const CUSTOM_TEMPLATES_STORAGE_KEY = 'director.custom-templates.v1'

function readCustomTemplates(): TemplateData[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return []
    const raw = window.localStorage.getItem(CUSTOM_TEMPLATES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as TemplateData[]
  } catch {
    return []
  }
}

function writeCustomTemplates(templates: TemplateData[]): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(CUSTOM_TEMPLATES_STORAGE_KEY, JSON.stringify(templates))
  } catch {
    // Best-effort persistence
  }
}

export function getCustomTemplates(): TemplateData[] {
  return readCustomTemplates()
}

export function addCustomTemplate(data: Omit<TemplateData, 'key'>): string {
  const key = `custom-${Date.now()}`
  const template: TemplateData = { ...data, key }

  const customs = readCustomTemplates()
  customs.push(template)
  writeCustomTemplates(customs)

  TEMPLATE_MAP[key] = { ...template }
  return key
}

export function deleteCustomTemplate(key: string): void {
  if (!key.startsWith('custom-')) return
  const customs = readCustomTemplates().filter(t => t.key !== key)
  writeCustomTemplates(customs)
  delete TEMPLATE_MAP[key]
}

export function updateCustomTemplate(key: string, data: Omit<TemplateData, 'key'>): void {
  if (!key.startsWith('custom-')) return
  const customs = readCustomTemplates().map(t =>
    t.key === key ? { ...data, key } : t
  )
  writeCustomTemplates(customs)
  TEMPLATE_MAP[key] = { ...data, key }
}

export function getAllTemplates(): TemplateData[] {
  return [...BUILTIN_TEMPLATES, ...readCustomTemplates()]
}

// Load custom templates into TEMPLATE_MAP on module init
for (const t of readCustomTemplates()) {
  TEMPLATE_MAP[t.key] = { ...t }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/__tests__/custom-templates.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/constants/templates.ts src/renderer/src/react-app/__tests__/custom-templates.test.ts
git commit -m "feat: add custom template CRUD with localStorage persistence"
```

---

### Task 2: Update TemplateSelector UI

**Files:**
- Modify: `src/renderer/src/react-app/components/TemplateSelector.tsx`

**Step 1: Import new functions**

Add to imports:

```typescript
import {
  BUILTIN_TEMPLATES,
  TEMPLATE_MAP,
  persistTemplateOverride,
  resetTemplateOverride,
  addCustomTemplate,
  deleteCustomTemplate,
  updateCustomTemplate,
  getAllTemplates,
  type TemplateData,
} from '../constants/templates'
```

**Step 2: Replace BUILTIN_TEMPLATES in grid with getAllTemplates**

In the modal grid (line ~114), replace:

```typescript
{BUILTIN_TEMPLATES.map((t) => {
```

With:

```typescript
{getAllTemplates().map((t) => {
  const isCustom = t.key.startsWith('custom-')
```

And update the label from `<span>内置</span>` to:

```typescript
<span className="ml-2 text-xs text-white opacity-30">
  {isCustom ? '自定义' : '内置'}
</span>
```

**Step 3: Update openEditor to support custom templates**

Replace the `openEditor` callback:

```typescript
  const openEditor = useCallback((key: string) => {
    const t = TEMPLATE_MAP[key]
    if (!t) return
    setEditor({
      key,
      name: t.displayName,
      prefix: t.prefix,
      suffix: t.suffix,
      negative: t.negative,
      negativeEnabled: t.negativeEnabled ?? false,
      isBuiltin: !key.startsWith('custom-'),
    })
  }, [])
```

**Step 4: Add "新建模板" button in modal footer**

In the modal footer (line ~158), add a button before the 确定 button:

```typescript
<div className="px-6 py-3 border-t border-[#3F3F46] flex items-center justify-between">
  <span className="text-white opacity-30 text-xs">
    {currentTemplate ? `已选: ${active?.displayName}` : '未选择模板'}
  </span>
  <div className="flex gap-2">
    <button
      onClick={() => {
        setEditor({
          key: '',
          name: '',
          prefix: '',
          suffix: '',
          negative: 'blurry, lowres, bad anatomy, worst quality',
          negativeEnabled: false,
          isBuiltin: false,
        })
      }}
      className="bg-[#3F3F46] hover:bg-[#52525B] text-white px-3 py-2 rounded-none text-sm transition-colors flex items-center gap-1"
    >
      <i className="fas fa-plus" />
      新建模板
    </button>
    <button
      onClick={() => setShowModal(false)}
      className="bg-[#FCE300] text-black font-bold px-4 py-2 rounded-none text-sm uppercase tracking-tighter hover:scale-105 transition-all"
    >
      确定
    </button>
  </div>
</div>
```

**Step 5: Update editor save logic to handle new vs edit**

In the editor save button onClick (line ~263), replace:

```typescript
onClick={() => {
  if (editor.key && editor.key.startsWith('custom-')) {
    updateCustomTemplate(editor.key, {
      displayName: editor.name,
      desc: '',
      icon: '✏️',
      prefix: editor.prefix,
      suffix: editor.suffix,
      negative: editor.negative,
      negativeEnabled: editor.negativeEnabled,
    })
  } else if (editor.key) {
    persistTemplateOverride(editor.key, {
      prefix: editor.prefix,
      suffix: editor.suffix,
      negative: editor.negative,
      negativeEnabled: editor.negativeEnabled,
    })
  } else {
    const newKey = addCustomTemplate({
      displayName: editor.name || '自定义模板',
      desc: '',
      icon: '✏️',
      prefix: editor.prefix,
      suffix: editor.suffix,
      negative: editor.negative,
      negativeEnabled: editor.negativeEnabled,
    })
    setTemplate(newKey)
  }
  setEditor(null)
  const toast = (window as any).toastManagerTS ?? (window as any).toastManager
  toast?.show?.('模板已保存', 'success')
}}
```

**Step 6: Enable name editing for custom templates**

The existing `disabled={editor.isBuiltin}` on the name input already handles this — custom templates have `isBuiltin: false` so the name field is editable.

**Step 7: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 8: Commit**

```bash
git add src/renderer/src/react-app/components/TemplateSelector.tsx
git commit -m "feat: add custom template creation UI with new/edit/save flow"
```

---

### Task 3: Integration Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No new type errors

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve any remaining issues from custom templates feature"
```
