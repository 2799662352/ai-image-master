---
description: 分镜画面打磨 — 按需调用 storyboard-* 技法把单镜/成套镜头写成高质量提示词
---

写镜头提示词时:

1. 先用 Skill 工具加载 **director-orchestrator** 做 STEP 0 反问与 13 维定位(成套镜头尤其必要)。
2. 根据画面问题,按需加载相关 **storyboard-*** 技法 skill(用 Skill 工具),例如:
   - 光影乱/塑料感 → `storyboard-light-reconstruction`
   - 摆拍/假笑/NPC 感 → `storyboard-character-acting` / `storyboard-character-motivation`
   - 平面感/没纵深 → `storyboard-pseudo-perspective` / `storyboard-foreground-occlusion`
   - 调色/色彩一致 → `storyboard-color-grading-control`
   - 多角色失控 → `storyboard-multi-character-control`
   - 默认网红脸/脏纹理 → `storyboard-negative-control`
   - 物理/人体结构 → `storyboard-physics`
   - 对白/配音 → `storyboard-dialogue` / `storyboard-voice-control`
3. 以物理可复现参数、默认正向提示词,输出结构化文本提示词。

诉求在下方:

$ARGUMENTS
