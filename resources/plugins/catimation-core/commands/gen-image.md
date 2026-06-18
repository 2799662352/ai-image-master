---
description: 应用内出图 — catimation 的 generate_image / generate_images(可选渠道)
---

出图时:

1. 先用 Skill 工具加载 **director-orchestrator** 做 STEP 0 反问与 13 维提示词(开放/高价值需求先 `/brainstorm`)。
2. 加载 **catimation-image**,按其规则出图:
   - 一张 → `generate_image`;多张 → `generate_images`(一次批量,勿逐张调用)。
   - 用户给了图片素材必须放 `referenceImages`(图生图/编辑)。
   - 渠道默认 `gpt-image-2-vip`;用户点名时可选 `custom-imagemodel-gt`(腾讯 image2)或 `wan2.7-image-pro`(万相 2.7 pro)。
   - `✅ DONE` 即完成,已渲染+落盘;**不要 `view_image` 自检**,简短确认并引用保存路径。

诉求在下方(可附图片路径):

$ARGUMENTS
