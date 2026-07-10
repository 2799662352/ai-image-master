# catimation-director 家族目录(按症状挑技法)

本目录是数据文件,由索引卡 `SKILL.md` 指引按需 Read;挑中哪个子技能就只加载哪个。

## 13 个 director-* 子技能(按用途)

| 子技能 | 什么时候用 |
|--------|-----------|
| director-orchestrator | 总调度:13 维摄制框架 + STEP 0 反问 + 技能路由(由编排层负责加载,叶子技法不回调它) |
| director-cinematic-composition | 构图、取景、三分法、景深、前中后景、引导线、焦段、机位 |
| director-shot-sequence-patterns | 选镜头型:景别、分镜序列、转场、建立镜头、正反打、动作/情绪镜头 |
| director-lighting-continuity | 主光方向、色温、布光、黄金时刻/夜景/霓虹,跨镜光照一致 |
| director-narrative-flow | 镜头顺序与节奏、180 度轴线、视线匹配、景别交替、剪辑流 |
| director-prompt-engineering | 七字段提示词模板:镜头+灯光+构图+风格,以及负向段 |
| director-structured-captioning | 结构化描述、[char] 标签锁外观、省 token(HoloCine 式) |
| director-anchor-extraction-quality | 从参考图提取角色锚点(脸/体型/服装/记号),区分相似角色 |
| director-scene-analysis-depth | 场景/参考图分析:环境字段、主体清单、风格提取 |
| director-character-consistency | 同一角色跨镜不变脸、服装道具一致 |
| director-visual-continuity | 配色/色温/比例一致、穿帮检查、地标一致 |
| director-style-consistency | 图文风格冲突、材质统一、写实 vs 动画、颗粒一致 |
| director-anime-quality-boost | 输出跑偏成厚涂/油画感时,拉回日式动画/赛璐璐质感 |

## 交接

- 与分镜技法混用时,由编排层一并串起 storyboard-* 家族(见 catimation-storyboard 插件)。
- 提示词写好 → 图像交 catimation-image,视频交 catimation-video。
