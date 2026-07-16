---
description: 生成视频 — 先用 sd2-pe 工程化提示词(总兜底),再 Seedance 2.0 出片
---

出视频时,**一切围绕 `sd2-pe` 展开**:

1. **总起点(必做):载入 `sd2-pe`(Skill 工具加载 `sd2-pe`)**,把用户的想法/草稿/多模态 JSON 走完它的 Step 0→Step 4。仅简单单镜的轻量连续任务走路径 A；复杂、多镜、混合媒介或需展开导演/作品参考任一命中即走路径 B，且 B 条件优先于生成/编辑/延长/组合等任务类型。两条路径都覆盖八大要素、12 项内容和五大必备块,表达形式自由。路径 A 可跳过 `seedance-cinematic-format`;路径 B 加载它。落笔前主动检索核实 2–3 个真实影视参考候选给用户选(Step 3.3)。需求不全先按 sd2-pe Step 0 提问,关键歧义按 Step 3.1 停下确认。
2. **衍生叠加(按需)**:
   - 成套分镜/多事件链 → 先用 `director-orchestrator` 做 13 维 STEP 0 定位,再回到 sd2-pe 覆盖总体设定、镜头流程、风格与约束三组语义；标题、分段与散文形式自由。
   - 模型能力对齐/全能参考配额/爆款体检 → `seedance-video-craft`。
   - 单镜画面问题(光影/演技/调色/去 AI 味)→ 对应 `storyboard-*`。
   - 提示词过长/指令冲突 → `storyboard-video-prompt-optimization`(在 sd2-pe 结构内精简)。
3. **出片**:把 sd2-pe 产出的提示词交 `catimation-video` 的 `generate_video`(默认全能参考);Skill 写作用 `@图片N`/`@视频N`/`@音频N` 顺序引用，工具边界自动归一为无 `@` 形式。
4. 出片后简短确认,**不要自检**。

诉求在下方(可附关键帧/参考路径):

$ARGUMENTS
