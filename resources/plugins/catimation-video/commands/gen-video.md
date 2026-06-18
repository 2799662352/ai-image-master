---
description: 生成视频 — 先用 sd2-pe 工程化提示词(总兜底),再 Seedance 2.0 出片
---

出视频时,**一切围绕 `sd2-pe` 展开**:

1. **总起点(必做):载入 `sd2-pe`(Skill 工具加载 `sd2-pe`)**,把用户的想法/草稿/多模态 JSON 走完它的 Step 0→Step 4,产出工程化提示词(八大要素 + 路径 A/B + 兜底包)。需求不全先按 sd2-pe Step 0 提问,关键歧义按 Step 3.1 停下确认。
2. **衍生叠加(按需)**:
   - 成套分镜/多事件链 → 先用 `director-orchestrator` 做 13 维 STEP 0 定位,再回到 sd2-pe 路径 B 三段论落地。
   - 模型能力对齐/全能参考配额/爆款体检 → `seedance-video-craft`。
   - 单镜画面问题(光影/演技/调色/去 AI 味)→ 对应 `storyboard-*`。
   - 提示词过长/指令冲突 → `storyboard-video-prompt-optimization`(在 sd2-pe 结构内精简)。
3. **出片**:把 sd2-pe 产出的提示词交 `catimation-video` 的 `generate_video`(默认全能参考);素材按 `@图片N`/`@视频N`/`@音频N` 顺序引用。
4. 出片后简短确认,**不要自检**。

诉求在下方(可附关键帧/参考路径):

$ARGUMENTS
