---
description: 制片包生成 — 把剧本/概念做成连续性受控的 Image2+Seedance 出片素材包
---

做「制片包/分镜制片」时:

1. 先用 Skill 工具加载 **director-orchestrator** 做 STEP 0 反问(画幅/时长/受众/风格未定先问)。
2. 用 Skill 工具加载 **create-storyboard**,按其标准流程产出:圣经 → shot cards → 衔接矩阵 → 剪辑边界矩阵 → 双语 Image2 提示词 → Seedance 逐镜提示词 → 剪辑/回退清单。
3. 视频提示词最终交 **sd2-pe** 工程化(覆盖八大要素、12 项内容与五大必备块)后再生成;制片包多镜任务加载 `cinematic-prompt-format`,但输出标题/分段形式自由;每段 Seedance ≤ 15s,整图不作唯一视频输入。

诉求在下方:

$ARGUMENTS
