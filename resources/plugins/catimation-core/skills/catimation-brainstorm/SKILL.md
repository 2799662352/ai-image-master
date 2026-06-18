---
name: catimation-brainstorm
description: >-
  Co-direct open-ended or high-value creative work in CATIMATION via clickable
  choice cards (the ask_user tool). Trigger when the user is vague/ambitious
  about a video/image ("做个宣传片" / "来点有电影感的" / "帮我想想" / "随便发挥"), asks to
  brainstorm / 头脑风暴 / 给我几个方案 / 你来引导, OR asks you to offer choices
  ("给我几个选项" / "让我选" / "二选一" / "可选" / "options" / "which should I"). Ask ONE
  focused question at a time with concrete options. Skip for clear simple asks.
---

# Brainstorm + co-direct with clickable choices

For open-ended or high-stakes creative requests, don't guess silently and don't
dump a wall of questions. Shape the work **with** the user using the
`ask_user` tool, which renders a real clickable card in the chat (single-select,
multi-select, free text, or skip). The user taps a choice and you continue.

## When to use this

- **Use it** when the ask is vague / ambitious / high-value: 「做个产品宣传片」
  「来个有电影感的片段」「帮我想个开场」「随便发挥」, the user asks to brainstorm or be
  guided, OR asks you to offer choices: 「给我几个选项」「让我选」「二选一」「options」.
  Any time you'd list options as text, render them as a card instead.
- **Strong default: most of the time, put 方案 / 方向 / 选项 into a single
  `ask_user` card rather than a numbered text list (方案1 / 方案2 / …)** so the
  user can just tap. If you brainstormed 8 方案, the card gets 8 options. Writing
  方案 as plain text and then stopping usually leaves the user nothing to click —
  prefer the card. (Not an absolute rule: it's fine to stay in plain text when the
  user is clearly just discussing/iterating and isn't being asked to pick yet.)
- **Skip it** for clear, simple asks (「把这张图做成 5 秒视频」「生成一只猫」). A
  pop-up there just annoys the user — pick sensible defaults and go.

## The flow

1. **One question at a time.** Call `ask_user` with a short `question` and
   **as many concrete `options` as the situation needs** — usually 3–6, and up to
   8 when you genuinely have that many distinct directions. There is **no 4-option
   cap**; list every real 方案 you came up with. Each option = a short `label` +
   optional one-line `description` trade-off. (Don't stack five *questions* into
   one card — many *options* for ONE question is fine.)
2. **Recommend.** Put the option you'd suggest first and say why in its
   description — you're a director with a point of view, not a form.
3. **Pick the mode:**
   - `mode: "single"` — one choice (景别 / 风格 / 时长).
   - `mode: "multi"` — combinable choices (要哪些元素 / 多个风格标签).
   - no options + `allowFreeText` — open question (片名 / 一句话主题).
   - keep `allowSkip: true` so the user can hand the decision back to you.
4. **Act on the answer.** The tool returns the chosen option ids + labels and any
   free text. If the user skipped, choose a sensible default and say what you
   picked. Then continue (e.g. load a local craft skill, write the prompt, call
   `generate_video` / `generate_image`).
5. **Converge fast.** 1–3 questions is usually enough. Stop asking once you have
   what you need; over-interrogating is worse than a good default.

## Example

```
ask_user({
  question: "这个宣传片想要什么气质?",
  options: [
    { id: "cinematic", label: "电影感 / 高级", description: "低饱和、浅景深、慢运镜（推荐）" },
    { id: "energetic", label: "活力快剪", description: "高饱和、快切、强节奏" },
    { id: "clean", label: "干净产品图风", description: "纯色背景、聚焦产品" }
  ],
  mode: "single",
  allowSkip: true
})
```

## Hand off to the shot orchestrator (导演总调度)

Once the direction is set (or for any clear ask that needs a prompt), **load
`director-orchestrator` BEFORE writing the prompt or calling
`generate_image` / `generate_video`.** It is the using-superpowers-style router
for all `director-*` / `storyboard-*` craft skills:

1. It runs a mandatory STEP 0 self-reflection — 「这次涉及 13 维里的哪几维?要用到哪些本地
   director-* / storyboard- skill?」 — and loads the matching craft skills.
2. It writes the prompt as **structured text (never JSON)** on the 13-dimension
   cinematography framework, physical/camera-reproducible params over emotion
   adjectives, positive prompts by default.
3. Then it hands the finished prompt to `catimation-image` / `catimation-video`.

So the full loop is: **brainstorm (here, ask_user) → director-orchestrator
(reflect + route + write) → catimation-image / catimation-video (generate)**.
Even when you skip brainstorming for a simple ask, still pass through
`director-orchestrator` before generating — including when YOU generate your own
illustration for an answer.

## Notes

- `ask_user` BLOCKS until the user answers — that's intended; just await it.
- This skill is general-purpose: use it for video, image, or any creative
  decision that's genuinely the user's to make.
- It pairs with `catimation-video` / `catimation-image`: brainstorm here, then
  generate there.
