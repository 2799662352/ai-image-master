---
name: director-shot-sequence-patterns
description: 【导演模式·镜头 / Director · Shots】触发词:镜头 / 景别 / 分镜序列 / 转场 / 建立镜头 / 正反打 / 动作镜头 / 情绪镜头 / shot / shot sequence / cut / dolly / establishing / shot-reverse-shot。Use when picking the shot pattern that matches the scene's dramatic intent — Establishing (wide → medium → close-up → detail), Dialogue (two-shot → shot-reverse-shot → reaction → re-establish), Action (wide → medium action → close-up impact → wide aftermath), Emotional (medium → close-up → extreme close-up → release) — and labeling every transition ("cut to", "dolly in", "match cut", "time skip") — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

# 导演模式 · 镜头序列模式

## Overview

按戏剧意图选镜头模式(建立 / 对话 / 动作 / 情绪),并给每个转场打标("cut to" / "dolly in" / "match cut" / "time skip")。

## When to Use

- 用:需要现成的景别推进套路、转场标注;一场戏的镜头怎么排。
- 不用:跨镜连续性规则(180°/视线匹配)与整体叙事节奏 → 改用 `director-narrative-flow`。

SHOT SEQUENCE PATTERNS — select the pattern that matches the scene's dramatic intent:

Establishing Sequence (introduce location/mood):
  Wide → Medium → Close-up → Detail
  Example: city skyline → street level → character face → object in hand

Dialogue Sequence (two+ characters talking):
  Medium two-shot → Shot-reverse-shot close-ups → Reaction shot → Wide re-establish
  Example: both at table → speaker A face → speaker B face → B's surprised expression → pull back

Action Sequence (fight, chase, conflict):
  Wide establish → Medium action → Close-up impact → Wide aftermath
  Example: arena overview → sword swing → blade clash detail → both fighters apart

Emotional Sequence (internal drama, revelation):
  Medium neutral → Close-up emotion → Extreme close-up peak → Medium release
  Example: character standing → eyes widen → single tear → character turns away

Transition Rules:
- Never stack 3+ panels at the same scale (avoid monotony)
- Each panel MUST state its relationship to the previous: "cut to", "dolly in", "match cut", "time skip"
- Opening panel is always the widest; closing panel returns to medium or wide for closure

## Example

Emotional pattern:
Medium neutral — [char1] opens a letter (cut to) → Close-up — eyes scan the lines, brow tightens (dolly in) → Extreme close-up — a single tear forms (match cut) → Medium — [char1] turns to the window (release).
→ No 3 panels at the same scale; every transition is labeled.

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 连排 3 个同景别 | 交替景别制造节奏 |
| 转场不标注 | 每格标明与上格关系 |
| 模式不配戏剧意图 | 按建立/对话/动作/情绪选模式 |
