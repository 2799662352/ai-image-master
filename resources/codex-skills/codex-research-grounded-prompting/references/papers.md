# Public Research — Reading List

A small, curated set of public research lines that motivate the principles in `SKILL.md`. The list is intentionally short; depth beats breadth.

**This document deliberately does NOT inline arXiv IDs.** Following pillar 1 of the skill itself — "Grounded in evidence, never from memory" — IDs are intentionally omitted because they were not verified at write-time. The reader (model or human) is expected to use a web search tool with the keywords below, find the canonical link on arXiv / HuggingFace Papers / Papers with Code, and confirm the ID, version, and authorship before citing. This is the same discipline the skill demands of any prompt that names a director or animator.

## Animation video generation

**AniSora — animation-domain video generation evaluation**

- Search: `AniSora arXiv animation video generation`, `AniSora bilibili open-source`
- Why it matters here: identifies that *animation videos have unique artist styles, violate laws of physics, and contain exaggerated motions* — and that general-purpose video models tend to suppress those violations. Direct motivation for pillar 4 (Persuasion over accuracy).
- What to look for once you find it: the paper's failure-mode taxonomy on animation-specific generation defects, and the benchmark categories they propose for animation alignment.

## Multi-perspective text-to-video data

**MiraData — long-duration video dataset with structured captions**

- Search: `MiraData arXiv long duration video`, `MiraData tencent ARC structured captions`
- Why it matters here: demonstrates empirically that *structured captions across multiple perspectives* (spatial / action / emotional / technical) generate substantially better text-to-video alignment than single-field captions. Direct motivation for pillar 2 (Structured by N dimensions).
- What to look for: their ablations on caption structure and their per-perspective annotation schema.

## Content-rich video quality assessment

**CRAVE-style content-rich AIGC video evaluation**

- Search: `content-rich AIGC video evaluation`, `text-video alignment multi-granularity`
- Why it matters here: formalizes that *text-to-visual matching is multi-granularity* — text-only models that align at one granularity miss problems visible at another. Direct motivation for pillar 5 (Verified before shipping, coarse → medium → fine).
- Note: "CRAVE" is one specific paper; the broader research line on content-rich AIGC video quality assessment is what the principle draws on. Use the search keywords above to find the cluster, not just one paper.

## Open Sora-class reproduction work

**Open-Sora and similar open Sora-class video generators**

- Search: `Open-Sora 2.0 arXiv`, `HPC-AI Lab Open-Sora technical report`
- Why it matters here: training-side documentation that *priority signaling in the conditioning input* materially affects whether the model honors user intent or interpolates between constraints. Direct motivation for pillar 3 (Weighted by intent).
- What to look for: their discussion of caption augmentation, conditioning hierarchy, and what fails when conditioning is treated as a flat bag of constraints.

## Human-aligned video benchmark

**Video-Bench and human-aligned video evaluation**

- Search: `Video-Bench arXiv human-aligned evaluation`, `human evaluation text-to-video benchmark`
- Why it matters here: empirical evidence that *human evaluators detect problems at three distinct granularities* (composition / subject-action / fine-detail-and-sync). Direct motivation for pillar 5's coarse → medium → fine self-check.
- Note: "Video-Bench" is a common name; multiple papers share variants of it. The relevant cluster is the one focused on *human-aligned* evaluation across granularities, not pure metric-based scoring.

## How to use this list

When the user asks "why this rule" or wants to read deeper:

1. Pick the pillar they are asking about (1-5)
2. Map it to the paper / cluster above
3. Use a web search tool with the keywords to locate the current canonical link
4. Read the abstract and the ablation tables — those are the load-bearing evidence
5. Report back the link with the abstract excerpt that supports the pillar; never paraphrase the conclusion without the source

When designing N-field structures for a *new* domain not covered by `SKILL.md` (game art, fashion editorial, architecture):

1. The methodology generalizes; the field list does not
2. Read MiraData's per-perspective annotation schema for the *shape* of a good N-field structure
3. Adapt it to the new domain by asking: what dimensions does a professional brief in this domain already specify? Those become the N fields.

The list is intentionally short. Depth beats breadth for methodology grounding.
