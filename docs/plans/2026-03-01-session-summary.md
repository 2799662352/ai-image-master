# Session Summary: PromptSkill System + Audio + Display + Progressive Disclosure

**Date:** 2026-03-01
**Scope:** Pipeline prompt engineering, UI display, audio design, progressive disclosure

---

## Commits (13 total)

| Hash | Content |
|------|---------|
| d2b12b4 | PromptSkill module: 7 builtin skills + buildRulesForPass + dodge + continuity |
| 35ed8d3 | Display enhancement: Tab UI + copy + full field export + Director structured injection |
| 8109ac6 | audio-score-design skill: 3-layer audio (score/SFX/voice) |
| 0f9d79a | Code review fix: nullish coalescing in aggregate |
| 5743d47 | UI: results below progress, not replacing |
| 32de0b5 | UI: pass results in separate card |
| f69efb1 | UI: Director mode card style unification |
| e4ba725 | UI: content area height 800px |
| 124bfcd | Refactor: AUDIO_RULES teach method not examples |
| 2145a63 | Refactor: CORE_RULES teach method (shadow range, micro-expression) |
| ed8929c | Skill tracing: console log + [Skill:id] tags in prompt |
| f97fc5f | (superseded by 124bfcd) |
| 3da1219 | Progressive Disclosure: condition function + dodge signal filtering |

## Architecture

```
Pipeline (LangGraph StateGraph - topology unchanged)
  Pass 1: Scene     ← core + style + dodge*
  Pass 2: Character ← core + physics + dodge*
  Pass 3: Shot      ← core + dialogue + physics + audio + dodge* + continuity**
  Pass 4: Verify    ← core + dialogue + dodge*
  Retry (score<10)  ← prepareRetry saves previousShots → continuity activates

* dodge: Progressive Disclosure — only injected when scene.d contains intimate/violence signals
** continuity: only outputs content when retryFeedback is non-empty

Post-process: sanitizer.ts covers desc/act/motive/audio fields
```

## 7 PromptSkills

| id | type | appliesTo | priority | condition |
|----|------|-----------|----------|-----------|
| core | static | all | 0 | none |
| dialogue | static | shot, verify | 10 | none |
| physics | static | character, shot | 10 | none |
| style | static | scene | 10 | none |
| audio | static | shot | 12 | none |
| dodge | static | all | 20 | scene signals (intimate/violence) |
| continuity | dynamic | shot | 30 | retryFeedback non-empty |

## Progressive Disclosure (3-level)

1. **Level 1**: `appliesTo.includes(pass)` — filter by Pass type
2. **Level 2**: `condition(state)` — filter by scene context (dodge only when signals present)
3. **Level 3**: `rules(state)` — dynamic content generation (continuity lock)

## Key Files

| File | Role |
|------|------|
| prompt-skills.ts | 7 skills + buildRulesForPass (3-level filter) + condition |
| schemas.ts | Zod schemas: scene/character/shot/report + PreviousShot + audio field |
| StoryboardPipelineService.ts | 4 LangGraph nodes + retry + sceneDescription passing |
| aggregate.ts | ShotData → StoryboardResponse (nullish coalescing) |
| sanitizer.ts | DODGE_LAYERS + RISKY_REPLACEMENTS + 4-field sanitize |
| StoryboardToDirectorAdapter.ts | formatStoryboardText + structuredData export |
| UnderstandPage.ts | 3 cards (progress/process/result) + Tab + copy |
| DirectorPage.ts | cache StoryboardResponse + 3-path LLM injection |

## AI Skills (.cursor/skills/)

| Skill | Version | Purpose |
|-------|---------|---------|
| storyboard-prompt-engineering | v1.1 | Dodge/continuity/modular rules for developers |
| audio-score-design | v1.0 | 9 tension dimensions + 45+ works + instrument palettes |

## Design Principles

1. Teach method, not answers — LLM selects from its own knowledge using criteria we provide
2. Safety rules hardcoded — dodge D1-D8 + sanitizer replacements are non-negotiable
3. Progressive disclosure — condition filters skills by scene content
4. Dual-layer defense — prompt layer (D1-D8) + post-process layer (sanitizer)
5. Token budget — previousShots stores {id, desc} only (~1100 tokens, ~13% of 8192 max)
6. Master-level direction — audio references prioritize award-nominated/master composers

## Grok Bible Integration

| Grok Module | Our Implementation |
|------------|-------------------|
| ULTIMATE_DODGE_LAYER | D1-D8 prompt rules + sanitizer.ts |
| CONTINUITY_LOCK | buildContinuityLock() dynamic function |
| Modular blocks | PromptSkill system with buildRulesForPass |
| AUDIO_BLOCK | audio PromptSkill (3-layer: score/SFX/voice) |
| Risky replacements | RISKY_REPLACEMENTS array (30+ rules, zh+en) |

## Test Configuration

```
API Key: (REDACTED - use env var VISION_API_KEY)
Base URL: https://api.apiyi.com
Models: gemini-3-flash-preview, gemini-3-pro-preview
Test script: scripts/run-pipeline-test.ts
NPM script: npm run pipeline:test
```

## Next Steps

- Run pipeline test to verify Progressive Disclosure F12 logs
- Verify dodge skill correctly skips for non-sensitive scenes
- Test audio field output quality with new method-based rules
- Consider more condition functions for other skills if needed
