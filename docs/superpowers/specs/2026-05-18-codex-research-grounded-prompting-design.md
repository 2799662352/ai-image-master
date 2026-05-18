# codex-research-grounded-prompting — Design Spec

**Status**: Draft v2 — awaiting user review
**Date**: 2026-05-18
**Author**: agent (brainstorming with user)

## Problem statement

The user has accumulated a deep prompt-engineering methodology for video and image generation models (Sora, MJ, Kling, Veo, SD), fusing three things: academic research conclusions, creator-craft references, and a directing philosophy. The user wants this methodology surfaced inside this app's Codex Agent as a single broad skill that any Codex conversation can invoke on demand.

Already decided in brainstorming:

- One skill, broad ("宽泛"), not many narrow ones.
- User scope (`$HOME/.agents/skills/`), so users can edit / extend / opt out.
- Body in Anthropic / Codex SKILL.md house style — semantic `<tag>` sections + tables + prose. No JSON schemas posing as rules.
- Trigger on prompt-engineering tasks generally, not narrowly bound to one model.
- Source folder ships inside this app's installer; first launch mirrors it into user scope.

Explicitly rejected by the user in v1 review:

- Vendoring any external prompt-library files into this repo. The skill must be written fresh, in this skill's own words, capturing the methodology without copying source rule files.
- Losing the earlier "5 抽取主题" work (intent / character-anchor / style / shot-rhythm / handoff). Those must survive inside this single skill as a named section.

## Non-goals

- Replicating any external rule library file-for-file.
- Building a runtime that auto-applies the methodology (Codex skills are on-demand only).
- Replacing the existing `<repo>/skills/director-*` and `storyboard-*` files used by the image pipeline.
- Coupling skill content to this app's UI (Director / Batch / image-understand pages).

## Scope

In-scope:

- One `SKILL.md` in Codex house style.
- A `references/` subdirectory with concept summaries authored fresh as part of this skill's package — methodology rationale + paper bibliography. No verbatim or near-verbatim copying of external rule files.
- A startup mirror step that copies the bundled skill folder into `$HOME/.agents/skills/` non-destructively.
- Packaging configuration (`electron-builder.yml`) so the skill folder rides along with installer resources.
- Unit test covering the mirror step and skill discovery.

Out-of-scope:

- UI changes in the Codex Skill panel.
- Telemetry for skill usage.
- Pulling content from any path outside this repo (e.g., `Q:\` drives or other Cursor projects).

## Skill content design

### Naming and trigger

- **Folder name** (and frontmatter `name:`): `codex-research-grounded-prompting`
- **Description / trigger** (specific enough to fire on prompt-engineering tasks, not flood every conversation):

> Use when writing high-stakes prompts for video or image generation models (Sora, Midjourney, Kling, Veo, Stable Diffusion), when designing prompt-engineering systems, or when the user wants outputs grounded in both academic research and creator craft. Triggers on phrases such as "Sora prompt", "video generation prompt", "视频提示词", "动画 prompt", "怎么写更好的提示词", "prompt 方法论", or any task that demands rigor — source verification, multi-perspective structure, weight tuning, priority hierarchy, persuasion-over-accuracy, granularity alignment, or verification checklists.

### House style — must match Codex SKILL.md conventions

Look at `<repo>/.agents/skills/deep-agents-core/SKILL.md` as the reference:

- Frontmatter is small — `name` + `description` only. No private fields.
- Body uses semantic XML-style tags as section anchors so models can address sections by name. Examples: `<overview>`, `<when-to-use>`, `<the-five-pillars>`, `<five-extraction-lenses>`, `<walkthrough>`, `<verification>`, `<references>`.
- Inside each section, tables and bullet lists are encouraged for selection / matching tasks. Prose is used for narrative explanation.
- Code fences appear only when showing literal text the user or model would type / produce (a prompt snippet, a YAML config). They are never used as a JSON schema declaration disguised as rules.

### Body outline

1. `<overview>` — 4-6 sentences. State the core belief: research + craft + philosophy as three tracks. Make clear this skill is methodology, not a Sora-specific recipe.

2. `<when-to-use>` — A small table mapping common user wordings ("Sora prompt for X", "怎么写更好的提示词", "design a prompt pipeline", "review my prompt") to whether the skill applies, plus a short do-not-use list (e.g., do not use for SQL, regex, infra ops).

3. `<the-five-pillars>` — The core. Five methodological principles distilled from the user's accumulated practice. Each pillar is one short paragraph + one concrete miniature example. The five:

   1. **Grounded in evidence** — fuses research-citation rigor with primary-source verification. Don't write a director / style / actor reference from memory. If the runtime has a fetch / web tool, the model is expected to verify and cite. If it does not, the model is expected to flag the gap and ask the user for a source rather than confabulate. State the source — or the gap — in the output.
   2. **Structured by N dimensions** — single-field descriptions miss things; N-field formats force coverage. Show three exemplar templates abstractly: 7-field director description, 4-perspective scene description, 3-pillar quality contract. The reader should be able to instantiate their own N-field format for any domain.
   3. **Weighted by intent** — default weight ratios rarely fit a specific task. Scan user wording for trigger keywords and switch mode. Give an abstract mode table (drama-first / quality-first / layout-first / character-first / experimental / explicit-percentages). Declare priority when constraints collide.
   4. **Persuasion over accuracy** — for creative generation, intent beats fidelity. Violating physics is a feature in animation; violating composition is a feature in surrealism. State the inverse: not universal — does not apply to scientific or technical illustration.
   5. **Verified before shipping** — produce-then-check at three granularities (coarse / medium / fine) plus a 5-7 binary checklist. Show one concrete checklist instance; explain how to design one for any domain.

4. `<five-extraction-lenses>` — Five common Codex-conversation scenarios where users want help extracting structure from messy input. These are the *what* (concrete scenarios) to the pillars' *how* (abstract methodology); same framework, two viewing angles. Lens 5 (hand-off) naturally consumes the output of pillar 2 (structured) and pillar 5 (verified), so a worked example often touches both views. For each lens: a one-line trigger sentence and a 3-5 bullet recipe.

   1. **Intent extraction** — vague user request → operable variables (theme / mood / style class / target platform / cast count / scene count / use case).
   2. **Character anchor extraction** — recurring character → compact visual contract reused word-for-word across panels.
   3. **Style extraction** — reference image or vague adjective → controllable parameters (palette ratio, key light type/angle, shadow depth, medium, brushstroke).
   4. **Shot-rhythm extraction** — multi-frame sequence → shot-type cycle, camera-movement variety, viewpoint shifts, continuity locks (light, motion vector, gaze).
   5. **Hand-off extraction** — finished extraction package → consumer-ready format (verbatim anchor reuse, dedup rules, per-platform quirks: MJ ignores quality tags, SD eats negatives, DALL-E rejects style stacks).

5. `<walkthrough>` — One end-to-end miniature. User asks: "write me a Sora prompt for a 10-second fight scene." Model walks through: fetch authoritative references (pillar 1) → detect mode from wording (pillar 3) → fill an N-field director description (pillar 2) → cover the 4 perspectives (pillar 2 again) → declare priority (pillar 3 again) → run a 6-item verification checklist (pillar 5). ~40-60 lines. Output the resulting prompt as a fenced code block so the reader sees the shape.

6. `<verification>` — Short. The model's self-check when it finishes producing a prompt under this skill. 5 binary questions: did I cite a source? did I cover all N fields of the structure I chose? did I declare priorities for conflicting constraints? did I respect persuasion-over-accuracy where applicable? did I run a coarse/medium/fine pass?

7. `<references>` — Pointer to the package's `references/` folder: methodology rationale + paper bibliography. Make explicit that those files exist alongside this SKILL.md inside `$HOME/.agents/skills/codex-research-grounded-prompting/`.

Target SKILL.md length: 180-260 lines.

### references/ folder content (all authored fresh)

- `references/methodology-rationale.md` — Why these five pillars and five lenses exist. Each pillar's one-page rationale: the failure mode it prevents, the research line that motivated it (named at the level of "AniSora-style consistency research", "MiraData-style motion-strength metrics", "CRAVE-style multi-granularity alignment"), the craft tradition that motivated it (named at the level of "Japanese sakuga animator-credit tradition", "monteur-driven director-style attribution"), and one anti-example showing what happens without it. ~250-400 lines. Written in this skill author's voice, not copied from outside files.

- `references/papers.md` — A short reading list of *public* research papers (arXiv / HuggingFace papers pages only) that influenced these pillars. Each entry: title, year, public link, 2-3 sentence summary of why it matters for prompt engineering. Covers AniSora (animation video gen), CRAVE (content-rich AIGC video QA), MiraData (long-duration video dataset), Open-Sora 2.0 (commercial-level training), Video-Bench (human-aligned eval). ~80-150 lines. Only public bibliographic metadata + public links — no private notes, no transcripts of external rule files.

Neither file imports, transcribes, or near-paraphrases any external `.cursor/rules` content. Both are written as standalone documents in this skill's own register.

## Mechanism design

### File layout in source repo

```
resources/codex-skills/
  codex-research-grounded-prompting/
    SKILL.md
    references/
      methodology-rationale.md
      papers.md
```

### Packaging

In `electron-builder.yml`, **append** to the existing `extraResources` list (do not replace any existing entries) one new mapping that copies `resources/codex-skills` to the installer's top-level `codex-skills` directory:

```yaml
extraResources:
  # ... existing entries preserved ...
  - from: resources/codex-skills
    to: codex-skills
    filter: ["**/*"]
```

In production (`app.isPackaged === true`) the runtime source path becomes `path.join(process.resourcesPath, 'codex-skills')`. In development it stays at `path.resolve(__dirname, '../../resources/codex-skills')` — mirroring how `builtinSkillsDir` is resolved in `src/main/index.ts`.

### Mirror on startup

Reuse `migrateLegacyUserSkills` from `src/main/agent/legacySkillsMigration.ts`. That helper is already a non-overwriting one-shot directory mirror. Add a second invocation alongside the existing legacy-user-skills migration:

```ts
// Existing call (pre-Codex skills under userData → $HOME/.agents/skills)
migrateLegacyUserSkills({ legacyRoot: userSkillsDir, officialRoot: officialUserSkillsDir })

// New call (bundled codex-skills source → $HOME/.agents/skills)
migrateLegacyUserSkills({ legacyRoot: codexSkillsSourceDir, officialRoot: officialUserSkillsDir })
```

Idempotency: guaranteed by the helper. First launch copies, subsequent launches skip. If the user deletes the on-disk copy, the next launch restores it. If the user edits the on-disk copy, the edit survives forever — the trade-off is that newer app versions shipping an updated skill body will not propagate automatically.

### Discovery

No changes needed in `src/main/agent/codexConfigDiscovery.ts`. `discoverCodexSkills` already walks `$HOME/.agents/skills/`. The new skill appears automatically as user scope after the mirror runs.

## Architecture and components

Four small surface areas, all isolated:

1. **Content** — `resources/codex-skills/codex-research-grounded-prompting/` (new directory with three markdown files). Pure content, no code.
2. **Packaging** — one new `extraResources` entry in `electron-builder.yml`. No code.
3. **Runtime mirror** — one extra `migrateLegacyUserSkills` call site in `src/main/index.ts`. ~10 lines including the dev-vs-packaged path resolution.
4. **Test** — one new test file or extension confirming the mirror runs and idempotency holds. ~30-50 lines.

## Data flow

```
build time:
  resources/codex-skills/  ─►  installer resources/codex-skills/

runtime startup:
  resources/codex-skills/  ─[copyDirRecursive, non-overwriting]─►  $HOME/.agents/skills/

skill load (IPC):
  discoverCodexSkills($HOME/.agents/skills/) ─►  Codex Skill panel UI
  Codex CLI session start ─►  reads $HOME/.agents/skills/ ─►  skill available for invoke
```

## Error handling

- If `resources/codex-skills/` is missing in dev (e.g., contributor checked out a branch where it doesn't exist yet), the helper returns an empty report and logs one info line. No crash.
- If `$HOME/.agents/skills/` cannot be created (permissions issue), the helper throws; the existing top-level startup error reporter logs it. The app continues; user just doesn't get the bundled skill.
- If the user has a same-named folder in `$HOME/.agents/skills/`, the helper skips — their version always wins.

## Testing strategy

Two narrow concerns:

1. **Mirror correctness** — given a temp dir with a fake `codex-research-grounded-prompting/SKILL.md`, run `migrateLegacyUserSkills`, assert the file lands in the target and idempotency holds on a second call.
2. **Discovery** — given a temp `$HOME` with the mirrored skill present, `discoverCodexSkills` returns it under `user` scope.

Both are unit tests, Vitest, same shape as the existing `legacySkillsMigration.test.ts`. No Electron runtime, no IPC mocks.

## Sequencing for implementation

After this spec is approved, the order is:

1. Write `SKILL.md` in Codex house style with the seven section anchors above.
2. Write `references/methodology-rationale.md` from scratch in the skill's own voice.
3. Write `references/papers.md` paper-card bibliography.
4. Add `extraResources` entry to `electron-builder.yml`.
5. Add the second `migrateLegacyUserSkills` call site in `src/main/index.ts`.
6. Add the unit test.
7. Commit + show to user.

Each step is independent and reversible.

## Open questions

None blocking. All v1 review concerns resolved: no external file imports, body in Codex house style, the five extraction lenses preserved as a named section inside the single broad skill.

## Deliberately deferred (YAGNI)

- A UI "reset bundled skill to factory" button for users who edited their copy and want the new app version's content back. Not in scope; documented behavior is "user edits win permanently." Can revisit if a real user requests it.
- Multiple bundled skills. The mirror mechanism is designed to support any number of subfolders inside `resources/codex-skills/`, so adding a second one later is content-only work — no spec change needed.
- Auto-versioning of the bundled skill (e.g., `SKILL.md` carries a `version:` frontmatter field that the mirror checks). Same reason: real demand first.
