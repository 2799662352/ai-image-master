---
name: codex-research-grounded-prompting
description: Use when writing high-stakes prompts for video or image generation models (Sora, Midjourney, Kling, Veo, Stable Diffusion), when designing prompt-engineering systems, or when the user wants outputs grounded in both academic research and creator craft. Triggers on phrases such as "Sora prompt", "video generation prompt", "视频提示词", "动画 prompt", "怎么写更好的提示词", "prompt 方法论", or any task that demands rigor — source verification, multi-perspective structure, weight tuning, priority hierarchy, persuasion-over-accuracy, granularity alignment, or verification checklists.
---

<overview>
This skill operationalizes a single belief: high-stakes generation prompts get better when they fuse three tracks — academic research conclusions, creator-craft references, and a directing philosophy that defines what to sacrifice first.

Most prompts fail not because the model is weak but because they were written from memory — the author named a "宫崎骏 style" without ever confirming what that means today, cited exactly two reference works for a 10-second cut, and let the model fill the rest. This skill replaces that pattern with verified-source-first, multi-dimensional, weighted, and verified-on-the-way-out prompting.

It applies broadly. Sora 2 motion brief, Midjourney v7 style sheet, Kling 1.5 reference pack, Stable Diffusion ControlNet plan — same five pillars, same five extraction lenses, same verification pass.

> **Important — every name in this document is illustrative.** Director names, animator tag examples, film titles, palette presets, animation idioms below appear only to make the principles concrete. **They are not a default toolkit.** When a real brief arrives, pull references *the user's brief implies* — search for the names the user mentioned, the genre they chose, the platform they target. Never default to names from this skill just because they are here. "具体问题具体分析": the example is never the answer.
</overview>

<when-to-use>

| User wording | Does this skill apply? |
|---|---|
| "write me a Sora prompt for a 10-second fight scene" | Yes — flagship case |
| "怎么写更好的视频提示词 / Midjourney prompt 不出图" | Yes |
| "review my prompt and tell me what's missing" | Yes — pillar 5 + verification |
| "make a prompt that looks like 新海誠" | Yes — pillar 1 forces verification of what that means today |
| "extract character anchors from this paragraph" | Yes — lens 2 |
| "write a SQL query / regex / Dockerfile" | No — not a creative-generation prompt |
| "summarize this paper for me" | No |
| "draft a marketing email" | No |

Do not invoke for general coding, infra, data extraction, or technical writing. The pillars are tuned for *generative* output where intent beats fidelity.

</when-to-use>

<the-five-pillars>

These five principles are non-negotiable. Skip any one and the prompt regresses to "write from memory."

**Pillar 1 — Grounded in evidence.** Never write a director, animator, actor, cinematographer, palette, era, or genre reference from memory. If the runtime has a `web_search` / `fetch` tool, the model is expected to verify first — see `<authoritative-sources>` below for the catalog of *where to look*. If the runtime does not, the model flags the gap and asks the user for a source rather than confabulate. Every prompt produced under this skill states its sources, either inline or in a "Sources" trailer.

The reference candidates are always pulled from the user's actual brief — names they said, genres they invoked, platforms they target — not from a default list this skill maintains.

_Miniature example (illustrative; substitute whatever the user actually names):_ a user requests "a 10-second cut in the style of `<director-X>` + `<animator-Y>`" where X and Y are names *the user gave*. A model writing from memory will produce vague "anime style intense action." A model under this pillar first searches Sakugabooru / ANN / IMDb for those exact names, samples their recent work (2020+ for currency), and only then writes a 7-field director description that names verifiable techniques observed in the search results. If the user named no one, the model asks who they have in mind — never invents reference names.

**Pillar 2 — Structured by N dimensions.** A single-field prompt ("anime, dynamic, fight scene") misses everything that wasn't in the author's head. N-field formats force coverage. Three exemplar templates this skill suggests, all of which the model can instantiate or substitute for the domain:

- 7-field director description: 演出ロジック / リズム / 空間演出 / 感情表現 / 緊張緩和 / カメラワーク / 音響連動
- 4-perspective scene description: spatial structure, action flow, emotional direction, technical specs
- 3-pillar quality contract: MAD-level density, animation-density-per-second, theatrical-film-level finish

The reader instantiates their own N-field format when the domain is not animation — for a Midjourney still, the 4 fields might be subject / setting / camera-lens / lighting; for a Kling motion brief, motion-type / duration / camera-movement / continuity-anchor.

**Pillar 3 — Weighted by intent.** Default weight ratios rarely fit a specific task. Scan the user's wording for trigger keywords and switch mode before writing:

| Trigger words in user input | Mode | Weight redistribution |
|---|---|---|
| 感情, 演出, ドラマ, 物語, 情感, 心理 | Drama-first | direction 80% / quality 15% / aux 4% / storyboard 1% |
| 品質, 作画, 崩壊禁止, SNS, 投稿 | Quality-first | quality 40% / direction 50% / aux 8% / storyboard 2% |
| 構図, 分鏡, レイアウト, 配置, 厳守 | Layout-first | storyboard 30% / direction 50% / quality 15% / aux 5% |
| キャラ, IP, 一貫性, 似せて, 人設 | Character-first | character 25% / direction 50% / quality 20% / aux 5% |
| 自由, 実験, 創意, 挑戦, 革新 | Experimental | direction 60% / quality 15% / aux 15% / storyboard 5% / character 5% |
| Explicit `%` numbers in user input | User-specified | Apply exactly, verify sum ≈ 100% |

When constraints collide (lighting wants warm but mood wants cold), the prompt explicitly declares which one yields. Implicit priority causes the model to average — which kills both.

**Pillar 4 — Persuasion over accuracy.** For creative generation, intent beats fidelity. Violating physics is a feature in animation; violating composition is a feature in surrealism; violating anatomy is a feature in stylized illustration. Animation physics, in particular, is its own discipline: exaggerated motion is the quality indicator, not a defect.

This pillar is the inverse of evidence-grounding from pillar 1 — it says *once the references are verified, take artistic liberty deliberately*. It does **not** apply to scientific illustration, infographics, technical documentation, or any output where literal accuracy is the deliverable.

**Pillar 5 — Verified before shipping.** Produce-then-check at three granularities, plus a 5-7 binary checklist tuned to the domain. Coarse: does the overall composition match the brief? Medium: does each named subject's action and expression land? Fine: are audio-visual sync, color contrast, specific elements present? The checklist is binary — every item is yes/no, no maybes. If three or more items are "no", the prompt rewrites rather than ships.

</the-five-pillars>

<five-extraction-lenses>

These are the *what* (concrete scenarios in Codex conversation) that consume the pillars' *how*. Same framework, different vantage points. When the user's request matches one of these, lead with the corresponding lens.

**Lens 1 — Intent extraction.** Trigger: a vague creative request ("帮我整一个酷的画面", "I need something epic"). Recipe:
- Translate the vague description into six operable variables: theme, mood, style class, target platform, cast count, use case
- Identify what the user said vs. what they implied vs. what they left blank
- Surface the blanks before any prompt drafting; either ask, or pick defaults and announce them
- Output a one-paragraph "extracted brief" the user confirms before generation starts

**Lens 2 — Character anchor extraction.** Trigger: a recurring character (2+ panels) or "保持角色一致" / "character changed between panels". Recipe:
- Define each character once as a dense visual contract: face, hair, build, outfit head-to-toe, distinguishing markers
- Use concrete colors (hex where possible), no relative-to-photo descriptors
- Reuse the anchor *word-for-word* in every prompt that includes the character — repetition is the mechanism
- Mark wardrobe changes as `v1 / v2` versions, never compress two outfits into one anchor
- Verify: does every generated panel show the same hair color, length, outfit pieces, markers?

**Lens 3 — Style extraction.** Trigger: a reference image or vague style adjective ("赛博朋克风", "温暖"). Recipe:
- Decompose into controllable parameters: palette ratio (`#hex_a 70% / #hex_b 30%`), key light type + angle, shadow depth %, medium (35mm film / cel-shading / digital paint), brushstroke granularity, composition density
- For adjectives like "warm", disambiguate: is it color-warm or narrative-warm?
- Anchor the style with one verified reference work or animator — see `<authoritative-sources>`
- Carry the same style descriptor verbatim across every related output, the same way anchors travel

**Lens 4 — Shot-rhythm extraction.** Trigger: multi-frame sequence, storyboard, shot list. Recipe:
- Map out the shot-type cycle: wide (establish) → medium (interaction) → close-up (emotion) → POV / over-the-shoulder (perspective shift). Never N copies of the same shot type
- Vary camera movement across panels: static / push-in / pull-out / pan / tilt / dolly / crane / handheld
- Lock continuity vectors: lighting direction, motion-vector continuity, eye-line, time-of-day, weather
- Identify the emotional curve before writing prompts — the rhythm follows the curve

**Lens 5 — Hand-off extraction.** Trigger: extraction complete, now the user has to feed it to a downstream model or batch tool. Recipe:
- Honor per-platform quirks: Midjourney ignores quality tags, Stable Diffusion eats negatives, DALL-E rejects style-tag stacks
- Embed anchors and style descriptors verbatim in every individual prompt — never paraphrase between items in a batch
- Dedup boilerplate (the negative prompt and the style anchor) — once at the top of the batch beats N copies inside each item, *if* the consumer supports per-batch prefixes; otherwise inline
- Produce a single delivery format: numbered list, plain newline-separated, JSON only if the user said they will feed it to a script

</five-extraction-lenses>

<authoritative-sources>

This skill explicitly requires the model to use whatever web-search or fetch tool the runtime exposes (Codex CLI's `web_search`, an MCP `fetch` tool, a browser tool, etc.) to verify references against primary sources *before* writing the prompt. The model picks the matching site by domain — and inside that site, picks the *query* based on names and tags **the user actually mentioned**, not from a default list this skill maintains.

**Animation craft (作画 / 監督 / アニメ)**

| Site | URL | What to look for |
|---|---|---|
| Sakugabooru | `https://www.sakugabooru.com/` | Animator-tag pages for whichever animator the user named; recent clips (2020+) for currency |
| Sakuga Blog | `https://blog.sakugabooru.com/` | Animator / director interviews, episode-level sakuga analysis |
| Anime News Network | `https://www.animenewsnetwork.com/` | Full staff lists per episode, director filmography, current production credits |
| AniDB | `https://anidb.net/` | Technical production records, studio lineage |
| Anikore | `https://www.anikore.jp/` | Japanese-domestic episode-level review consensus |
| Canipa Effect (YouTube) | `https://www.youtube.com/@CanipaEffect` | Long-form production breakdowns when articles aren't enough |

**Live-action film / cinematography**

| Site | URL | What to look for |
|---|---|---|
| IMDb | `https://www.imdb.com/` | Director / DP / production designer filmography, release year, technical specs |
| Letterboxd | `https://letterboxd.com/` | Style / tone consensus, curated lists by director |
| The American Society of Cinematographers | `https://theasc.com/` | DP interviews, lens / format / lighting decisions |
| Cinematography.com | `https://www.cinematography.com/` | DP forum threads on specific film techniques |
| Shot Café | `https://shotdeck.com/` (signup needed) | Stills indexed by shot type / lens / lighting / palette |
| The Film Stage / IndieWire / Filmmaker Magazine | various | Director craft interviews |

**Stills / illustration / concept art**

| Site | URL | What to look for |
|---|---|---|
| ArtStation | `https://www.artstation.com/` | Concept-art style references by artist / studio / genre |
| Pixiv | `https://www.pixiv.net/` | Japanese illustration tags, era-specific styles |
| Behance | `https://www.behance.net/` | Cross-medium reference packs by designer |

**Academic grounding (research papers)**

| Site | URL | What to look for |
|---|---|---|
| arXiv | `https://arxiv.org/` | Latest video-generation / vision-language papers |
| HuggingFace Papers | `https://huggingface.co/papers` | Curated daily, with model / dataset cross-links |
| Papers with Code | `https://paperswithcode.com/` | Benchmark leaderboards, reproducibility links |

The list is illustrative, not exhaustive. For domains outside the above — game art, fashion editorial, architecture — the model picks the equivalent authoritative source and applies the same rule: cite or flag the gap; never invent.

</authoritative-sources>

<title-driven-shortlisting>

Sometimes the user names a *work* but not the *people* — *"want the feel of `<film-title-X>`"*, *"shots like that `<franchise-Y>`"*, *"`<animation-studio-Z>` kind of style"*. The work alone is not a research anchor that pillar 1 can verify: the model has to translate the title into the actual creators who shaped the look the user is reaching for, then let the user pick which of those creators becomes the anchor.

**Trigger**: the brief names a film, anime, series, game, or franchise — usually wrapped in 《》, "", or quoted English / Japanese / Korean titles — without naming a director / animator / DP / composer / art director directly. If the user *did* name a specific person, skip this section and go straight to the walkthrough's Step 1.

**Process**:

1. For each title `<title-i>` the user named, query the available web search tool with `web_search("<title-i> staff credits director cinematographer art director")` and the analogous query in the source language — Japanese 「<title-i> スタッフ」 for anime, Chinese「<title-i> 主创」 for Chinese films, Korean「<title-i> 스태프」, and so on. The goal is the actual credited crew, not training-data guesses.

2. Aggregate the credits, filter to the people who *visibly shaped the look the user is reaching for*. Default roles to surface: **director**, **director of photography / cinematographer**, **art director / production designer**, **key animator / animation director / 作画監督** (anime), **color grading lead / colorist** (live action), **composer** (only when the user's brief implies audio). Skip producers, distributors, and uncredited supervisors.

3. Present **3 to 5 candidates**, each as one line in the format: *"`<name>` — `<role on this title>` — `<one specific signature trait the user can verify in one click>`"* (e.g. *the centred-symmetry tableau in their other film `<title-A>`*, *the sub-frame smear pass shown in this `<sakugabooru-tag>`*). Every signature trait must be something the user can actually open and check; if you cannot point to a verifiable work or clip, drop that candidate rather than padding the list with vague descriptors.

4. **Ask the user to pick one or several** as the anchor(s) for pillar 1. Never silently default to "all of them" or "the director" — the user's pick is the anchor; until they pick, no prompt content is drafted. If the brief is urgent and the user explicitly says *"just pick a sensible default and go"*, the model may pick the director-of-photography (live action) or the animation director (anime) as the safest fidelity-bearing role, but must announce that choice and offer a one-step swap.

5. Once the user picks, the picked names become `<ref-1> … <ref-N>` for the walkthrough's Step 1 (verify), and the work title itself becomes a secondary reference — useful for evidence-corpus expansion but not the primary anchor unless the user explicitly says *"the title itself is the style, the people are interchangeable"*.

**Failure modes to avoid**:

- *Skipping the search* and listing names from memory — these candidates are wrong about half the time and recursively poison pillar 1's evidence grounding.
- *Listing the same predictable household-name director* for every famous title — the user already knows that name; the value of shortlisting is surfacing the lesser-known key animator / DP / production designer whose specific touch the user actually wants.
- *Pre-picking for the user* — the model never decides which candidate is "the right one." That collapses the whole point of shortlisting.
- *Refusing to shortlist because the title is obscure* — if web search returns thin results, surface what *was* found, flag what is missing, and ask the user whether to proceed with thin grounding, choose a different anchor work, or supply the names directly.

After the user picks, walkthrough Step 1 (`<walkthrough>`) takes over with the picked names as `<ref-i>`.

</title-driven-shortlisting>

<walkthrough>

End-to-end process — same six steps regardless of domain. Symbolic placeholders are used (`<style-X>`, `<reference-Y>`, etc.) to make clear that **nothing in the steps is a default name to plug in**. Read the user's brief, harvest *their* names, and substitute those.

Step 1 — verify references (pillar 1). Parse the user's brief and harvest every proper noun: directors, animators, actors, DPs, palettes, eras, specific film/episode titles, platforms, genres. **If the only proper nouns harvested are work titles (films, anime, series, games, franchises) and no individual creator is named, the model first runs `<title-driven-shortlisting>` to translate each title into 3-5 candidate creators and waits for the user to pick before continuing.** Call the named creators — or the user-picked candidates from shortlisting — `<ref-1> … <ref-N>`. For each, invoke the available web search / fetch tool against the domain-appropriate row of `<authoritative-sources>` — `web_search("<ref-i> sakugabooru recent")` for animator tags, `web_search("<ref-i> ANN staff")` for director credits, `web_search("<ref-i> IMDb")` for film, etc. If a search returns nothing or only stale data, the model says so explicitly — never substitutes a similar-sounding name from training data. If the user named *no* references *and no titles either*, the model asks "what reference works or creators should I anchor to?" before drafting anything.

Step 2 — detect mode (pillar 3). Scan the user's wording for trigger keywords (the table under pillar 3). Pick the matching mode and announce it back in one line: *"Mode: <name>. <one-sentence priority statement>."* If no trigger keyword is present, default mode applies — say so.

Step 3 — fill the N-field structure (pillar 2). Pick the N-field format appropriate to the domain (the three template examples in pillar 2 are starting points, not mandates). Write each field in compact prose. Mark any field genuinely N/A; never leave a field blank silently.

Step 4 — declare priority (pillar 3 continuation). Anywhere two constraints could conflict (style vs. mood, accuracy vs. persuasion, layout vs. emotion, character continuity vs. dramatic moment), state which one yields. One short sentence per collision point.

Step 5 — write the prompt itself (pillar 4). Apply persuasion-over-accuracy *only* if the domain warrants it — animation, surrealism, stylized illustration. For technical or scientific output, skip pillar 4 and keep fidelity. Output one prompt, sized for the consumer (Sora 2 wants ~80-120 words; Midjourney prefers shorter; Stable Diffusion accepts weighted tags).

Step 6 — verification pass (pillar 5). Run a binary checklist sized to the domain. A reasonable starter set, to be adapted per task:

- [ ] Sources cited for every named reference?
- [ ] Every field of the chosen N-field structure either filled or marked N/A?
- [ ] Priority declared at every collision point?
- [ ] For creative domains: persuasion-over-accuracy called out explicitly, not just implied as "dynamic"?
- [ ] References named at the level of specific works (episode / scene / shot), not vague era / genre?

If three or more items fail, rewrite rather than ship.

The skill prescribes the *process*, not the prompt. The prompt body is always derivative of the user's actual brief and the references it implies.

</walkthrough>

<verification>

Before declaring the prompt done, the model self-checks:

1. **Did I cite a source for every craft reference I named?** Yes / No.
2. **Did I cover every field of the N-field structure I chose, or explicitly mark a field as N/A?** Yes / No.
3. **Did I declare priority where two constraints could collide (style vs. mood, accuracy vs. persuasion, layout vs. emotion)?** Yes / No.
4. **For creative-generation tasks, did I lean toward intent over fidelity where appropriate?** Yes / No / N/A for non-creative tasks.
5. **Did I make a coarse → medium → fine pass on the produced prompt and surface anything that fails any granularity?** Yes / No.

Three or more "No" answers means the prompt is not ready and the model rewrites rather than ships.

</verification>

<companion-skills>

This skill is **the method**. The 19 sibling skills under `$HOME/.agents/skills/{director-*,storyboard-*}/` are **the recipes** — every one of them is a battle-tested in-app prompt-craft rule set ported verbatim from the storyboard pipeline and director mode of this application. The method tells you *what to do at each step*; the recipes give the exact *rules for how to write the words*. Use them in tandem; never use the method alone when a matching recipe exists.

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

**How to invoke them in a Codex chat.** When the conversation reaches a step listed above:

1. Mention the sibling skill by name in your reasoning, e.g. *"Now applying `storyboard-style` for palette decomposition + `director-lighting-continuity` for cross-panel light coherence"*. This makes the lineage traceable for the user.
2. *Quote* the specific rule(s) you are following from that sibling's body — not the whole body, only the rules that apply to the current step.
3. If multiple siblings collide at the same step (e.g. Lens 3 has four candidates), pick the one whose rules best fit the user's actual brief, or compose two of them when they cover different sub-dimensions (palette vs. lighting vs. composition).

Codex CLI keeps every USER-scope SKILL.md in the session registry — you can reference any sibling freely; the user does **not** need to manually `/skill load` each one. They become a part of your reasoning toolkit the moment this skill activates.

**One caveat.** The siblings were originally authored for two specific in-app pipelines (UnderstandPage's storyboard pipeline, GeneratePage's director mode). In the source files those pipelines hooked on a `appliesTo:` frontmatter field — stripped during the port to Codex registry because it is not part of Codex's frontmatter schema. The *rule bodies* themselves are domain-agnostic and apply whenever you are writing the matching kind of prompt content.

**Don't double up unnecessarily.** When the user's task only needs a single sibling (e.g. "decompose this palette into hex + ratio"), invoke just that sibling — do not gratuitously layer all five pillars on top of a one-shot recipe call. The method is for high-stakes multi-dimensional briefs; the recipes alone are enough for narrow, well-defined sub-tasks.

</companion-skills>

<references>

Two companion files live alongside this `SKILL.md` inside `$HOME/.agents/skills/codex-research-grounded-prompting/`:

- `references/methodology-rationale.md` — why these five pillars and five lenses exist, the failure modes each one prevents, the research lines and craft traditions that motivated them, and an anti-example showing what happens without each pillar.
- `references/papers.md` — short reading-list of public research papers (AniSora, CRAVE, MiraData, Open-Sora 2.0, Video-Bench) with arXiv / HuggingFace links and 2-3 sentence rationale for why each one matters here.

Read those when the user asks "why this rule" or "where did this come from", or when designing N-field structures for a new domain not already covered.

</references>
