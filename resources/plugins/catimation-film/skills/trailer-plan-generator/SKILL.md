---
name: trailer-plan-generator
description: Generate five professional 90-second trailer plan options from a provided script or story treatment. Use when the user asks in Chinese or English to turn a screenplay, episode outline, short story, animation plot, game story, or promotional script into trailer方案, 90s预告片结构, planA/planB/planC/planD/planF, Hitchcock suspense, Kuleshov effect, MacGuffin, delayed gratification, omitted causality, or Chekhov's gun style trailer planning.
---

# Trailer Plan Generator

## Core workflow

1. Read the user's script, synopsis, or scene list. If no script is provided, ask for it before generating plans.
2. Extract the trailer spine:
   - protagonist and visible desire
   - central threat or contradiction
   - emotional wound or pressure
   - key visual motifs, props, places, and enemies
   - ending state that must be teased but not fully resolved
3. Generate exactly five options labeled `planA`, `planB`, `planC`, `planD`, and `planF`, unless the user asks for fewer or different labels.
4. Make each plan usable for a 90-second trailer. Prefer timecoded beats totaling 90 seconds.
5. Avoid solving the whole plot. A trailer plan should escalate curiosity, not summarize the complete story.

## Required output shape

Use this structure for each plan:

```markdown
### planA - 希区柯克式悬念
**核心钩子：** ...
**90s结构：**
- 0-10s: ...
- 10-25s: ...
- 25-45s: ...
- 45-65s: ...
- 65-82s: ...
- 82-90s: ...
**关键画面：** ...
**声音/字幕策略：** ...
**最后一问：** ...
```

After the five plans, add:

```markdown
**推荐优先级：**
1. ...
2. ...

**需要从剧本确认的点：**
- ...
```

## Plan patterns

### planA - Hitchcock suspense

Give the audience a dangerous condition before the protagonist fully understands it. Build the plan around:

- condition: a visible deadline, trap, secret, rule, or irreversible cost
- question: what will happen when the protagonist discovers it
- choice: the protagonist must choose between two bad outcomes

Do not make it a simple twist reveal. The audience should participate in the suspense by knowing enough to fear the next scene.

### planB - Kuleshov effect

Use montage contrast to create meaning. Build each major beat as:

1. violent or extreme conflict image
2. cut to protagonist reaction
3. let the viewer infer guilt, fear, anger, desire, or complicity

Keep dialogue sparse. Let juxtaposed images do the storytelling.

### planC - MacGuffin plus delayed gratification

Choose one object, person, file, location, signal, password, relic, memory, or mission as the MacGuffin. Everyone wants it, but the trailer should delay what it truly means.

Include:

- all major factions or contradictions chasing the same trigger
- escalating clues that partially contradict each other
- repeated near-reveals that cut away before full explanation
- a final tease that the MacGuffin is not the real answer

### planD - omitted causality

Show conflict, omit the direct consequence, then show aftermath or reaction.

Use this rhythm:

- threat begins
- cut before impact
- aftermath appears
- protagonist reacts
- viewer reconstructs the missing causal link

This plan should feel sharp, fragmented, and mysterious. Avoid exposition that explains what was omitted.

### planF - Chekhov's gun S-curve payoff

Plant a small but memorable detail early, then build an S-shaped emotional curve:

- early pressure: humiliation, suppression, betrayal, failure, isolation, or loss
- middle compression: the protagonist repeatedly refuses, fails, or cannot act
- late ignition: the planted detail returns as the release mechanism
- final burst: the protagonist acts, but the trailer cuts before the full result

The planted detail must be visible enough for the audience to remember and specific enough to pay off.

## Style rules

- Write in Chinese by default when the user writes in Chinese.
- Use film-trailer language: concrete shots, edits, sound cues, title cards, silence, hard cuts, reaction shots, match cuts, and cliffhangers.
- Keep every beat shootable or animatable. Avoid vague phrases such as "命运展开" unless paired with a visible image.
- Make each plan meaningfully different in structure, not just wording.
- Preserve the user's names, worldbuilding terms, and tone.
- If the source script is long, summarize the extracted trailer spine before the five plans.

## Reference

For terminology calibration, read `references/film-terms.md` when the user asks for professional terminology, definitions, or rationale.
