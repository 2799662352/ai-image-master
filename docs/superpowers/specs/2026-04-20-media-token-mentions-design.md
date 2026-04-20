# Media Token Mentions (`@参考图`) Design

**Date:** 2026-04-20
**Status:** Approved (v2 — post review)
**Reference:** `D:\tecx\text\25\soraui_4.0\sora-ui\src\components\TokenTextArea.tsx` + `useTokenAutocomplete.ts`
**Scope:** `#batch` (card + multi), `#generate`, `#director`
**Review:** Code-reviewer found 3C/7I/6S. All critical and important items addressed below.

## Problem

Users working with multiple reference images have no way to tell the model *which* reference image a particular instruction applies to. The image editor prefix feature (`Based on reference image 【@图片N】`) established the `【@图片N】` token convention. We now extend this so users can also insert tokens manually by typing `@` anywhere in the prompt — the same UX Sora / Jimeng use.

## Constraints

- **No antd.** Project uses React + Tailwind + custom "Punk" CSS (`donor-punk.css`).
- **No new dependencies.** `react-mentions-ts` was evaluated and rejected; custom `setTimeout/clearTimeout` debounce instead of lodash. (I5 fix)
- **Existing token convention must be preserved:** `【@图片N】`, N = 1-based absolute index in the page's `refImages` / `referenceImages` array.
- **Stores not upgraded.** `useGenerateStore.referenceImages` stays `string[]`. Chips use `图片N` as the label fallback.
- **Backend is dumb.** Token is a visual marker for the downstream model — `runBatch` and `generate` still send *all* reference images as before.

## Design

### 1. Shared module

New directory: `src/renderer/src/components/shared/media-tokens/`

| File | Responsibility |
|---|---|
| `types.ts` | `MediaRef` + `Theme` types + `TOKEN_REGEX` + `makeToken()` (S5 fix) |
| `useTokenAutocomplete.ts` | `@` detection, caret coordinates, keyboard navigation, suggestion filtering, cursor restoration |
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

// Shared constants — single source of truth (S5 fix)
export const TOKEN_REGEX = /【@图片(\d+)】/g
export const makeToken = (n: number) => `【@图片${n}】`
```

### 3. Token format & regex

- **Insert text:** `【@图片N】` (full-width brackets, as established)
- **Parse regex:** `TOKEN_REGEX` (exported from `types.ts`)
- Auto-whitespace: insert a leading space if `@` is preceded by non-whitespace/non-punctuation (ported from sora-ui's auto-spacing logic)

### 4. `useTokenAutocomplete` hook

```typescript
interface UseTokenAutocompleteProps {
  mediaRefs: MediaRef[]
  textareaRef: React.RefObject<HTMLTextAreaElement | null>  // (C2+S2 fix: hook manages cursor)
  value: string                                              // current textarea value
  onValueChange: (newValue: string) => void                 // single state update
}

interface UseTokenAutocompleteReturn {
  visible: boolean
  suggestions: MediaRef[]
  selectedIndex: number
  position: { top: number; left: number }    // viewport-relative, popup must use `position: fixed`
  handleChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void  // replaces raw onChange
  handleKeyDown: (e: React.KeyboardEvent) => void                   // S4 fix: calls preventDefault internally
  handleClose: () => void
  handleHover: (index: number) => void
}
```

**Key design change (I1 fix):** `handleChange` is the ONLY onChange handler the textarea needs. It:
1. Reads `e.target.value` and `e.target.selectionStart` directly (I7 fix: always fresh, no stale cache)
2. If auto-spacing fires, produces modified text + cursor internally
3. Calls `onValueChange(finalText)` exactly once per keystroke (no double write)
4. Runs `@` detection and popup logic

**Cursor restoration (C2 fix):** Hook maintains `pendingCursorRef: React.MutableRefObject<number | null>`. An internal `useEffect` runs after every render; when `pendingCursorRef.current !== null`, it sets `textareaRef.current.selectionStart/End` and clears the ref. This handles both token insertion and auto-spacing.

**Filter logic (C3 fix):**
```typescript
const cleanPrefix = prefix.slice(1).toLowerCase()  // strip leading @
const matchesIndex = !isNaN(Number(cleanPrefix)) && ref.index === Number(cleanPrefix)  // S3 fix
const matchesLabel = (ref.label || '').toLowerCase().includes(cleanPrefix)
const matchesType = '图片'.includes(cleanPrefix)
return matchesIndex || matchesLabel || matchesType || cleanPrefix === ''
```

**Debounce (I5 fix):** Uses `setTimeout/clearTimeout` pattern (stored in `timerRef`), no lodash:
```typescript
const timerRef = useRef<ReturnType<typeof setTimeout>>()
// in detection:
clearTimeout(timerRef.current)
timerRef.current = setTimeout(() => filterAndSetSuggestions(cleanPrefix), 80)
// cleanup in useEffect return
```

**Keyboard (S4 fix):** `handleKeyDown` calls `e.preventDefault()` internally for ↑/↓/Enter/Esc when popup is visible and returns. Space does NOT call `preventDefault` (allows space to be typed). Caller wires it as `onKeyDown={handleKeyDown}` — no return value check needed.

**Caret coordinates (I4 fix):** `getCaretCoordinates(el, pos, textOverride?)` — uses `textOverride ?? el.value` for the mirror div content. This handles the case where auto-spacing has modified the text but React hasn't re-rendered yet.

**Behaviors (all ported from sora-ui, simplified to image-only):**

- `@` detection: walks back from cursor, stops at whitespace/punctuation, looks for `@`.
  - `@` itself must be at start-of-line or preceded by `\s|\n|\r|】|）|}|]|」|』` — prevents triggering inside email addresses.
- Auto-spacing: if cursor is right after `@` and the char before is `[^\s\n\r,，。！？!?;；】）})\]」』]`, a space is injected before `@`.
- Keyboard: ↑/↓ wrap, Enter select, Esc close, Space close (non-consuming).

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

Parses `value` for tokens using `TOKEN_REGEX` (deduped via `Set`, memoized with `useMemo` — S1 fix). For each:
- Lookup `mediaRefs.find(r => r.index === N)`
- Found → 22×22 thumbnail + `图片N` label + × button
- Not found (user deleted the ref after inserting the token) → 📷 emoji, dimmed style, × still works
- × click: `value.replace(/\s?【@图片N】\s?/g, ' ').replace(/ {2,}/g, ' ').trim()` (I2 fix: no double spaces)

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

**Hook placement (I3 fix):** The hook lives inside each prompt component (`PunkPromptCard`, `PunkPromptMulti`, inline in `GeneratePage`, inline in `DirectorPage`). It is NOT lifted to `BatchPage` — this avoids stale state across mode switches.

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

Inside `PunkPromptCard.tsx`: textarea gets `onChange={handleChange}` and `onKeyDown={handleKeyDown}` from the hook. Below textarea: `<MentionChips>`. Portal sibling: `<TokenAutocomplete>`.

BatchPage computes once per render:
```ts
const batchMediaRefs: MediaRef[] = refImages.map((r, i) => ({
  index: i + 1,
  type: 'image' as const,
  url: r.base64,
  label: `图片${i + 1}`,
}))
```

**b) BatchPage → PunkPromptMulti** — same pattern.

**c) GeneratePage** — inline in page (no sub-component refactor):
```ts
const generateMediaRefs: MediaRef[] = referenceImages.map((url, i) => ({
  index: i + 1, type: 'image' as const, url, label: `图片${i + 1}`,
}))
```
Attach autocomplete hook to the existing textarea, render `<MentionChips theme="default" ... />` below it.

**d) DirectorPage (stub)** — expand to a minimal test block:
```tsx
const [prompt, setPrompt] = useState('')
const [refs, setRefs] = useState<string[]>([])
const mediaRefs = refs.map((url, i) => ({ index: i+1, type: 'image' as const, url, label: `图片${i+1}` }))
```
Add:
- A simple drag-drop / file input for refs (reuse `<ReferenceImageList />` from generate)
- A textarea with autocomplete + chips
- No generate button in this pass (this is just the mention feature demo)

### 9. Ref deletion & token stability (C1 fix)

**Problem:** When user deletes a reference image, all positional indices shift down. Existing `【@图片N】` tokens may silently point to the wrong image.

**Solution:** When a ref image is deleted on a page that has active prompt text with `【@图片N】` tokens:
- Show a toast warning: `"参考图已删除, 请检查 @ 引用是否正确"`
- Chip of the now-orphaned token shows 📷 placeholder (dimmed)
- User can × delete the stale token, or manually correct

**Rationale for NOT auto-rewriting indices:**
- `useBatchStore` has `removeRefImage(id)` → we'd need to hook into this action to parse and rewrite prompt text across two different text fields (card/multi depending on mode). Invasive.
- `useGenerateStore` has `removeReferenceImage(index)` on a `string[]` → no stable ID at all.
- Auto-rewriting silently mutating user text is a worse UX than a visible warning.
- This is a rare scenario (user uploads, writes prompt referencing specific images, then deletes one of them).

### 10. Edge cases

| Case | Behavior |
|---|---|
| No refs uploaded, user types `@` | Popup shows empty-state "请先上传参考图" |
| User deletes a ref after inserting token | Toast warning + chip dimmed with 📷 placeholder, × still works |
| User pastes text containing `【@图片99】` (ref doesn't exist) | Chip shows "图片99" with placeholder |
| Two `【@图片1】` tokens in same prompt | Chip deduped (shown once). × removes all instances |
| `@` inside a word (e.g., `email@x.com`) | Not triggered (preceded by non-whitespace) |
| Multiple `@` queries in flight | Latest wins (debounce cancels previous) |
| `PunkPromptHelperBar` injects text with token | MentionChips detects token. Hook not involved (no `@` to trigger). Cursor stays at end (append). (I7 addressed) |
| Mode switch (card↔multi) while popup visible | Popup unmounts with component. No stale state. (I3 confirmed) |

### 11. Performance

- Autocomplete filtering is debounced 80ms (setTimeout, not lodash)
- MentionChips regex scan memoized with `useMemo([value])` (S1 fix)
- Thumbnail strings (dataURL) are already in memory (store), no re-decoding

### 12. Accessibility

- Popup: `role="listbox"`, items `role="option"` with `aria-selected`
- Chip × button: `aria-label="删除引用 图片N"`
- Empty state: `role="status"`

### 13. z-index hierarchy (I6 fix)

| Layer | z-index | Component |
|---|---|---|
| Preview modal | 70000 | BatchPage fullscreen preview |
| Autocomplete popup | 10000 | TokenAutocomplete (portal) |
| Editor modal | 9999 | ImageEditorModal (portal) |
| Normal content | auto | Everything else |

### 14. File changes summary

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
- `pages-react/GeneratePage.tsx` — inline autocomplete + chips, add textareaRef
- `pages-react/DirectorPage.tsx` — expand stub to test block with upload + autocomplete + chips

**Optionally modified (1 file):**
- `components/shared/image-editors/prompts.ts` — `withRefPrefix` can import `makeToken` from `media-tokens/types.ts` instead of inlining the template literal

### 15. Explicit YAGNI

Out of scope for this pass:
- Highlight backdrop layer inside textarea
- Chip hover preview popover
- Video / audio token types (`【@视频N】`, `【@音频N】`)
- Character card `@name` mentions
- Fuzzy search, usage ranking, favorites
- Upgrading `useGenerateStore.referenceImages` to richer structure
- Director end-to-end generate wire-up (stays a stub beyond this mention feature)
- Auto-rewriting token indices on ref deletion (documented limitation in §9)

### 16. Testing

No automated tests this pass (DOM-heavy, covered by manual verification). Manual checklist:

1. Batch page, upload 3 images
   - `PunkPromptCard`: type `@` → popup shows 3 suggestions → arrow + Enter → token inserted + chip appears + **cursor positioned after token** (C2 verify)
   - `PunkPromptMulti`: same
   - Remove via chip × → token disappears from text, **no double spaces** (I2 verify)
2. Generate page, upload 2 images, repeat above
3. Director page stub: upload → type `@` → works end-to-end
4. Delete a ref image that has a dangling token → **toast warning** (C1 verify) + chip dimmed with 📷
5. No refs + type `@` → popup shows "请先上传参考图"
6. Paste text with pre-existing `【@图片3】` → chip appears (even if only 2 refs uploaded, dimmed)
7. Type `@1` → only image1 suggestion shown (S3 verify)
8. PunkPromptHelperBar injects text with `【@图片N】` → chip appears without `@` popup (I7 verify)

### 17. Risks

| Risk | Mitigation |
|---|---|
| Caret coordinate measurement fails in Electron | Copy sora-ui's tested mirror-div implementation with `textOverride` param (I4 fix) |
| Portal event propagation breaks click-outside | Use native `document.addEventListener('mousedown')`, not React synthetic (docs verified) |
| Popup z-index conflicts with modals | Documented hierarchy in §13 |
| `PunkPromptMulti` might also be used as rich multi-prompt | Verified: current impl is plain textarea, no special parsing |
| Token index drift on ref deletion | Toast warning approach (C1 fix — §9) |

### Review changelog (v2)

| ID | Severity | Issue | Fix applied |
|---|---|---|---|
| C1 | Critical | Token index silently remaps on ref deletion | Toast warning on deletion (§9) |
| C2 | Critical | Cursor jumps to EOL after token insertion | Hook accepts `textareaRef`, internal `useEffect` cursor restore (§4) |
| C3 | Critical | Filter doesn't strip `@` from prefix | `cleanPrefix = prefix.slice(1).toLowerCase()` (§4) |
| I1 | Important | Double state write on auto-spacing | `handleChange` is single entry point, one `onValueChange` call (§4) |
| I2 | Important | × removal leaves double spaces | Post-removal regex collapse (§6) |
| I3 | Important | Hook placement ambiguous | Explicit: hook inside each prompt component (§8) |
| I4 | Important | Mirror div reads stale `element.value` | `getCaretCoordinates` accepts `textOverride` (§4) |
| I5 | Important | lodash not in deps | `setTimeout/clearTimeout` pattern (§4, constraints) |
| I6 | Important | z-index hierarchy undocumented | New §13 with layer table |
| I7 | Important | Programmatic inject bypasses hook cache | Hook reads from element directly, no cache dependency (§4) |
| S1 | Suggestion | MentionChips regex not memoized | `useMemo([value])` (§6) |
| S2 | Suggestion | Hook should accept textareaRef | Merged into C2 fix (§4) |
| S3 | Suggestion | `@digit` needs explicit match | Added `matchesIndex` check (§4) |
| S4 | Suggestion | handleKeyDown should preventDefault internally | Specified in §4, API returns void |
| S5 | Suggestion | Export shared TOKEN_REGEX + makeToken | Added to types.ts (§2) |
| S6 | Suggestion | DirectorPage expansion premature | Not adopted — minimal test block stays |
