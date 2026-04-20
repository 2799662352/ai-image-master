# Media Token Mentions (`@参考图`) Design

**Date:** 2026-04-20
**Status:** Approved
**Reference:** `D:\tecx\text\25\soraui_4.0\sora-ui\src\components\TokenTextArea.tsx` + `useTokenAutocomplete.ts`
**Scope:** `#batch` (card + multi), `#generate`, `#director`

## Problem

Users working with multiple reference images have no way to tell the model *which* reference image a particular instruction applies to. The image editor prefix feature (`Based on reference image 【@图片N】`) established the `【@图片N】` token convention. We now extend this so users can also insert tokens manually by typing `@` anywhere in the prompt — the same UX Sora / Jimeng use.

## Constraints

- **No antd.** Project uses React + Tailwind + custom "Punk" CSS (`donor-punk.css`).
- **No new dependencies.** `react-mentions-ts` was evaluated and rejected: default styles fight the Punk theme, no chip strip, no empty-state primitive — net negative after theme overrides.
- **Existing token convention must be preserved:** `【@图片N】`, N = 1-based absolute index in the page's `refImages` / `referenceImages` array.
- **Stores not upgraded.** `useGenerateStore.referenceImages` stays `string[]`. Chips use `图片N` as the label fallback.
- **Backend is dumb.** Token is a visual marker for the downstream model — `runBatch` and `generate` still send *all* reference images as before.

## Design

### 1. Shared module

New directory: `src/renderer/src/components/shared/media-tokens/`

| File | Responsibility |
|---|---|
| `types.ts` | `MediaRef` + `Theme` types |
| `useTokenAutocomplete.ts` | `@` detection, caret coordinates, keyboard navigation, suggestion filtering |
| `TokenAutocomplete.tsx` | Portal-based popup component (keyboard + click selection, empty state) |
| `MentionChips.tsx` | Chip strip below textarea — thumbnails + labels + × remove |
| `media-tokens.css` | Punk + default theme styles |
| `index.ts` | Barrel export |

### 2. Types

```typescript
// types.ts
export interface MediaRef {
  index: number          // 1-based absolute position in refImages array
  type: 'image'          // reserved for future video/audio
  url: string            // dataURL or http URL, used for thumbnail
  label?: string         // fallback: '图片${index}'
}

export type TokenTheme = 'punk' | 'default'
```

### 3. Token format & regex

- **Insert text:** `【@图片N】` (full-width brackets, as established)
- **Parse regex:** `/【@图片(\d+)】/g`
- Auto-whitespace: insert a leading space if `@` is preceded by non-whitespace/non-punctuation (ported from sora-ui's auto-spacing logic)

### 4. `useTokenAutocomplete` hook

```typescript
interface UseTokenAutocompleteProps {
  mediaRefs: MediaRef[]
  onApplyToken: (newText: string, newCursorPosition: number) => void
  maxSuggestions?: number  // default 10
}

interface UseTokenAutocompleteReturn {
  visible: boolean
  suggestions: MediaRef[]
  selectedIndex: number
  position: { top: number; left: number }    // viewport-relative, popup must use `position: fixed`
  handleTextChange: (text: string, cursor: number, el: HTMLTextAreaElement) => void
  handleKeyDown: (e: React.KeyboardEvent) => boolean  // true = consumed
  handleSelect: (ref: MediaRef) => void
  handleClose: () => void
  handleHover: (index: number) => void
}
```

**Behaviors (all ported from sora-ui, simplified to image-only):**

- `@` detection: walks back from cursor, stops at whitespace/punctuation, looks for `@`.
  - `@` itself must be at start-of-line or preceded by `\s|\n|\r|】|）|}|]|」|』` — prevents triggering inside email addresses.
- Auto-spacing: if cursor is right after `@` and the char before is `[^\s\n\r,，。！？!?;；】）})\]」』]`, a space is injected automatically.
- Debounced (80ms) suggestion filtering.
- Keyboard: ↑/↓ wrap, Enter select, Esc close, Space close (non-consuming).
- Filter: suggestion shown if `prefix.toLowerCase()` is included in `label.toLowerCase()` OR in `'图片'` (so `@图` shows all, `@1` shows image1, `@` shows all).

**Caret coordinates** use the standard "hidden mirror div" technique (copy computed styles from textarea → build a div → insert text + cursor span → measure span's bounding rect). Works in Electron renderer. ~30 lines.

### 5. `TokenAutocomplete` component

Portal to `document.body`. Flips above cursor when no space below. Renders:

```
┌────────────────────┐
│ [thumb] 图片1       │ ← selected (focused styling)
│ [thumb] 图片2       │
│ [thumb] 图片3       │
└────────────────────┘
```

Empty state (mediaRefs empty or no matches):
```
┌──────────────────────┐
│  请先上传参考图          │
└──────────────────────┘
```

Closes on:
- Native `mousedown` outside `.token-autocomplete-container` (via `document.addEventListener`, NOT React synthetic events — createPortal event propagation caveat from React docs)
- Esc key
- Space key (signals user abandoned the mention)

### 6. `MentionChips` component

```typescript
interface MentionChipsProps {
  value: string                      // current textarea value
  onChange: (newValue: string) => void
  mediaRefs: MediaRef[]              // for thumbnail lookup
  theme: TokenTheme
}
```

Parses `value` for `【@图片N】` tokens (deduped via `Set`). For each:
- Lookup `mediaRefs.find(r => r.index === N)`
- Found → 22×22 thumbnail + `图片N` label + × button
- Not found (user deleted the ref after inserting the token) → 📷 emoji, dimmed style, × still works
- × click: `value.replace(/【@图片N】\s?/g, '')` (also eats trailing space)

Rendered only when at least one token is present.

### 7. Theme styles (`media-tokens.css`)

- **Punk** (`.mt-theme-punk`):
  - Popup: `background: var(--punk-cream); border: 3px solid var(--punk-black); box-shadow: 4px 4px 0 var(--punk-pink)`
  - Item focused: `background: var(--punk-toxic); color: var(--punk-black)`
  - Chip: 1.5px border `var(--punk-black)`, small `var(--punk-pink)` shadow, uppercase `p-mono` label
- **Default** (`.mt-theme-default`):
  - Popup: `background: #18181b; border: 1px solid #3f3f46; box-shadow: 0 4px 12px rgba(0,0,0,0.4)`
  - Item focused: `background: #3f3f46; color: #22d3ee`
  - Chip: zinc background, cyan accent

### 8. Per-page integration

**a) BatchPage → PunkPromptCard**

```tsx
<PunkPromptCard
  prompt={cardPrompt}
  count={cardCount}
  onPromptChange={setCardPrompt}
  onCountChange={setCardCount}
  mediaRefs={batchMediaRefs}   // NEW
/>
```

Inside `PunkPromptCard.tsx`: wrap the `<textarea>` with:
- `useTokenAutocomplete` hook wired to `onChange` of the textarea
- `<TokenAutocomplete theme="punk" ... />` sibling (portal, so doesn't matter where in JSX)
- `<MentionChips theme="punk" value={prompt} onChange={onPromptChange} mediaRefs={mediaRefs} />` rendered below the textarea container

BatchPage computes once per render:
```ts
const batchMediaRefs: MediaRef[] = refImages.map((r, i) => ({
  index: i + 1,
  type: 'image',
  url: r.base64,
  label: `图片${i + 1}`,
}))
```

**b) BatchPage → PunkPromptMulti** — same pattern.

**c) GeneratePage** — inline in page (no sub-component refactor):
```ts
const generateMediaRefs: MediaRef[] = referenceImages.map((url, i) => ({
  index: i + 1, type: 'image', url, label: `图片${i + 1}`,
}))
```
Attach autocomplete hook to the existing textarea, render `<MentionChips theme="default" ... />` below it.

**d) DirectorPage (stub)** — expand to a minimal test block:
```tsx
const [prompt, setPrompt] = useState('')
const [refs, setRefs] = useState<string[]>([])
const mediaRefs = refs.map((url, i) => ({ index: i+1, type: 'image', url, label: `图片${i+1}` }))
```
Add:
- A simple drag-drop / file input for refs (reuse `<ReferenceImageList />` from generate)
- A textarea with autocomplete + chips
- No generate button in this pass (this is just the mention feature demo; image-editor block already has its own generate flow per phase 3)

### 9. Edge cases

| Case | Behavior |
|---|---|
| No refs uploaded, user types `@` | Popup shows empty-state "请先上传参考图" |
| User deletes a ref after inserting token | Chip keeps showing, 📷 placeholder, × still works |
| User pastes text containing `【@图片99】` (ref doesn't exist) | Chip shows "图片99" with placeholder |
| Two `【@图片1】` tokens in same prompt | Chip deduped (shown once). × removes all instances |
| `@` inside a word (e.g., `email@x.com`) | Not triggered (preceded by non-whitespace) |
| Multiple `@` queries in flight | Latest wins (ref pattern from sora-ui, no race) |

### 10. Performance

- Autocomplete filtering is debounced 80ms
- MentionChips regex scan runs on every render but is O(n) on prompt length — fine for < 10KB inputs
- Thumbnail strings (dataURL) are already in memory (store), no re-decoding

### 11. Accessibility

- Popup: `role="listbox"`, items `role="option"` with `aria-selected`
- Chip × button: `aria-label="删除引用 图片N"`
- Empty state: `role="status"`

### 12. File changes summary

**New (6 files):**
- `components/shared/media-tokens/types.ts`
- `components/shared/media-tokens/useTokenAutocomplete.ts`
- `components/shared/media-tokens/TokenAutocomplete.tsx`
- `components/shared/media-tokens/MentionChips.tsx`
- `components/shared/media-tokens/media-tokens.css`
- `components/shared/media-tokens/index.ts`

**Modified (5 files):**
- `pages-react/batch-punk/PunkPromptCard.tsx` — accept `mediaRefs` prop, wire hook + chips
- `pages-react/batch-punk/PunkPromptMulti.tsx` — same
- `pages-react/BatchPage.tsx` — build `mediaRefs`, pass down to both prompt components
- `pages-react/GeneratePage.tsx` — inline autocomplete + chips
- `pages-react/DirectorPage.tsx` — expand stub to test block with upload + autocomplete + chips

### 13. Explicit YAGNI

Out of scope for this pass:
- Highlight backdrop layer inside textarea
- Chip hover preview popover
- Video / audio token types (`【@视频N】`, `【@音频N】`)
- Character card `@name` mentions
- Fuzzy search, usage ranking, favorites
- Upgrading `useGenerateStore.referenceImages` to richer structure
- Director end-to-end generate wire-up (stays a stub beyond this mention feature)

### 14. Testing

No automated tests this pass (DOM-heavy, covered by manual verification). Manual checklist:

1. Batch page, upload 3 images
   - `PunkPromptCard`: type `@` → popup shows 3 suggestions → arrow + Enter → token inserted + chip appears
   - `PunkPromptMulti`: same
   - Remove via chip × → token disappears from text
2. Generate page, upload 2 images, repeat above
3. Director page stub: upload → type `@` → works end-to-end
4. Delete a ref image that has a dangling token → chip goes dimmed with 📷 placeholder
5. No refs + type `@` → popup shows "请先上传参考图"
6. Paste text with pre-existing `【@图片3】` → chip appears (even if only 2 refs uploaded, dimmed)

### 15. Risks

| Risk | Mitigation |
|---|---|
| Caret coordinate measurement fails in Electron | Copy sora-ui's tested mirror-div implementation verbatim |
| Portal event propagation breaks click-outside | Use native `document.addEventListener('mousedown')`, not React synthetic (docs verified) |
| Popup z-index conflicts with modals | Use `z-index: 10000`, same tier as existing preview modals |
| `PunkPromptMulti` might also be used as rich multi-prompt (tokenize differently) | Verified: current impl is plain textarea, no special parsing |
