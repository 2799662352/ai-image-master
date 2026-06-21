---
name: catimation-storyboard
description: Use when 写或优化分镜/图片/视频提示词、做镜头语言、画面反推或复刻爆款、修复 AI 感/塑料感/摆拍/假笑、光影混乱、调色、多角色失控、前景遮挡、伪透视、过审改写,需要从 catimation-storyboard 插件的 29 个 storyboard-* 工艺技能里挑对的来用时。Triggers on storyboard / shot / prompt / 分镜 / 提示词 / 反推 / 复刻 / 打光 / 调色 / 演技 / 真实感 / AI感.
---

# 分镜插件总览(catimation-storyboard · 索引 + 路由器)

本技能是 **catimation-storyboard 插件的入口卡**。它本身不教技法,而是像 `using-superpowers` 那样:**先判断你这次的画面/提示词问题属于哪一类,再加载对应的 `storyboard-*` 子技能去做。** 宁可多加载一个,也不要凭记忆硬写。

> 规则:只要有 1% 可能用得上某个 `storyboard-*` 子技能,就去加载它(读它的 SKILL.md)。加载后发现不合适,丢掉即可。
> 写多镜/导演级镜头时,优先回到 **`director-orchestrator`** 走 STEP 0 反问,它会把 director-* 与 storyboard-* 串成一条流水线;本卡用于"我已知要用分镜技法,想快速找到对的那几个"。

## 先按问题归类,再按需加载

### A. 画面基础规范(写每个镜头都可能用)
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-visual` | 一个镜头要写清物理打光、镜头规格(焦段/光圈)、Z 轴前中后景、色彩层级 |
| `storyboard-structure` | 把镜头定格成"峰值张力的瞬间抓拍 / 单一核心动作" |
| `storyboard-style` | 硬性配色分解(主色+点缀 hex ≥7:3)、光源类型、阴影占比 |
| `storyboard-physics` | 人体与运动只用物理量(角°/位移cm/速度、眉瞳 mm)描述 |

### B. 让人物/画面"像真的"(去 AI 感、塑料感、摆拍)
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-live-character-realism` | 角色好看但假、空洞眼神、图库素材感 → 注入活人感 |
| `storyboard-character-acting` | NPC 感、假笑、面无表情流泪、用力过猛的演技问题 |
| `storyboard-character-motivation` | 人物像站桩/雕塑 → 改写成"因某事自然行动 + 连续微反应" |
| `storyboard-time-words` | 画面像死物/蜡像 → 用时间词(刚结束/即将/进行中)注入因果与生命 |
| `storyboard-robustness-breaking` | 太模板化/过度稳定 → 可控失稳,获得松弛真实的高级感 |

### C. 空间 / 镜头 / 光影 / 调色
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-foreground-occlusion` | 真空感/壁纸感/证件照感 → 前景遮挡建立机位与 Z 轴 |
| `storyboard-pseudo-perspective` | 平面感 → 伪透视/空气透视/尺度反差造强纵深 |
| `storyboard-shot-emotion-matching` | 景别乱用、广角/长焦与景深逻辑打架 → 镜头语言匹配情绪 |
| `storyboard-light-reconstruction` | 光影混乱、大平光、塑料高光 → 局部打光/重构光源 |
| `storyboard-color-grading-control` | HEX 色卡、电影调色、低饱和胶片感、色彩一致性 |
| `storyboard-director-thinking` | 从"提示词工具人"升级为导演:场面调度、Z 轴、动机光源、A/B-roll |

### D. 创意 / 蒙太奇 / 减法
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-creative-imagination` | 打破物理定律、时间失控、镜头变角色 → 想象力 |
| `storyboard-emotional-montage` | 用蒙太奇表达情绪(库里肖夫、客观对应物、特写放大) |
| `storyboard-feature-collapse` | 主动压缩背景细节、边缘衰减、梦核/写意、聚焦情绪 |

### E. 多角色 / 对白 / 配音
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-multi-character-control` | 两个及以上角色:动作失控、互相污染、分阶段动作接力 |
| `storyboard-dialogue` | 剧本给了角色名与台词,必须逐字提取不许瞎编 |
| `storyboard-voice-control` | 控制语气/语速/音色/台词节奏与开口真实感 |
| `storyboard-audio` | 每镜三层音频(配乐 A1 / 音效 A2 / 配音 A3)用物理语言写清 |

### F. 反推 / 复刻 / 风格提取
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-scene-breakdown` | 把爆款视频/截图/描述拆成可复刻的时间切片+机位+动作+光影 |
| `storyboard-kinematic-reverse-engineering` | 反推运动学:三帧分析、相机运动结构、运动矢量、速度 |
| `storyboard-style-extraction-logic` | 从参考图提取可复用的风格逻辑(风格 DNA / 四维模型) |
| `storyboard-grid-to-seedance` | 一张多格网格故事板锁镜序,再让图生视频按格子补运动 |

### G. 提示词产出 / 过审 / 负向
| 子技能 | 什么时候加载 |
|--------|--------------|
| `storyboard-video-prompt-optimization` | 视频提示词太长/堆砌/首帧权重被忽视/动作稀释 → 优化 |
| `storyboard-negative-control` | 负向提示词、--no、画质机制误解;含 Seedance 2.0 合规改写 |
| `storyboard-dodge` | 文本可能触发内容过滤 → 用物理/力学矢量正向改写规避 |

## 用法

1. 看清这次卡在 A–G 哪一类(常常跨多类)。
2. **逐个加载**对应子技能(读其 SKILL.md / references),用它的真实技法词填字段——别凭记忆。
3. 提示词产出走**结构化文本(绝不 JSON)**,物理可复现参数优先于情绪形容词;默认只写正向。
4. 写好后:图像交 `catimation-image`,视频交 `catimation-video`;多镜/连续性回 `director-orchestrator` 统筹。

## 边界

- 本卡只做**索引 + 路由**,技法细节在各子技能里,需要时去读,别重抄。
- 不确定的技法词先联网查证再落笔。
