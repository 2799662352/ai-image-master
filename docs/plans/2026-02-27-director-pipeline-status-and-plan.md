# Director Pipeline Upgrade - Status Audit & Next Steps Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the Director pipeline upgrade from flat shot descriptions to a 3-layer cinematic scene system (scene + objects + enhanced shots) with LangChain.js structured output.

**Architecture:** LangChainDirectorService wraps ChatOpenAI with Zod SceneResponseSchema. DirectorPage delegates to service for generation, bypasses legacy pipeline for prompt building. 3-tier fallback: LangChain → legacy Gem AI → template.

**Tech Stack:** TypeScript, LangChain.js (@langchain/openai, @langchain/core), Zod v4, Electron-Vite, Vitest

---

## Current Status (10 commits completed)

### What's Done

| # | Commit | What |
|---|--------|------|
| 1 | `eccad2c` | LangChain.js ChatOpenAI + withStructuredOutput integration |
| 2 | `ac92aaa` | 6 cinematic Zod fields (micro_expression, color_grade, etc.) + 10 articles extracted |
| 3 | `4d77bad` | cinematicGemSystemPrompt upgraded with 7 professional dimensions |
| 4 | `c9ed71d` | Code review fixes: index alignment, error distinction, baseURL safety |
| 5 | `df20dc8` | z.optional() → z.nullable() fix for OpenAI 400 error |
| 6 | `1c52078` | Test data alignment + undefined regression test |
| 7 | `fc20784` | LangChain path bypasses legacy buildJsonPrompt, uses service.buildFinalPrompt |
| 8 | `776ad2b` | Dead code removal, empty shots guard, Sora2 complete 6 dimensions |
| 9 | `9c56c0f` | 3-layer SceneResponseSchema (scene + objs + enhanced shots) |

### Test Status

- **Our tests:** 20/20 pass (LangChainDirectorService.test.ts)
- **Pre-existing failures:** 19 tests in 4 other files (TabManager, HistoryPage, I18n, DirectorPage i18n) — NOT caused by our changes
- **Total:** 1299 passed / 19 failed (all pre-existing)

### Runtime Status (last tested)

- Build: exit 0
- LangChain path: `LangChain success: 2 shots` (works with 2closeup layout)
- BUT: not yet tested with the new 3-layer SceneResponseSchema in production (only build-verified)

---

## Known Issues (Must Fix)

### Issue 1: System prompt doesn't teach the 3-layer structure

**Problem:** `cinematicGemSystemPrompt` still instructs AI to output the old flat format. The Zod schema demands `scene`, `objs`, `shots[].seq`, `shots[].alignment`, `shots[].motion` but the system prompt has no mention of these.

**Impact:** LLM will likely fail or produce poor quality for new fields since it has no guidance on what `objs`, `scene.bgm`, `alignment.fine` mean in context.

**Fix:** Update system prompt `<output_format>` section to describe the 3-layer structure and give examples.

### Issue 2: DirectorPage.generateComicPrompt still uses old ShotsResponse type assumptions

**Problem:** Lines 2154-2161 map `shotsResponse.shots` to `lastParsedPanels` using only old fields. The new fields (`seq`, `alignment`, `motion`) are not mapped. `lastParsedPanels` uses `JsonPromptPanel` interface which doesn't have the new fields.

**Impact:** If any downstream code uses `lastParsedPanels`, it won't see the new 3 fields. However, `lastGeneratedShots[].prompt_text` contains `JSON.stringify(shot)` with ALL fields, so external consumers parsing that JSON will get everything.

### Issue 3: Legacy Gem AI fallback path incompatible with new schema

**Problem:** The legacy `generateJsonShots` → `parseJsonShotsResponse` path returns `{ shot_number, prompt_text }[]`. This goes through `convertJsonShotsToPrompt` → `buildJsonPrompt` which doesn't know about `scene`, `objs`, or the 3 new shot fields. It can NEVER produce the 3-layer output.

**Impact:** When LangChain fails and falls back to legacy, the output is dramatically less rich. This is expected (it's a fallback), but the quality gap is now very large.

**Fix (optional):** Accept this as designed. The legacy path is a safety net, not the primary path.

---

## Next Steps Plan

### Task 1: Update system prompt for 3-layer structure

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` (cinematicGemSystemPrompt, ~L416-598)

**Step 1:** Add a new `<scene_structure>` section to the system prompt that teaches the AI about the 3-layer output:
- Scene layer: narrative arc, structured title, environment, BGM 4-layer, core tension
- Objects layer: persistent entities with physics types, cross-shot anchors, psychology externalization
- Shot layer: existing fields + seq encoding, 3-grain alignment, per-part motion intensity

**Step 2:** Update `<output_format>` to reference the 3-layer structure

**Step 3:** Build to verify: `npx electron-vite build`

**Step 4:** Commit

---

### Task 2: Runtime test with 3-layer schema

**Files:** None (manual test)

**Step 1:** Start dev server: `npm run dev`
**Step 2:** Open director mode, upload reference image, click generate
**Step 3:** Check console for:
- `[DirectorPage] LangChain success: N shots`
- `[DirectorPage] LangChain final prompt length: XXXX chars`
- Verify no 400 errors
**Step 4:** Inspect the generated prompt JSON in the asset modal:
- Has `scene` with `d`, `cap`, `env`, `bgm`, `tension`
- Has `objs` array with physics types
- Each shot has `seq`, `align`, `m` (motion) fields

---

### Task 3: Fix any runtime errors from Task 2

**Files:** Depends on errors found

This is a contingency task. Common issues:
- Schema too large → 400 from proxy (token limit)
- Missing/incorrect field descriptions → poor AI output quality
- `.describe()` text too verbose → trim to essentials

---

### Task 4: Final code review

**Files:** All modified files

**Step 1:** Run `code-reviewer` subagent on final state
**Step 2:** Fix any Critical/Important findings
**Step 3:** Final commit + push

---

### Task 5: Verification before completion

**Step 1:** `npx electron-vite build` → exit 0
**Step 2:** `npx vitest run tests/services/LangChainDirectorService.test.ts` → 20/20 pass
**Step 3:** ReadLints on all modified files → 0 new errors
**Step 4:** Runtime test → LangChain path produces 3-layer output
**Step 5:** Commit + push

---

## Files Modified in This Project

| File | Lines | Role |
|------|-------|------|
| `src/renderer/src/services/LangChainDirectorService.ts` | 270 | NEW: LangChain service + Zod schemas |
| `src/renderer/src/services/ServiceBridge.ts` | 1118 | MODIFIED: lazy getter + API key invalidation |
| `src/renderer/src/pages/DirectorPage.ts` | 4726 | MODIFIED: LangChain integration + prompt upgrade |
| `tests/services/LangChainDirectorService.test.ts` | 404 | NEW: 20 tests |
| `docs/plans/*.md` | - | Design docs + plans |
| `docs/prompt-research/*.txt` | 5904 lines | 10 extracted articles |
