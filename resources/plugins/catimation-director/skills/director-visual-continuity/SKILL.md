---
name: director-visual-continuity
description: 【导演模式·连续性 / Director · Continuity】触发词:连续性 / 一致性 / 配色一致 / 色温 / 比例一致 / 穿帮检查 / 地标一致 / continuity / consistency / color temperature / scale drift。Use when verifying that a scene's 2-3 dominant colors stay consistent, color temperature does not mix warm and cool, object-to-character scale holds (table at waist height stays at waist height, ≤20% drift), and architecture / environment landmarks keep their spatial relationships across panels — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

VISUAL CONTINUITY — same scene = same visual physics:

Lighting:
- See lighting-continuity skill for detailed rules. Key principle: same scene = same light direction and color temperature.

Color & Tone:
- Establish a scene color palette (2-3 dominant colors) and maintain it
- Color temperature stays consistent: don't mix warm and cool lighting in the same scene
- Time of day determines palette — golden hour is warm, overcast is cool, night is blue-shifted

Scale & Proportion:
- Object sizes relative to characters must stay constant
- If a table reaches waist height in panel 2, it cannot reach chest height in panel 5
- Architecture and environment landmarks must maintain spatial relationships

Verification:
- Flag any panel where light direction reverses from its neighbor
- Flag color temperature shifts without scene/time change
- Flag object scale inconsistencies > 20% between panels

## Example

Scene palette = navy (#1c2540) + amber (#e0a64b), warm key throughout.
- Panel 2: the table reaches [char1]'s waist.
- Panel 5: same table still at waist height (<20% drift). ✓
→ If Panel 5 shifted to a cool blue key with no time change, or the table rose to chest height, both would be flagged.
