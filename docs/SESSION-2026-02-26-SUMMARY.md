# Session Summary: Director Pipeline LangChain Upgrade

**Date:** 2026-02-26 ~ 2026-02-27
**Commits:** 15 (65b6fb5 → c287a1e)
**Files changed:** 4 core + 10 research + 6 plan docs

---

## What Was Built

Upgraded the Director Mode's cinematic shot generation pipeline from hand-rolled regex JSON parsing to LangChain.js structured output with a 3-layer schema.

### Before → After

```
BEFORE:
  Gem AI → natural language prompt_text → regex extract JSON → JSON.parse → manual cast → buildJsonPrompt
  
AFTER:
  ChatOpenAI.withStructuredOutput(Zod) → SceneResponseSchema → validated 3-layer object → buildFinalPrompt
  Fallback: legacy Gem AI → template (3-tier)
```

---

## Architecture

### Files

| File | Lines | Role |
|------|-------|------|
| `src/renderer/src/services/LangChainDirectorService.ts` | 228 | LangChain service + Zod schemas |
| `src/renderer/src/services/ServiceBridge.ts` | 1118 | Lazy getter with API key/model/baseURL invalidation |
| `src/renderer/src/pages/DirectorPage.ts` | 4759 | UI + LangChain integration + system prompt |
| `tests/services/LangChainDirectorService.test.ts` | 220 | 19 tests |

### 3-Layer Schema (SceneResponseSchema)

```
SceneResponse
  ├── scene: { d(arc), cap(title), env, bgm{base,env,action,melody}, tension, shot_flow }
  ├── objs: [{ n, f(features+physics+anchors), s(spatial), psych(nullable) }]
  ├── character_anchor: string
  ├── shots: [{
  │     kf, lens, spatial{fg,mg,bg}, action, light, label,        // 6 required
  │     micro_expression, color_grade, atmosphere, body_physics,   // 8 nullable
  │     composition, emotion_target, seq, motion
  │   }]
  └── notes: nullable string
```

### Key Design Decisions

1. **z.nullable() not z.optional()** — OpenAI structured output requires all properties in `required` array
2. **z.string() not z.record()** — OpenAI rejects `propertyNames` keyword
3. **Short .describe() (≤15 words)** — Minimize schema token cost
4. **maxTokens: 8192** — Explicit setting for large structured output
5. **User visionModel passed to ChatOpenAI** — Cache key includes model for auto-rebuild on switch
6. **3-tier fallback** — LangChain → legacy Gem AI → template

### System Prompt Structure (~12500 chars)

```
<role> → <input> → <non-negotiable rules> → <goal> → <workflow>
→ <output_format>        (3-layer structure description)
→ <director_thinking_guide> (internal guidance, not output fields)
→ <shot_design_vocabulary>
→ <shot_emotion_matrix>
→ <camera_physics>
→ <spatial_depth>         (includes atmosphere/medium rules)
→ <composition_rules>
→ <lighting_rules>        (includes color grading rules)
→ <micro_performance_rules> (10 emotions, Start→Transition→End)
→ <action_physics_rules>  (manner words, environment forces)
```

---

## Bugs Fixed & Lessons Learned

| Bug | Root Cause | Fix | Lesson |
|-----|-----------|-----|--------|
| 400 Missing 'atmosphere' | `z.optional()` removes from `required` | Use `z.nullable()` | OpenAI strict: ALL props must be in required |
| 400 propertyNames not permitted | `z.record(string,string)` | Use `z.string()` | OpenAI rejects most JSON Schema keywords |
| generativelanguage.googleapis.com 400 | `ChatGoogle` calls Google directly | Switch to `ChatOpenAI` + proxy baseURL | Match the proxy architecture |
| Only 1 shot generated | Schema too complex (~3500 token definition) | Slim schema + set maxTokens:8192 | Token budget = schema + prompt + output |
| 0 micro_expressions filled | output_format described removed fields | Sync prompt with schema | Prompt-schema alignment is critical |
| LangChain used gpt-4o not gpt-5.2 | Model not passed from DirectorPage | Pass visionModel + include in cache key | Service must use caller's model |
| New fields lost in final prompt | LangChain → lastParsedPanels → buildJsonPrompt | Bypass legacy, use service.buildFinalPrompt | Don't convert rich data through narrow pipes |

---

## Dependencies Added

```json
"@langchain/core": "^1.1.28",
"@langchain/google": "^0.1.2",  // installed but no longer used (kept for potential future use)
"@langchain/openai": "^0.5.14",
"zod": "^4.3.6"
```

---

## Test Status

- **Our tests:** 19/19 pass
- **Pre-existing failures:** 19 tests in 4 other files (TabManager, HistoryPage, I18n) — NOT caused by our changes
- **Total project:** 1299 passed / 19 failed (all pre-existing)

---

## What to Do Next Session

### Priority 1: Runtime Test with gpt-5.2 + 9grid

The latest commit `c287a1e` restored the rich schema and passes user's visionModel. Need to:
1. Restart dev server (`npm run dev`)
2. Test with 9grid layout
3. Verify console shows: `LangChain success: 9 shots` + high fill rate for nullable fields
4. If still only 1-2 shots: consider `maxTokens` increase or model-specific schema variants

### Priority 2: Remove @langchain/google

`@langchain/google` was replaced by `@langchain/openai` but is still in package.json. Run `npm uninstall @langchain/google` to clean up.

### Priority 3: Add 9-shot Integration Tests

The code reviewer noted missing multi-shot tests. Add tests for `shotsToNaturalLanguage` and `buildFinalPrompt` with 9 shots.

### Priority 4: Prompt Quality Tuning

If gpt-5.2 fills micro_expression/color_grade/atmosphere at high rates, the system is working. If not, the `<director_thinking_guide>` may need to be converted into stronger `<output_format>` instructions.

---

## OpenAI Structured Output Compatibility Cheat Sheet

| Zod Pattern | JSON Schema Output | OpenAI Compatible? |
|-------------|-------------------|-------------------|
| `z.string()` | `{type:"string"}` | YES |
| `z.nullable(z.string())` | `{anyOf:[{type:"string"},{type:"null"}]}` | YES |
| `z.string().optional()` | Removed from `required` | NO — use nullable |
| `z.record(string,string)` | `{propertyNames:...}` | NO — use z.string() |
| `z.object({...})` | `{type:"object",properties:{...}}` | YES |
| `z.array(z.object({...}))` | `{type:"array",items:{...}}` | YES |
| Nested `.describe()` | Included in schema | YES — keep short |

---

## Key File Locations

```
src/renderer/src/services/LangChainDirectorService.ts  → Zod schemas + ChatOpenAI service
src/renderer/src/services/ServiceBridge.ts:993-1020     → getLangChainDirectorService(model?)
src/renderer/src/pages/DirectorPage.ts:416-600          → cinematicGemSystemPrompt
src/renderer/src/pages/DirectorPage.ts:2169-2220        → LangChain integration in generateComicPrompt
src/renderer/src/pages/DirectorPage.ts:2610-2660        → generateSora2VideoPrompt
tests/services/LangChainDirectorService.test.ts         → 19 tests
docs/prompt-research/*.txt                              → 10 extracted prompt engineering articles
docs/plans/*.md                                         → Design docs and implementation plans
```
