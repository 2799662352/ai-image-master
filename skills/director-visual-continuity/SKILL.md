---
name: visual-continuity
description: 【导演模式·连续性 / Director · Continuity】触发词:连续性 / 一致性 / 配色一致 / 色温 / 比例一致 / 穿帮检查 / 地标一致 / continuity / consistency / color temperature / scale drift。Use when 同场景多格配色乱、冷暖混用、物体相对人物比例漂移(桌子从齐腰变齐胸)、地标空间关系穿帮时:锁 2-3 主色、色温只随时段变、比例漂移控制在 20% 内。
appliesTo: [verifyConsistency]
priority: 2
---

# 导演模式 · 视觉连续性

<!-- skill-budget: fast -->

## Overview

同一场景 = 同一套视觉物理:配色(2–3 主色)、色温不混冷暖、物体相对人物比例稳定(≤20% 漂移)、地标空间关系保持。

## When to Use

- 用:多格/多镜同场景的配色、色温、比例、地标一致性校验与穿帮排查。
- 不用:只查光源方向/色温细节(→ `director-lighting-continuity`);镜头排序(→ narrative / shot 系列)。

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

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 每格各调一套配色 | 锁定 2–3 主色全程保持 |
| 无时间变化却混冷暖 | 色温只随时段动 |
| 物体比例随手放 | 相对人物比例 ≤20% 漂移 |
