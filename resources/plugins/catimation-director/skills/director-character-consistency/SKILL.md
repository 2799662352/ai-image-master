---
name: director-character-consistency
description: 【导演模式·角色一致性 / Director · Character Consistency】触发词:角色一致性 / 同一人物 / 跨镜一致 / 不变脸 / 服装道具不变 / 角色稳定 / character consistency / same character。Use when the same character must appear identical across panels — anchored by face / build / outfit / markers, with hair / outfit / props unchanged across cuts and relative skin-tone descriptors used instead of absolute color — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

CHARACTER ANCHOR FORMAT — every character MUST include ALL of:

1. Face: skin tone, face shape, eye color, hair color + style + length
2. Build: height relative to scene, body type (slim/athletic/heavy)
3. Outfit: exact garments top-to-bottom, colors (use hex if possible), patterns, accessories
4. Markers: scars, tattoos, glasses, jewelry, props — anything unique

Consistency Checks:
- Hair color and length must NOT change between panels unless story demands it
- Outfit remains identical across all panels in the same scene
- If a character holds a prop in panel N, the prop must be visible or accounted for in panel N+1
- Lighting may change skin tone perception — anchor by relative tone, not absolute color

Verification Scoring:
- Deduct 2 points per character with missing anchor fields
- Deduct 3 points per cross-panel inconsistency (hair, outfit, prop continuity)
- 锚点字数下限以 `director-anchor-extraction-quality` 为准(≥40 词);低于则判为过于模糊、不可复现。

## Example

[char1] anchor: medium skin, round face, green eyes, copper hair in a high ponytail; ~165cm slim; olive field jacket (#5b5e3a), grey tee, black jeans, white sneakers; small gold stud earrings, red canvas backpack.
- Panel 2 (close-up): ponytail + gold studs visible.
- Panel 5 (wide): same olive jacket + red backpack still worn.
→ Hair color/length, jacket, and backpack unchanged across cuts = consistent. (A panel that switched the jacket to blue or dropped the backpack would be flagged.)

## 角色从无到有时:先建档案再取锚点

本 skill 管「已有角色的跨镜一致性」。当角色**还没立起来**(没有可锚定的外貌/性格/弧光)时,先用 `references/character-design-profiles.md` 走「信息收集 → 档案构建 → 编剧/美术/选角三版」把角色设计出来,其中**美术版**的字段可直接映射成上面的 CHARACTER ANCHOR(Face/Build/Outfit/Markers)。

默认用**单锚点人像库**:大头照(正脸无表情)+ 全身照;三视图/四视图可作可选补充,**慎用**(多视图易触发 ID 漂移与双胞胎)。需要多视图设计稿 / 360° 转台 / 六表情模组时,见 `references/character-multiview-supplement.md`(含四视图合图 A-pose+三点布光的中英提示词模板,已适配本 app 工具)。

**何时改用 `director-anchor-extraction-quality`:** 需要**从参考图新提取**锚点、把握提取质量(≥40 词、相似角色区分、遮挡标 [inferred])时,用 anchor-extraction;本 skill 负责锚点**确定后跨镜复用与一致性校验**。
