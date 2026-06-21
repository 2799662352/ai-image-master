---
name: catimation-director
description: Use when 写或优化图片/视频提示词、做镜头/景别/运镜/构图/打光/调色、角色一致性与连续性、参考图分析复刻反推,需要导演模式 director-* 工艺技能时。Triggers on director / shot / 镜头 / 构图 / 打光 / 提示词 / 一致性 / 反推 / 运镜.
---

# 导演插件总览(catimation-director · 索引)

本技能是 **catimation-director 插件的入口卡**。本插件 = **导演模式**的 13 个工艺技能。

> ⚠️ 真正干活的是 **`director-orchestrator`**(导演总调度器,像 using-superpowers 一样)。
> **只要任务涉及 图片 / 视频 / 提示词,先载入 `director-orchestrator`**,走它的 STEP 0 强制反问(这镜涉及 13 维里哪几维?要用哪些本地 skill?),由它按需路由到下面的子技能。本卡仅做索引,方便你知道库里有什么。

## 13 个 director-* 子技能(按用途)

| 子技能 | 什么时候用 |
|--------|-----------|
| `director-orchestrator` | **总入口**:13 维摄制框架 + 强制 STEP 0 反问 + 路由,每次涉及图/视频/提示词必先载入 |
| `director-cinematic-composition` | 构图、取景、三分法、景深、前中后景、引导线、焦段、机位 |
| `director-shot-sequence-patterns` | 选镜头型:景别、分镜序列、转场、建立镜头、正反打、动作/情绪镜头 |
| `director-lighting-continuity` | 主光方向、色温、布光、黄金时刻/夜景/霓虹,跨镜光照一致 |
| `director-narrative-flow` | 镜头顺序与节奏、180 度轴线、视线匹配、景别交替、剪辑流 |
| `director-prompt-engineering` | 七字段提示词模板:镜头+灯光+构图+风格,以及负向段 |
| `director-structured-captioning` | 结构化描述、[char] 标签锁外观、省 token(HoloCine 式) |
| `director-anchor-extraction-quality` | 从参考图提取角色锚点(脸/体型/服装/记号),区分相似角色 |
| `director-scene-analysis-depth` | 场景/参考图分析:环境字段、主体清单、风格提取 |
| `director-character-consistency` | 同一角色跨镜不变脸、服装道具一致 |
| `director-visual-continuity` | 配色/色温/比例一致、穿帮检查、地标一致 |
| `director-style-consistency` | 图文风格冲突、材质统一、写实 vs 动画、颗粒一致 |
| `director-anime-quality-boost` | 输出跑偏成厚涂/油画感时,拉回日式动画/赛璐璐质感 |

## 用法

1. 任何图/视频/提示词任务 → **先 `director-orchestrator`**,跟它的 STEP 0 反问与路由。
2. 想自己快速点名某个技法 → 从上表挑对应 `director-*` 载入。
3. 与分镜技法混用时,`director-orchestrator` 会一并串起 `storyboard-*`(见 `catimation-storyboard`)。
4. 提示词写好 → 图像交 `catimation-image`,视频交 `catimation-video`。

## 边界

- 本卡只做**索引**;调度规则、13 维字段表、路由表都在 `director-orchestrator` 及其 references 里。
