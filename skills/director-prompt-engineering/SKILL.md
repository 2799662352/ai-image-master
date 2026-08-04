---
name: prompt-engineering
description: 【导演模式·提示词结构 / Director · Prompt Structure】触发词:提示词结构 / 七字段 / 提示词模板 / 怎么写提示词 / 镜头+灯光+构图+风格 / prompt structure / 7-field / prompt template。Use when 提示词字段乱序、丢字段导致出图不稳,需要一条规范可复现的成品提示词时:按七字段顺序拼装(主体动作 → 角色引用 → 场景 → 镜头相机 → 光照 → 构图 → 风格情绪),120 词内,负向按需补充。
appliesTo: [designAndAssemble]
priority: 1
---

# 导演模式 · 提示词结构(7 字段)

<!-- skill-budget: fast -->

## Overview

把每条提示词按固定 7 字段顺序拼装(主体动作 → 角色引用 → 场景 → 镜头相机 → 光照 → 构图 → 风格情绪),≤120 词,前置重点字段。

## When to Use

- 用:需要一条规范、可复现的成品提示词;字段乱序/丢字段导致出图不稳。
- 不用:多镜连续性/叙事排序(→ continuity / narrative 系列);纯锚点提取(→ anchor-extraction)。

## 落笔前先查运镜知识库(硬性,图片也一样)

第 4 字段(镜头相机)和第 6 字段(构图)不许凭记忆写。**每条提示词落笔前至少查
三次** `search_cinematography_kb`,三次各查一个面,别用同义词把同一个问题问三遍:

1. **术语** — 你打算用的那个机位/运动本身(`dolly in`、`arc`、`low-angle
   pedestal`、`rack focus`…),拿库里的权威写法,而不是「镜头慢慢靠近」。
2. **描述规范** — 这个镜头在结构化描述里该怎么落字(机位高度 / 角度 / 景别 /
   焦点 / 景深 / 主体位置 / 空间层次那套 CHAI 五维)。
3. **范例或修正对** — 找一条同类的专业 caption,或一条 critique/fix 对,照着改
   自己的措辞。修正对尤其值钱:它直接告诉你这类描述通常错在哪。

做动画风格时再加一次 `query_sakuga_dataset`,拿真实的技法标签(smears、
impact_frames、background_animation…)与作画/studio 归属——那些是可核实的名词,
比「作画精良」这种形容词能进提示词。

同一条镜头运动在同一个任务里查过一次就可以复用结论,不必逐张卡重查;但**换了运动
就要重查**。工具没配 key 或不可用时退回联网检索,并在交付里说明这条是未经库校准的。

> 为什么值得这几次往返:「电影感」「镜头很带感」这类词进不了模型,`低机位 35mm
> 前推、焦点从前景手部拉到背景人脸` 才进得去。知识库的作用就是把前者换成后者。

PROMPT STRUCTURE — follow this order for every panel prompt:

1. Subject + Action: "[char1] reaches for a door handle" (use character tags, not full descriptions)
2. Character Reference: use [char1] [char2] tags defined in the global section (never inline full appearance per panel)
3. Scene/Environment: location, weather, time of day
4. Shot Type + Camera: "medium shot, eye-level, 50mm lens"
5. Lighting: direction, quality, color temperature ("warm golden hour side-light from left")
6. Composition: "rule of thirds, subject at left intersection, depth of field blur on background"
7. Style/Mood: art style, color palette, emotional tone

Prompt Hygiene:
- Write in English, present tense, descriptive noun phrases
- Front-load the most important elements (image generators weight early tokens higher)
- Never use subjective words alone ("beautiful", "amazing") — always pair with concrete descriptors
- Maximum 120 words per panel prompt; beyond that generators lose coherence

Negative Prompt(默认正向,按需补充):
- 默认正向描述:画质要求写成正向(sharp focus, correct anatomy, five clear fingers, natural proportions),而非堆"不要…"清单。
- 仅当目标模型有独立负向字段且确需时补充:blurry, deformed, bad anatomy, extra limbs, watermark, text;人像可加 cross-eyed, asymmetric face,建筑可加 impossible geometry。

## Example

Assembled in 7-field order (≤120 words):
[char1] reaches for a brass door handle, leaning in — [char1] — dim Victorian hallway, dusk — medium shot, eye-level, 50mm — warm tungsten side-light from left, soft, 3200K — rule of thirds, subject at left intersection, shallow DoF on background — muted sepia palette, tense, noir mood.
(按需)Negative: blurry, deformed, bad anatomy, extra limbs, watermark, text, cross-eyed.

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 字段乱序、重点放末尾 | 按 7 字段顺序,重要元素前置 |
| 每格内联重描角色外貌 | 用 [char1] 标签引用全局定义 |
| 默认堆负向词 | 默认正向,负向按需补充 |
