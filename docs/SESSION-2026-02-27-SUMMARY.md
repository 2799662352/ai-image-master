# Session Summary: Code Review + Quality Analysis + Build Pipeline Discovery

**Date:** 2026-02-27
**Previous session:** SESSION-2026-02-26-SUMMARY.md (LangChain Director upgrade)
**Commits this session:** 0 (analysis & UI tweak only, uncommitted)
**Files changed:** 2 (index.html × 2: textarea height)

---

## Knowledge Graph

```
[LangChainDirectorService.ts]
  ├── Zod Schema (14 fields: 6 required + 8 nullable)
  │     └── ⚠️ <output_format> in system prompt only describes 8 fields
  │         └── ROOT CAUSE: nullable fields unfilled (color_grade, body_physics, etc.)
  │
  ├── buildFinalPrompt() → JSON output
  │     ├── short key names: sh, l, sp, a, li, me, cg, atm, bp, comp, et, seq, mot
  │     ├── ⚠️ C1: scene spread is redundant (bgm/tension/shot_flow repeated after ...spread)
  │     └── negative → "n" field in JSON
  │           └── ⚠️ NOT passed to image API as separate param (embedded in prompt JSON)
  │
  ├── generateShots() → structuredLlm.invoke()
  │     └── ⚠️ I1: `as ShotsResponse` force cast, no runtime validation
  │
  └── analyzeImage() → llm.invoke() (shared instance, maxTokens:8192 for both)

[DirectorPage.ts]
  ├── cinematicGemSystemPrompt (~12500 chars)
  │     ├── <output_format>: 8 fields (MISALIGNED with 14-field schema)
  │     ├── <director_thinking_guide>: says "NOT output fields" (WRONG)
  │     └── action/light fields: "combine body_physics/color_grade INTO this field" (CONFLICTS with schema)
  │
  ├── generateComicPrompt() → 3-tier fallback
  │     ├── Priority 1: LangChain → buildFinalPrompt → return JSON
  │     ├── Priority 2: Gem AI → convertJsonShotsToPrompt
  │     └── Priority 3: Template → generateTemplatePrompt
  │
  ├── lastParsedPanels mapping
  │     └── ⚠️ C2: only maps 6 fields (kf, lens, spatial, action, light)
  │         └── missing: micro_expression, color_grade, atmosphere, body_physics, composition, emotion_target
  │
  └── generateComicPage() → api.generateImageWithReference(prompt, images, ratio, count, resolution)
        └── ⚠️ no negativePrompt parameter — negative is buried in JSON "n" field

[ServiceBridge.ts]
  └── getLangChainDirectorService(model?)
        ├── lazy singleton with cache key: apiKey|baseURL|model
        ├── ⚠️ M3: API key in plain text in cacheKey (log leak risk)
        └── returns null if no visionApiKey or no baseURL

[Build Pipeline]
  ├── src/renderer/index.html → source of truth for HTML
  ├── npm run build:vite → dist/renderer/index.html (build output)
  ├── Electron main.ts: mainWindow.loadFile('dist/renderer/index.html') ← ALWAYS
  │     └── ⚠️ DISCOVERY: dev mode does NOT use Vite dev server for HTML
  │         └── must run `npm run build:vite` after HTML changes
  └── .ts files → Vite HMR works (page reload on save)
```

---

## What Was Discovered This Session

### 1. System Prompt ↔ Schema Misalignment (ROOT CAUSE of low quality)

| Issue | Detail |
|-------|--------|
| `<output_format>` only lists 8 shot fields | Schema has 14 (6 required + 8 nullable) |
| `<director_thinking_guide>` says "NOT output fields" | But they ARE fields in the schema |
| `action` told to "combine body_physics" | Conflicts with separate `body_physics` field |
| `light` told to "combine color_grade" | Conflicts with separate `color_grade` field |
| **Result** | LLM never fills color_grade, body_physics, composition, emotion_target, seq, motion |

### 2. Negative Prompt Not Reaching Image API

- `buildFinalPrompt` puts negative in JSON `"n"` field
- `generateComicPage` passes entire JSON as `prompt` parameter
- `generateImageWithReference` has NO `negativePrompt` parameter
- CINEMATIC template's negative was also empty in user's local storage (override)

### 3. Code Review Findings (7.5/10)

**Critical:**
- C1: `buildFinalPrompt` scene spread redundancy
- C2: `lastParsedPanels` drops 6 nullable fields (affects Sora2 video prompts)

**Important:**
- I1: `as ShotsResponse` force cast without Zod runtime validation
- I2: System prompt ↔ schema misalignment (see above)
- I3: `structuredLlm` type loses generics
- I4: `analyzeImage` shares `maxTokens:8192` with `generateShots`

**Minor:**
- M1: `ShotsResponseSchema` alias is dead code
- M3: API key in cacheKey string (log leak risk)

### 4. Gemini Imagen Prefers Long Prompts

From context7 + Google docs:
- **Imagen 4.0 trained on long captions, performs better with longer descriptive prompts**
- Short prompts → low adherence, random output
- No explicit character/token limit documented
- JSON format still works well per user feedback

### 5. Electron Build Pipeline

| Action | Effect |
|--------|--------|
| Change `.ts` file | Vite HMR auto-reloads page ✅ |
| Change `src/renderer/index.html` | Must `npm run build:vite` then Ctrl+R ⚠️ |
| Change root `index.html` | Only used by `electron . --dev` static mode |
| `npm run dev` (electron-vite) | Builds main/preload, starts Vite server for TS, but HTML from dist/ |

### 6. Cloudflare Worker R2 Proxy Fix

- `ERR_HTTP2_PROTOCOL_ERROR 200` on image load
- Root cause: `handleGetImage` missing `Content-Length` header
- Fix: added `headers.set('Content-Length', object.size.toString())` + ETag
- File: `25/soraui_4.0/sora-ui-backend/cloudflare-worker/r2-proxy-worker.js`

---

## Token Budget Analysis

| Component | Tokens |
|-----------|--------|
| System prompt (~12500 chars) | ~3500 |
| Zod schema definition (14 fields) | ~1500 |
| User prompt + image metadata | ~800 |
| **Input total** | **~5800** |
| Output: scene + objs + anchor | ~390 |
| Output: 9 shots × 14 fields × ~20 tok | ~2520 |
| Output: JSON syntax overhead | ~500 |
| **Output total** | **~3410** |
| **maxTokens headroom** | **~4800 remaining** |

Conclusion: 14 fields × 9 shots fully filled is well within 8192 token budget.

---

## Uncommitted Changes

1. `src/renderer/index.html` — textarea `#understandPrompt`: rows 3→10, added `min-height: 250px`, `resize-none` → `resize-y`
2. `index.html` (root) — same change (for static mode compatibility)

---

## What to Do Next Session

### Priority 1: Fix System Prompt ↔ Schema Alignment (HIGH IMPACT)

Update `cinematicGemSystemPrompt` in `DirectorPage.ts:416-613`:

1. Expand `<output_format>` LAYER 3 from 8 to 14 fields
2. Change `<director_thinking_guide>` from "NOT output fields" to "fill these output fields"
3. Remove "combine body_physics into action" and "combine color_grade into light" instructions
4. Add fill rate goal: "aim to fill 6+ out of 8 nullable fields per shot"

**Expected result:** Dramatic improvement in nullable field fill rate.

### Priority 2: Fix Code Review Critical Issues

- **C1:** Simplify `buildFinalPrompt` scene spread (1 line fix)
- **C2:** Add missing fields to `lastParsedPanels` mapping (affects Sora2 prompts)

### Priority 3: Add Missing Tests

- 9-shot `buildFinalPrompt` output length and structure
- `generateShots` returning 0 shots
- `buildFinalPrompt` with empty shots array
- `shotsToNaturalLanguage` with 9 shots

### Priority 4: Negative Prompt Pipeline

Options:
- A) Extract `n` from JSON in `generateComicPage`, pass as separate API param
- B) Add `negativePrompt` parameter to `generateImageWithReference`
- C) Keep current behavior (negative embedded in prompt JSON) if Imagen reads it

### Priority 5: Cleanup

- Remove `@langchain/google` from package.json
- Remove `ShotsResponseSchema` alias (dead code)
- Commit textarea UI change

---

## Key File Quick Reference

```
src/renderer/src/services/LangChainDirectorService.ts  → Zod schemas + service
src/renderer/src/services/ServiceBridge.ts:993-1020     → getLangChainDirectorService()
src/renderer/src/pages/DirectorPage.ts:416-613          → cinematicGemSystemPrompt ← FIX THIS
src/renderer/src/pages/DirectorPage.ts:2149-2250        → generateComicPrompt (LangChain integration)
src/renderer/src/pages/DirectorPage.ts:2195-2198        → lastParsedPanels ← ADD FIELDS
src/renderer/src/pages/DirectorPage.ts:3034-3061        → generateComicPage ← NEGATIVE PROMPT
src/renderer/src/pages/DirectorPage.ts:2610-2660        → generateSora2VideoPrompt
tests/services/LangChainDirectorService.test.ts         → 19 tests (add 9-shot tests)
src/main/index.ts:306                                   → loadFile (always dist/)
electron.vite.config.ts                                 → renderer.root = src/renderer
```

---

## Brainstorming Decisions Made

| Question | Decision |
|----------|----------|
| JSON vs Natural Language for Imagen? | Keep JSON — user says "JSON结构效果好" |
| Compress prompt (delta encoding)? | Rejected — user worried about info loss |
| Which optimization first? | System Prompt alignment (highest impact, lowest risk) |
| Token budget concern? | Calculated: 3410/8192 tokens, plenty of headroom |
| Build pipeline for HTML? | Must `npm run build:vite` (Electron loads from dist/) |
