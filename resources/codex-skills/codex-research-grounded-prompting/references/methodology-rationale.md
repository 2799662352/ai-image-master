# Methodology Rationale

This document explains the *why* behind the five pillars and five extraction lenses in `SKILL.md`. Each section identifies the failure mode the principle prevents, the research line and craft tradition that motivated it, and an anti-example showing what happens when it is skipped.

The framing throughout is: prompt engineering for high-stakes generation works only when *research* sets the direction, *craft* fills the detail, and *philosophy* defines priority. Any single track in isolation produces brittle output.

## Pillar 1 — Grounded in evidence

**Failure mode it prevents.** "Confabulated reference syndrome." The model writes a prompt that names a director or animator from training-data recall, with no confirmation that the named person is still active, that their named style still describes their current work, or that the cited reference film actually contains the technique being asked for. The model then produces a generic anime / film output that looks nothing like the cited reference, because the cited reference itself was a hallucination of average-anime training data.

**Research line that motivated it.** The AniSora line of work (animation video generation evaluation) consistently shows that LLMs and video models default to a "mean anime style" when references are not concrete. Independently, the CRAVE line on content-rich AIGC video quality assessment formalizes that "alignment to text" only holds when the text refers to verifiable visual content. Both lines converge on: vague references → vague output, regardless of model strength.

**Craft tradition that motivated it.** The Japanese sakuga culture — particularly the Sakugabooru / Sakuga Blog community — built an entire vocabulary around animator-credit accuracy: 松本筆 / 中村筆 / 井上筆 / 沖浦筆 each designate concrete observable techniques traceable to specific 1990s–2020s episodes. The craft asserts that "in the style of X" is meaningful *only* when X is a verifiable corpus of cuts, not an adjective.

**Anti-example** *(names below appear only because the example brief invokes them — they are not a default toolkit; substitute whatever names the actual user mentions)*. A user request like "a 10-second fight scene in the style of `<animator-A>` and `<director-B>`" tempts a model writing from memory to produce: *"Dynamic anime fight scene, intense action, neon lighting, dramatic camera angles, high quality."* This is generic. Under pillar 1, the model first searches Sakugabooru for `<animator-A>`'s tag page to confirm what technique actually defines that animator's recent work, then fetches Anime News Network for `<director-B>`'s recent credits to confirm whether the comparison even coheres (an animator and a director operate on different layers; the comparison must clarify which trait of each applies). Only then does the prompt name concrete techniques observed in the search results — never names retrieved from training-data recall.

## Pillar 2 — Structured by N dimensions

**Failure mode it prevents.** "Single-field underspecification." The prompt collapses a complex creative brief into one descriptor blob ("dynamic anime fight in dramatic neon lighting"), which means the model has to invent every dimension the descriptor failed to name. Cast count, time-of-day, weather, exact lighting key, camera-movement preference, emotional arc, audio cues — all left to the model's defaults. Results vary wildly across re-rolls because the prompt only constrained one dimension out of fifteen.

**Research line that motivated it.** The MiraData work on long-duration video datasets demonstrates empirically that prompts written as *structured captions across multiple perspectives* (spatial, action-flow, emotional, technical) generate substantially better text-video alignment than single-field captions, even at fixed model size. The CRAVE work formalizes this as *multi-granularity alignment*: text-to-visual matching is N times more reliable when the text itself addresses N distinct visual dimensions.

**Craft tradition that motivated it.** Film and animation production naturally produce multi-field documents. A 絵コンテ contains shot type, camera movement, composition, dialogue, sound, duration — each in its own column. A DP's lighting plan separates key / fill / rim / practical. A director's script-supervisor sheet tracks continuity per-prop and per-wardrobe. Prompt engineering inherits this: the N-field structure is not invented for AI; it is the *only* form in which professional creative briefs have ever existed.

**Anti-example.** "Write a Midjourney prompt for a cyberpunk street scene." Single-field. The model invents a rainy Tokyo alley, blade-runner-ish neon, no people, by default — because cyberpunk averaging in training data lands there. Under pillar 2, the prompt explicitly addresses *subject* (a young courier on an electric scooter), *setting* (mid-rise commercial strip at dusk in São Paulo, not Tokyo), *camera* (low-angle 35mm, rule-of-thirds with the subject right), *lighting* (cool teal storefront fluorescents, warm sodium-vapor streetlights, atmospheric haze), *style* (Cyberpunk Edgerunners cinematography, not Blade Runner). Now the model has fifteen dimensions instead of one.

## Pillar 3 — Weighted by intent

**Failure mode it prevents.** "Implicit-priority averaging." When the user signals a strong preference (say, "I care most about the *feeling* of this scene; the layout is flexible"), but the prompt treats all constraints with equal weight, the model averages them — landing exactly in the middle of feeling and layout, satisfying neither. This is especially common when the user has unusual priorities: "I want technical perfection even at the cost of emotion" or "I want experimental composition even at the cost of brand consistency."

**Research line that motivated it.** The Open-Sora 2.0 training notes document explicitly that aligning model behavior with user intent requires *priority signaling* in the conditioning input — not just constraint enumeration. Without explicit priority, the model interpolates. With explicit priority, the model can sacrifice the right things in the right order.

**Craft tradition that motivated it.** The 70/20/8/1/1 weight system in the user's source methodology (direction / quality / aux / character / storyboard) is itself an adaptation of the older 監督主導 production tradition in Japanese animation, where the director's 演出 is granted authoritative priority over individual animator preferences. Live-action film has the same pattern under different names: "director's cut" vs. "studio cut", "DP's vision" vs. "production's brief". Every craft has a tacit weight system; this pillar makes it explicit.

**Anti-example.** A user writes: "I want this video to feel like Girls Band Cry — really raw emotion, real moments. Don't worry too much about technical polish." If the prompt treats all five constraint types equally — direction 20% / quality 20% / aux 20% / character 20% / storyboard 20% — the model produces a polished but emotionally cold result, because polish is easier than rawness at training-data scale. Under pillar 3, the prompt declares direction 80% / quality 15% / aux 4% / storyboard 1% explicitly, and the model now knows that if a moment must choose between *raw and rough* vs. *smooth and clean*, raw wins.

## Pillar 4 — Persuasion over accuracy

**Failure mode it prevents.** "Sim-fidelity collapse." When the model treats animation as a special case of live-action physics simulation, it produces flat, joint-correct, mechanically-plausible motion that fails to read as animation. Real animation routinely violates physics — fire shape changes for intimidation, perspective distorts for compression, joint range exaggerates for impact, hair has its own micro-gravity — because *the goal is emotional persuasion*, not physical accuracy.

**Research line that motivated it.** AniSora research explicitly identifies that "animation videos have unique artist styles, violate laws of physics, and contain exaggerated motions" — and that current video models tend to *suppress* these violations in favor of their general-purpose realism prior. The countermeasure: tell the model, in the prompt, that violation is allowed.

**Craft tradition that motivated it.** The entire 作画 MAD tradition stands on this principle. 中村豊's impact frames stretch a body across the frame in ways no human spine could survive. 今石洋之's over-the-top action choreography violates inertia constantly. 沖浦啓之's "realistic" weight is itself a stylization — heavier-than-real because it reads better. Every notable sakuga moment is, technically, "wrong." The wrongness is the point.

**When this pillar does NOT apply.** Technical illustration, scientific visualization, medical diagrams, infographics, architectural renderings, product mockups, evidence imagery. In all these, accuracy is the deliverable; persuasion is a byproduct. The skill must explicitly disable this pillar for those tasks. The trigger is the *purpose of the output*, not the medium.

**Anti-example.** A user asks for a Sora cut of an anime sword strike. A model treating Sora's general-purpose physics as authoritative produces a clean, biomechanically-plausible sword swing with neutral motion blur — and the result reads as live-action martial-arts choreography, not anime. Under pillar 4, the prompt explicitly states "exaggerate motion beyond physical possibility; impact frame should stretch the figure 1.5x its normal silhouette at peak; trail debris physics is artistic, not Newtonian." Now the result reads as animation.

## Pillar 5 — Verified before shipping

**Failure mode it prevents.** "Produce-and-pray." The author writes the prompt, hands it to the model, gets a result, and either ships it or rewrites the whole prompt from scratch. There is no systematic check, so the same mistakes recur across prompts: missing characters, wrong era, lighting mismatch with previous panel, audio described but not synced to a visual beat.

**Research line that motivated it.** Video-Bench and similar human-aligned video evaluation work consistently show that human evaluators detect problems at three distinct granularities: *coarse* (overall composition / does the scene make sense), *medium* (each named subject and their action), *fine* (audio-visual sync, color contrast at specific moments, individual texture details). Models that self-evaluate at all three granularities catch problems before shipping; models that self-evaluate at only one miss the others.

**Craft tradition that motivated it.** Every film and animation production has a *check phase* — dailies in live-action, ラッシュチェック in animation, color-key verification in concept art. The check is not optional; it is the third leg of the production tripod after planning and execution. This pillar imports that discipline into prompt engineering.

**Anti-example.** A user asks for a 6-panel storyboard. The model writes 6 prompts and stops. The user runs them. Panel 3 has the wrong character (a male instead of the female protagonist); panel 5 has noon lighting in a scene anchored as midnight; panel 6 contradicts the established camera angle direction. Under pillar 5, the model self-checks each panel against the brief (coarse), the character anchor (medium), and the continuity locks (fine) before declaring the storyboard done. Three of the six get rewritten without the user having to point it out.

## Lens 1 — Intent extraction

**What it does.** Converts a vague user request into six operable variables (theme, mood, style class, target platform, cast count, use case), surfaces the gaps, and confirms the extracted brief before prompt drafting begins. Without this, every later step compounds the ambiguity.

**Why it leads.** Pillar 1 cannot verify what was never specified; pillar 2 cannot structure across dimensions that were never named; pillar 3 cannot weight what was never expressed. Intent extraction is upstream of everything.

**Common patterns the lens catches.** Users often say "I want something cool" or "make it epic" while internally meaning a very specific reference work they haven't named. Users often specify cast count but not whether the protagonist is on-screen in every panel. Users often specify "Sora" but not the duration or aspect ratio. The lens forces all of this to the surface.

## Lens 2 — Character anchor extraction

**What it does.** Defines each recurring character once as a dense visual contract (face / hair / build / outfit / markers), then enforces *word-for-word* reuse across every prompt that includes that character. The repetition itself is the consistency mechanism — paraphrasing breaks it.

**Why it works.** Image and video generation models are sensitive to phrase identity at the token level. "A young woman in a charcoal trench coat" and "a young woman in a dark long coat" tokenize differently, even though semantically equivalent. The first phrase indexed into the model's representation space lands somewhere; paraphrases land at slightly different points, and the result is *almost* the same character. Across a 6-panel sequence, "almost" compounds into "obviously different."

**When wardrobe changes.** Generate a new anchor version, never compress two outfits into one. `C01.v1 = day outfit`, `C01.v2 = evening outfit`. The story permits the change; the anchor system has to acknowledge it.

## Lens 3 — Style extraction

**What it does.** Decomposes a vague style adjective ("warm", "cyberpunk", "cinematic") into controllable parameters (palette ratio with hex, key light type and angle, shadow depth percentage, medium, brushstroke granularity, composition density).

**The disambiguation move.** "Warm" can mean color-warm (orange / amber palette) or narrative-warm (intimate / emotional content). Conflating them produces orange-palette horror scenes by accident. The lens forces the user — or the prompt author standing in for the user — to pick one meaning and state it.

**The anchor move.** Even after decomposition, the style needs a verified reference work. "Cyberpunk Edgerunners cinematography" is verifiable on IMDb and Sakugabooru; "cyberpunk" alone is not.

## Lens 4 — Shot-rhythm extraction

**What it does.** Maps a multi-frame sequence to a varied shot-type cycle, varied camera movement, and locked continuity vectors. Identifies the emotional curve first so the rhythm follows the curve.

**Why variety matters.** Six consecutive medium shots produce a flat storyboard. Cinema has known this for a century: the rhythm of wide → medium → close-up → POV is what creates pacing. Animation inherits the same rule; AI generation, asked to produce six prompts without rhythm guidance, will default to six similar shots because that minimizes prompt-to-prompt distance.

**Continuity locks.** Lighting direction, motion-vector continuity (left-to-right action stays left-to-right), eye-line (180-degree rule), time-of-day, weather. Each of these, locked across all panels, makes the storyboard read as continuous; broken, it reads as a slideshow of unrelated images.

## Lens 5 — Hand-off extraction

**What it does.** Takes the completed extraction package and packages it for the downstream consumer — a specific image / video model, a batch tool, a downstream pipeline. Honors per-platform quirks rather than producing platform-agnostic output that loses signal in translation.

**Per-platform quirks the lens encodes.** Midjourney v6+ ignores `--quality` style boosters; the prompt should drop them. Stable Diffusion respects negative prompts strongly; SDXL responds to weighted phrases `(thing:1.3)`; Flux does not. DALL-E 3 rejects style-tag stacks like "trending on artstation, 8k, masterpiece"; it wants natural language. Kling 1.5 needs explicit motion duration and camera-movement vector. Sora 2 needs duration and aspect ratio declared. The lens picks the right shape per target.

**The dedup move.** When delivering a batch of N prompts, the anchor and negative are shared. If the consumer supports per-batch prefixes (some custom pipelines do), put the shared content once at the top. If the consumer doesn't, accept the duplication — but never paraphrase between items, only ever duplicate verbatim.

---

This document complements `SKILL.md`. Read it when designing N-field structures for a new domain (game art, fashion, architecture), when an existing pillar feels too abstract, or when a user asks "why this rule." The pillars and lenses themselves are stable; the application to new domains is creative work that benefits from understanding why each principle exists.
