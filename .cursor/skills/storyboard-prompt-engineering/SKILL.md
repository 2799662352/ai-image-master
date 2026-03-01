---
name: storyboard-prompt-engineering
description: Use when optimizing prompts for AI video storyboard pipelines, implementing dodge layers for content filters, adding continuity locks for retry consistency, creating custom PromptSkill modules, or debugging prompt-related quality issues in multi-pass LangGraph pipelines. Triggers include "dodge layer", "filter bypass", "continuity lock", "prompt modular", "storyboard pipeline", "PromptSkill", "分镜提示词".
---

# Storyboard Prompt Engineering

Prompt engineering toolkit for 4-pass AI video storyboard pipelines (LangGraph). Covers modular rule composition, filter bypass, and retry consistency.

## When to Use

- Adding/modifying prompt rules for storyboard generation
- Implementing or adjusting dodge layers for video API content filters (Kling/Jimeng/Seedance)
- Fixing retry consistency issues (shots being rewritten unnecessarily)
- Creating custom PromptSkill modules for new genres/styles

## Architecture

```
Pipeline (LangGraph StateGraph)
├── Pass 1: Scene     ← core + style + dodge
├── Pass 2: Character ← core + physics + dodge
├── Pass 3: Shot      ← core + dialogue + physics + dodge + continuity*
├── Pass 4: Verify    ← core + dialogue + dodge
└── Retry (score<10)  ← prepareRetry → continuity activates
```

Post-process: `sanitizer.ts` applies regex replacement + dodge layer injection on final output.

## PromptSkill Quick Reference

```typescript
interface PromptSkill {
  id: string
  rules: string | ((state: PipelineStateSlice) => string)
  appliesTo: PassType[]  // 'scene' | 'character' | 'shot' | 'verify'
  priority: number       // lower = earlier in prompt
}
```

| id | type | appliesTo | priority | content |
|----|------|-----------|----------|---------|
| core | static | all | 0 | lighting, color, lens, snapshot, micro-expression, Z-axis, duration |
| dialogue | static | shot, verify | 10 | character name + dialogue verbatim extraction |
| physics | static | character, shot | 10 | physical desc, motion vectors, quantification |
| style | static | scene | 10 | color palette, light source, shadow depth |
| dodge | static | all | 20 | D1-D8 artistic obfuscation rules |
| continuity | dynamic | shot | 30 | retry reference frame lock (activates only when retryFeedback exists) |

### Priority Ranges

- **0-9**: Core constraints (always first)
- **10-19**: Domain/genre rules (style, physics, dialogue, custom genres)
- **20-29**: Safety/compliance (dodge)
- **30+**: Context-dependent (continuity, injected at runtime)

### Adding a Custom Skill

```typescript
import { BUILTIN_SKILLS, type PromptSkill } from './prompt-skills'

const horrorSkill: PromptSkill = {
  id: 'horror',
  rules: `Horror Rules:
- Shadow depth > 85%, single cold light source
- Sound: low-freq drone 30-50Hz + sudden silence gaps
- fg must have occluder (door frame/fingers/bars) for voyeuristic framing`,
  appliesTo: ['scene', 'shot'],
  priority: 15
}

const service = new StoryboardPipelineService(config, [...BUILTIN_SKILLS, horrorSkill])
```

## Dodge Layer (Dual Defense)

Two independent layers — both required:

**Layer 1 (Prompt-level):** D1-D8 rules in system prompt guide LLM to generate safe text. See `references/dodge-patterns.md`.

**Layer 2 (Post-process):** `sanitizer.ts` runs regex replacement + dodge modifier injection on final output.

CRITICAL CONSTRAINTS:
- Do NOT merge the two layers — they serve different purposes (generation guidance vs output cleanup)
- Do NOT add platform-specific rules without validated evidence of differing filter behavior
- `injectDodgeLayer` appends to `desc` with `|` separator — never insert mid-string

## Continuity Lock

Activates ONLY during retry (when `state.retryFeedback` is non-empty).

### Token Budget

`previousShots` stores `{ id, desc }` only — NOT full `ShotData`.

| Data | Est. tokens | Note |
|------|------------|------|
| 9 shots `{id, desc}` | ~800 | 5-part desc avg 80 tokens |
| Character anchors | ~200 | `[name] anchor` format |
| Lock template | ~100 | Fixed text |
| **Total** | **~1100** | ~13% of 8192 max |

**Do NOT expand PreviousShot to full ShotData** — token budget would jump to ~3000+ and crowd out generation context. The `desc` field contains the 5-part shot specification which is sufficient for continuity reference.

### How It Works

1. `prepareRetry` saves `shots.map(s => ({id, desc}))` as `previousShots`
2. `buildContinuityLock(state)` generates lock rules with character anchors + reference frames
3. Lock rule injected into shot pass system prompt at priority 30 (after all other rules)
4. Rule instructs LLM: unmentioned shots → preserve verbatim

See `references/continuity-lock.md` for implementation details.

## Common Mistakes

| Mistake | Why it's wrong | Correct approach |
|---------|---------------|-----------------|
| Expanding PreviousShot to full ShotData | Token budget ~3000+ crowds generation context | Keep `{id, desc}` only (~1100 tokens) |
| Adding `lockedShotIds` to PipelineState | Over-engineering; retryFeedback already identifies broken shots | Let continuity lock rule handle it |
| Making dodge skill dynamic (function) | Unnecessary complexity; static D1-D8 + sanitizer is sufficient | Keep dodge static, add new skills for special cases |
| Platform-specific replacement rules | No validated evidence of differing filter behavior | Use universal rules until proven insufficient |
| Putting code-level shot enforcement in generateShots | Corrupts LangGraph node purity; side effects in node functions | Keep nodes pure, enforcement belongs in post-process |
