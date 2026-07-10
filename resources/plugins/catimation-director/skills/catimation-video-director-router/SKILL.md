---
name: catimation-video-director-router
description: >-
  【症状修复速查 / Symptom Repair Router】把用户对已生成结果的自然语言"症状"
  (太假 / AI味 / 塑料 / 像壁纸 / 没电影感 / 动作怪 / 站桩 / 像NPC / 假笑 /
  风格跑了 / 光很平 / 糖水 / 混脸)映射到对症的 director-* / storyboard-*
  技法技能。Use ONLY when 用户反馈生成结果存在明确问题、要求返工修复,或需要
  从素材(图/视频/剧本/音频)里诊断质量缺陷;常规生成前的路由由唯一入口
  (catimation-image / catimation-video)的分级与症状表负责,不经过本技能。
---

<!-- skill-budget: standard -->

# 症状修复速查表(返工诊断用,不是生成前闸门)

**本技能不生成任何东西,也不再是每次生成的前置门。** 它是一张**症状 → 技法**的
翻译表:当用户对结果不满("太假""不像电影""动作怪""站桩""风格跑了")或要求
返工时,把症状翻译成该加载的专业技能,给出针对性修复方向,然后**交回上游入口**
(catimation-image / catimation-video)带改进点重生成。它不重跑任务分级,
不重新编排流程,不把任务再转交其它调度器。

为什么需要它:很多专业技能的触发词是导演/技术人员的话(前景遮挡 / 伪透视 /
特征塌陷 / 运动学反推),而用户说的是**症状**(太假 / 像壁纸 / 动作怪)。
这层翻译让返工修复能稳定命中对症技能。

## 诊断前:先亲自看结果和素材(素材优先于文字)

修复路由的入口不是"用户说了什么",是"结果实际呈现了什么"。选技能之前:

```
1. 读用户的不满描述
2. 亲自看结果:图片→view_image;视频→抽 3×3 宫格看 + 需要时 understand_video;
   剧本→读全文;音频→ffprobe
3. 从结果里提取「问题」(用户没点名的问题也要注意到)
4. 按「症状表 + 观察事实」挑对症技能(通常 1–3 个,不是全家桶)
5. 给出针对性改进点(哪个技法的哪个字段没落地),交回上游入口重生成
```

## 症状 → 对症技法(自然语言症状翻译表)

| 用户说的(自然语言症状) | 对症技法(plain-text 名称,挑 1–3 个) |
|---|---|
| 太假 / AI味 / 塑料 / 油 / 空洞 / 没灵魂 / 像模特 | storyboard-live-character-realism · storyboard-character-acting |
| 摆拍 / 站桩 / 像NPC / 没事做 / 没表演 | storyboard-character-motivation · storyboard-character-acting |
| 太干净 / 像壁纸 / 没电影感 / 没纵深 / 太平 | storyboard-foreground-occlusion · storyboard-pseudo-perspective · director-cinematic-composition |
| 动作怪 / 武打不对 / 打击感差 / 身体乱 / 飘 | storyboard-physics · storyboard-kinematic-reverse-engineering |
| 风格不像 / 不像某电影 / 太艳 / 太网红 / 调性不对 | storyboard-style-extraction-logic · storyboard-color-grading-control · director-style-consistency |
| 光不对 / 廉价 / 大平光 / 糖水 / 脸油 / 塑料高光 | storyboard-light-reconstruction · director-lighting-continuity |
| 多角色乱 / 混脸 / 两个人互相污染 | storyboard-multi-character-control · director-character-consistency |
| 情绪不高级 / 假哭 / 太直白 / 用力过猛 | storyboard-emotional-montage · storyboard-character-acting |
| 画面太满 / 背景抢 / 主体不突出 | storyboard-feature-collapse · director-cinematic-composition |
| 太模板 / 太稳 / 太完美 / 不够松弛 | storyboard-robustness-breaking |
| 画面像死的 / 没生活感 / 没故事 | storyboard-time-words · storyboard-structure |
| 脑洞 / 更有创意 / 别普通 / 奇观 / 魔幻 | storyboard-creative-imagination |
| 提示词太长 / 权重被稀释 / 首帧被改 | storyboard-video-prompt-optimization |
| 「不像《某电影》」/ 复刻走样 / 时代服化道不对 | codex-research-grounded-prompting(先查证权威参考再改写) |

## 素材观察 → 补充触发(用户没点名也要注意)

看结果/素材时暴露的问题,主动补进修复方向:

- 人物空洞/站桩 → live-character-realism + character-motivation
- 画面无前景/像壁纸 → foreground-occlusion
- 光源混乱/大平光/塑料高光 → light-reconstruction
- 构图平/没纵深 → cinematic-composition + pseudo-perspective
- 色彩偏离目标风格 → color-grading-control + style-extraction-logic
- 身份漂移(脸/服装变了) → character-consistency + anchor-extraction-quality
- 参考动作/运镜没复现 → kinematic-reverse-engineering
- 多镜连续性断裂 → visual-continuity + narrative-flow

## 修复输出:针对性改进点(不是泛泛"优化一下")

给上游入口的返工指令必须具体到**技法 + 字段**,例如:

```
症状:人物站桩、像 NPC(用户原话「太假」)
观察:九宫格 2/5/8 格人物姿态完全一致,无重心变化;眼神直视镜头无对象
对症:storyboard-character-motivation + storyboard-live-character-realism
改进点:prompt 补「画外剑风触发侧身半步、重心右移;眼神先扫向声源再收回;
        衣袖随呼吸微幅起伏;皮肤哑光漫反射」
```

修复方向给出后,由上游入口按其分级预算加载对症技能、重写 prompt、重生成
(重生成次数上限与 QA 分级都由上游把守)。

## 边界

- 只做「症状 → 技法」翻译与返工诊断;不做任务分级、不做生成前强制路由、
  不产出"必载套餐"。
- 常规生成(第一次出图/出视频)不经过本技能——那是上游入口分级与症状表的事。
- 跨插件技能加载不到(用户没装该兄弟插件)就就地应用其原则并继续,不阻塞不报错。
