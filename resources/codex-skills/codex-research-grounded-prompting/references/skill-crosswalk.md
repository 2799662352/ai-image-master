# Companion-skill crosswalk — method step → sibling recipe

This file is the full roster of the 19 sibling skills under `$HOME/.agents/skills/{director-*,storyboard-*}/` that pair with `codex-research-grounded-prompting`. The main SKILL.md is **the method**; these siblings are **the recipes** — battle-tested in-app prompt-craft rule sets ported verbatim from the storyboard pipeline and director mode of this application. The method tells you *what to do at each step*; the recipes give the exact *rules for how to write the words*. Use them in tandem; never use the method alone when a matching recipe exists.

## Crosswalk table

| Step you are at | Read & follow this sibling skill | What it gives you |
|---|---|---|
| Pillar 2 — pick N-field structure | `director-prompt-engineering` | 7-field prompt order (Subject+Action → Character ref → Scene → Shot+Camera → Lighting → Composition → Style+Mood) + negative-prompt hygiene |
| Pillar 2 — caption template | `director-structured-captioning` | VGoT structured caption fields |
| Pillar 4 — animation exaggeration | `director-anime-quality-boost` | impact frames, speed lines, smear-frame craft, "wrongness is the point" |
| Pillar 4 — body / motion physics | `storyboard-physics` | motion vectors (°/cm/m·s⁻¹), muscle tension, micro-expression in mm (not adjectives) |
| Pillar 5 — continuity verify (visual) | `director-visual-continuity` | per-panel checklist for visual element coherence across the scene |
| Pillar 5 — continuity verify (light) | `director-lighting-continuity` | key/fill/rim direction + color temperature + HDR coherence across panels |
| Pillar 5 — continuity verify (style) | `director-style-consistency` | style descriptor verbatim across every panel, no paraphrase drift |
| Lens 1 — intent extraction | `director-scene-analysis-depth` | physical / spatial / narrative depth dimensions for any scene |
| Lens 2 — character anchors | `director-character-consistency` + `director-anchor-extraction-quality` | anchor schema (face/hair/build/outfit/markers) + density and specificity rules |
| Lens 3 — style extraction | `storyboard-style` + `storyboard-visual` + `director-cinematic-composition` | palette ratio (≥7:3), key/fill/rim lighting, lens [mm] f/[stop], Z-axis fg/mg/bg, rule-of-thirds composition |
| Lens 4 — shot-rhythm extraction | `director-shot-sequence-patterns` + `director-narrative-flow` + `storyboard-structure` | shot type cycle (wide / medium / CU / POV) + per-shot emotional arc + single-action mid-action freeze discipline |
| Per-shot audio design (when domain warrants) | `storyboard-audio` | 3-layer audio: score (real composer ref + tension-value-to-bpm formula) / SFX (Hz + decay + spatial) / voice (Hz + breath% + 字/秒) |
| Dialogue / character-name handling | `storyboard-dialogue` | extract dialogue + character names *verbatim* from the screenplay, never fabricate |
| Sensitive content evasion | `storyboard-dodge` | artistic dodge rule set (contour / physics / shadow over explicit anatomical or graphic terms) |

## How to invoke them in a Codex chat

When the conversation reaches a step listed above:

1. Mention the sibling skill by name in your reasoning, e.g. *"Now applying storyboard-style for palette decomposition + director-lighting-continuity for cross-panel light coherence"*. This makes the lineage traceable for the user.
2. *Quote* the specific rule(s) you are following from that sibling's body — not the whole body, only the rules that apply to the current step.
3. If multiple siblings collide at the same step (e.g. Lens 3 has four candidates), pick the one whose rules best fit the user's actual brief, or compose two of them when they cover different sub-dimensions (palette vs. lighting vs. composition).

Codex CLI keeps every USER-scope SKILL.md in the session registry — you can reference any sibling freely; the user does **not** need to manually `/skill load` each one. They become a part of your reasoning toolkit the moment the main skill activates.

## Caveats

- The siblings were originally authored for two specific in-app pipelines (UnderstandPage's storyboard pipeline, GeneratePage's director mode). In the source files those pipelines hooked on an `appliesTo:` frontmatter field — stripped during the port to Codex registry because it is not part of Codex's frontmatter schema. The *rule bodies* themselves are domain-agnostic and apply whenever you are writing the matching kind of prompt content.
- **Don't double up unnecessarily.** When the user's task only needs a single sibling (e.g. "decompose this palette into hex + ratio"), invoke just that sibling — do not gratuitously layer all five pillars on top of a one-shot recipe call. The method is for high-stakes multi-dimensional briefs; the recipes alone are enough for narrow, well-defined sub-tasks.
