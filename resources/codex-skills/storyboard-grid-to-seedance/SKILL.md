---
name: storyboard-grid-to-seedance
description: 用一张多格故事板网格(3×3/4×4/16 格)锁住镜头序列与构图,再让图生视频模型按格子顺序补运动时使用。触发场景:一张图出整套分镜、网格故事板法、grid storyboard、把 GPT Image 故事板喂给 Seedance、@图片整图当顺序参考、舞蹈/动作序列网格、漫画页转视频、试镜网格、把多帧排成一张图做快剪蒙太奇。不概述流程,看到"网格分镜/一张图多镜/storyboard grid/follow the storyboard sequence"等信号即加载。
---

# Storyboard Grid to Seedance（网格故事板 → 图生视频）

## Overview

核心信念:**用一张多格故事板把"镜头顺序 + 构图"在便宜的图像阶段一次性锁死,再让视频模型"按格子顺序"补运动**。图像迭代便宜,视频迭代贵(社区经验:视频消耗约为图像的 10–50 倍),所以先把分镜锁好再进视频,是长序列内容最省成本、最稳连贯的路子。

但有一条**红线**:网格整图是**顺序与构图的参考**,不是最终视频的唯一输入。需要人物/产品稳定时,主输入仍应是干净关键帧(默认用角色大头照+全身照单锚点,也可用角色三视图、产品图),网格图作为"时间轴提示"叠加。把网格整图当唯一视频源,人物和细节会在运动插值里漂移。

> **锚点纪律:** 默认用本 app 人像库的「大头照(正脸无表情)+ 全身照」单锚点;**角色三视图/四视图可作为可选补充**,场景需要时使用。

适用:广告/短剧/MV/动漫 OP/舞蹈/漫画页/游戏概念等"一张图想出一整段顺序镜头"的场景。

## When to Use

**用本 skill:**
- 想用一张 3×3 / 4×4 / 16 格网格图,一次性规划整段镜头顺序再喂视频。
- 已有(或要生成)GPT Image 故事板,要配套的"按顺序执行"的 Seedance 提示词。
- 动作/舞蹈/编舞序列:把连续动作排成网格当动作参考。
- 漫画页 / 多帧蒙太奇 / 试镜网格这类"格子即时间轴"的玩法。

**不用本 skill,改用:**
- 要逐镜连续性受控的完整制片包(角色/场景圣经 + 衔接矩阵 + 剪辑边界矩阵 + 双语提示词)→ `catimation-storyboard-pro` 的 `create-storyboard`。
- 单镜画面问题(光不对/动作不实/角色不一致/构图弱)→ 对应的 `storyboard-*` 技法 skill。
- 端到端成片编排 → `film-studio`。

## Quick Reference

| 网格规格 | 帧数 | 适用时长 | 典型用途 |
|---|---|---|---|
| 6 格(单行/2×3) | 6 | 15s | 品牌宣传、标准短片 |
| 3×3 网格 | 9 | 15–24s | 连续动作、最稳的入门法 |
| 4 列 × N 行(8 格) | 8 | 30s | 编辑式分镜、成本控制 |
| 3×4 网格 | 12 | 30s+ | 奢侈广告、快剪蒙太奇 |
| 4×4 网格 | 16 | 35–50s | 舞蹈/编舞/长序列(16 帧供插值) |

**分镜数量参考(来自社区两步广告流):** 15s→4–5 镜(3–4s/镜);30s→8–10 镜(3s/镜);60s→15–18 镜(3–4s/镜)。

**关键句(决定成败):** Seedance 提示词里必须出现 `follow the storyboard sequence of the [N] reference frames` 这类指令——它告诉模型"把格子的位置当时间轴,不是当单张构图"。

## 方法 ① · 出网格故事板的 GPT Image 提示词配方

让一张图同时承担"9/12/16 个关键帧"。配方要点:

- **声明网格**:`Create a storyboard in a [3×3 / 4×4 / 4-column] grid format`(或 `Output as a single image`)。
- **声明阅读顺序**:`left-to-right, top-to-bottom reading order`——这是后面"格子=时间轴"的前提。
- **每格 = 镜别 + 动作**:`Each panel: [shot type] + [action description]`。
- **锁场景与角色**:`Consistent character design and scene across all panels`;在提示词开头固定 `Scene setting: [location], [time], [lighting direction], [fixed background]. Maintain unchanged across all panels.`
- **去干扰**:需要干净关键帧时加 `No text labels, no panel borders`;编辑式排版则反之(每格配简短分镜注释能给更强叙事提示)。

**通用网格模板(可填):**
```
Create a [N]-panel storyboard grid for a [length]-second [genre] film:
- [C] columns × [R] rows, left-to-right, top-to-bottom reading order
- Each panel: [shot type] + [action description]
- Location: [setting], Time: [day/night], Mood: [atmosphere]
- Consistent character design and scene across all panels
- No text labels, no panel borders
Output as a single image.
```

逐格控制力越强,跟随越准:长序列(舞蹈/编舞/烹饪)用"带步骤名/带时间戳"的镜头表(如 `[0-2s] Top-down shot: …`),再据此出网格。

## 方法 ② · 整图 → Seedance 的"按序执行"衔接提示词

让视频模型把整张网格读成时间轴,而不是一张拼贴构图:

- **指明参考与角色**:`@image1` 为角色锚点(默认大头照+全身照,也可用角色三视图等干净关键帧),`@image2`(或同一张)为故事板网格。
- **下达顺序指令**:`Follow the storyboard sequence of the [N] reference frames in image1/2`,`match each panel's composition, framing, and action`,`keep transitions smooth`。
- **锁连续性**:`preserve character identity / lighting / pacing`,`no new shots, no reordering`。
- **末态与负面**:写清结尾定格状态 + 负面约束(`no pose popping, no animation snapping, physically coherent transitions`)。

**通用序列提示词(可填):**
```
Use this storyboard to generate a video. Follow the scene order strictly (1→N),
one shot per panel, keep transitions smooth, preserve character identity and
cinematic lighting/pacing. No new shots, no reordering.
[Add visual style: era / film stock / palette / mood.]
```

> 两步控制系统:Reference A 锁人物身份,Reference B(网格)锁镜头顺序与视觉推进。视频模型的任务是"翻译"故事板成连续运动,不是另起炉灶。

## 方法 ③ · 拆格落干净关键帧再喂视频的纪律

网格法虽稳,但"整图当唯一视频源"会让精细细节(人脸/Logo/纹理)在插值中被改写。纪律:

1. **先逐格审稿**:在图像阶段把每一格生成/重绘到满意(分镜先行=成本控制的核心),锁定后再进视频。
2. **关键人物/产品镜**:主输入用干净关键帧,网格作为顺序提示叠加;产品镜加 `keep the product appearance completely unchanged, camera movement only, no rotation`。
3. **单段 ≤15s、单格动作简单**:片段越短、单格内容越简单,动作越准、漂移越少。
4. **提示词宁短勿长**:Seedance 更看重方向性清晰度而非穷举细节——写运动意图,别堆场景细节。
5. **最终经 sd2-pe 工程化**:无论方法①②产出的视频提示词,落地前都交 `sd2-pe` 做工程化再生成。

## Common Mistakes

| 错误 | 纠正 |
|---|---|
| 把网格整图当最终视频的唯一输入 | 整图只作顺序/构图参考;人物/产品稳定靠干净关键帧主输入 |
| 一格里塞多个动作 | 一格一镜一动作;复杂动作拆成相邻格 |
| 提示词不写格间顺序 | 必带 `follow the storyboard sequence … 1→N`,声明阅读顺序 |
| 用固定时长粗暴均分 | 按镜别/动作定时(参考数量表),关键镜留够秒数 |
| 长提示词堆满场景细节 | 短而清的运动意图优先;细节交给关键帧 |
| 跳过 sd2-pe 直接生成 | 视频提示词最终必经 `sd2-pe` 工程化 |
| 网格未逐格审稿就进视频 | 先在便宜的图像阶段锁定每一格,再做昂贵的视频渲染 |

## 何时调用其他 skill / 参考

- **STEP 0 反问**:画幅/时长/受众/风格未定 → 先用 `director-orchestrator`。
- **视频提示词工程化**:产出的 Seedance 提示词 → 交 `sd2-pe`。
- **要完整制片包**(圣经/衔接矩阵/剪辑边界/双语提示词)→ `catimation-storyboard-pro` 的 `create-storyboard`。
- **逐镜工艺深填**:
  - 9 维度逐项填充(景别/机位/灯光/调色/氛围/画面/台词/音效/备注)→ `references/seedance-9dim-shot-table.md`
  - 调色 LUT 参数 → `references/lut-aesthetics.md`
  - Seedance 出片 6 铁律 → `references/seedance-6-rules.md`
  - 抽象情绪→生理动作翻译 → `references/emotion-physiology.md`
