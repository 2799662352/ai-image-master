---
description: 应用内出图 — catimation 的 generate_image / generate_images(可选渠道)
---

出图时:

1. 先用 Skill 工具加载 **director-orchestrator** 做 STEP 0 反问与 13 维提示词(开放/高价值需求先 `/brainstorm`)。
2. 加载 **catimation-image**,按其规则出图:
   - 一张 → `generate_image`;多张 → `generate_images`(一次批量,勿逐张调用)。
   - 用户给了图片素材必须放 `referenceImages`(图生图/编辑)。
   - 渠道:**省略 `model` 即跟随用户在 chat composer 选的渠道(默认 VIP)**;仅在有明确理由时覆盖 `model` —— 组图系列(count>1)→ `wan2.7-image-pro`,多参考图融合(≤10 张)→ `doubao-seedream-5-0-pro-260628`,或用户点名的渠道(`custom-imagemodel-gt` 腾讯 image2 / `gemini-3.1-flash-image` Nano2 / `doubao-seedream-5-0-pro-260628` Seedream 5.0 Pro)。
   - `✅ DONE` 即完成,已渲染+落盘;**不要 `view_image` 自检**,简短确认并引用保存路径。

诉求在下方(可附图片路径):

$ARGUMENTS
