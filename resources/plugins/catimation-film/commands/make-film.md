---
description: 端到端制片 — 用 film-studio 把一个想法一条龙做成成片(带审批门)
---

载入 **film-studio** 技能(用 Skill 工具加载 `film-studio`),作为制片导演按门控流水线推进:

```
概念G0 → 剧本G1 → 分镜G2 → 设定锚点G3 → 出图G4 → 图生视频G5 → 配音G6 → 拼接G7 → 交付G8
```

规则:
- **智能路由**:检测用户已给的输入(想法/剧本/分镜/角色设定/关键帧/片段),跳到对应阶段。
- **绝不跳门**:每道门产出成果 → 给用户看 → 确认后再前进。
- 每步**调用本地工艺 skill**(screenwriter / storyboard-* / director-* / sd2-pe / seedance-video-craft / ffmpeg-win / animation-craft),不重写它们。
- **G4 出图前先过 `director-orchestrator` STEP 0**。
- **G5 图生视频:每条镜头提示词都必须先经 `sd2-pe`(视频与提示词的总兜底/起点)结构化**(八大要素 + 路径 A/B 三段论 + 兜底包),再交 `generate_video`;成套分镜先用 director-orchestrator 做 13 维定位,落地仍回到 sd2-pe。
- 角色/场景锚点(G3)必须逐字下传到每条出图/视频 prompt。

诉求在下方:

$ARGUMENTS
