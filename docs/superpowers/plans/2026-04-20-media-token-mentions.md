# Media Token Mentions — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-04-20-media-token-mentions-design.md` (v2)
**Status:** In Progress

## Tasks

### Task 1: Create `types.ts` + `media-tokens.css` + `index.ts`
- New `src/renderer/src/components/shared/media-tokens/types.ts` — `MediaRef`, `TokenTheme`, `TOKEN_REGEX`, `makeToken()`
- New `media-tokens.css` — punk + default themes
- New `index.ts` — barrel
- Commit

### Task 2: Create `useTokenAutocomplete.ts`
- Hook with `textareaRef`, `value`, `mediaRefs`, `onValueChange`
- `@` detection, auto-spacing, caret coordinates (mirror div with textOverride)
- Debounced filtering (setTimeout), keyboard navigation (preventDefault internal)
- Cursor restoration via `pendingCursorRef` + `useEffect`
- Token insertion via `makeToken`
- Commit

### Task 3: Create `TokenAutocomplete.tsx`
- Portal popup component
- Renders suggestion list with thumbnails
- Empty state "请先上传参考图"
- Flip above when no space below
- Click-outside via native `document.addEventListener('mousedown')`
- `role="listbox"` / `role="option"` accessibility
- Commit

### Task 4: Create `MentionChips.tsx`
- Parse tokens from `value` using `TOKEN_REGEX` (memoized)
- Render chip strip: thumbnail + label + × delete
- Missing ref → 📷 placeholder + dimmed
- × removal with space collapse
- Commit

### Task 5: Integrate into `PunkPromptCard.tsx`
- Add `mediaRefs` prop
- Add `textareaRef`, wire `useTokenAutocomplete`
- Render `<TokenAutocomplete>` + `<MentionChips>` below textarea
- Commit

### Task 6: Integrate into `PunkPromptMulti.tsx`
- Same pattern as Task 5
- Commit

### Task 7: Update `BatchPage.tsx`
- Build `batchMediaRefs` from `refImages`
- Pass `mediaRefs` to both `PunkPromptCard` and `PunkPromptMulti`
- Commit

### Task 8: Integrate into `GeneratePage.tsx`
- Add `textareaRef`, build `generateMediaRefs`
- Wire hook, render autocomplete + chips
- Theme: `default`
- Commit

### Task 9: Expand `DirectorPage.tsx` stub
- Local state for prompt + refs
- File input for ref upload
- Wire hook + autocomplete + chips (theme: `default`)
- Commit

### Task 10: Build + lint check
- `electron-vite build`
- Fix any issues
- Final commit if needed
