---
description: 导演模式总调度 — 按 13 维电影摄制框架把镜头/构图/光影/角色一致性技法串成提示词流水线
---

载入并执行 **director-orchestrator** 技能(用 Skill 工具加载 `director-orchestrator`),严格按它的流程走:

1. **STEP 0 反问(强制,不可跳过)**:本次任务涉及 13 维里的哪几维?要加载哪些 `director-*` / `storyboard-*` 子技能(参考 `director-orchestrator/references/skill-routing-map.md`)?素材齐了吗(参考图/角色/上条结果)?目标模型是谁?把第 1、2 条结论简短说给用户听。
2. 逐个加载被路由到的子技能(读其 SKILL.md / references),按需取用其技法细节。
3. 以**物理可复现参数优先于情绪形容词**、**默认只写正向提示词**的原则,输出**结构化文本(非 JSON)**提示词;多镜头时保证连续性。
4. 落地:
   - **图像** → 提示词交 catimation 的 `generate_image` / `generate_images`。
   - **视频** → 把 13 维定位结论交给 **`sd2-pe`(视频与提示词的总兜底/起点)**,用它的八大要素 + 路径 A/B 三段论结构化成 Seedance 2.0 工程化提示词,再交 `generate_video`(详见 `/gen-video`)。
   - 出片后简短确认,不要 `view_image` 自检。

用户的本次诉求在下方;若为空,先问清楚要做什么镜头/画面。

$ARGUMENTS
