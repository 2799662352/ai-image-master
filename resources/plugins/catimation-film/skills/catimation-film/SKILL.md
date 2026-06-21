---
name: catimation-film
description: Use when 做一整部片子/短片/宣传片/微电影/MV/剧集/预告片,要把一个想法或故事一条龙做成成片,或需要写剧本、分镜成片、批量出图出视频再拼接交付时。Triggers on film / movie / 短片 / 宣传片 / 预告片 / 剧本 / 成片 / trailer / screenplay.
---

# 电影插件总览(catimation-film · 索引 + 路由器)

本技能是 **catimation-film 插件的入口卡**。当任务是"做一整部片子"(短片 / 宣传片 / 微电影 / MV / 剧集 / 预告片),先从这里路由,**主力是 `film-studio` 编排器**——其余三个是它在特定阶段调用的专项技能。

> 像 using-superpowers:判断到了哪个阶段,就加载那个阶段对应的子技能去做。

## 子技能与触发时机

| 子技能 | 角色 | 什么时候加载 |
|--------|------|--------------|
| `film-studio` | **端到端总编排器(制片导演)** | 任何"把一个想法/故事一条龙做成成片"的需求 —— 概念 → 剧本 → 分镜镜头表 → 角色/场景设定锚点 → 逐镜出图 → 图生视频(Seedance 2.0)→ 配音配乐 → ffmpeg 拼接 → 爆款体检交付,每阶段带审批门(gate)。**这是本插件的主入口,先载入它。** |
| `screenwriter` | 编剧 / 剧作 | 需要开发剧情、分场、写场景与对白、节拍表、改稿、估算/删减片长、塑造人物世界观(McKee/Campbell/Aristotle 方法论,好莱坞格式、可双语) |
| `trailer-plan-generator` | 预告片策划 | 已有剧本/故事梗概,要产出 5 个 90 秒专业预告片方案 |
| `animation-craft` | 日式动画作画 | 做动画短片/绝コンテ/アニマティック、AI 动画镜头、角色芝居、运镜与节奏(タメツメ/コマ打ち 等作画技法),或写图生视频(i2v)镜头 prompt |

## 用法(典型流水线)

1. **整片项目** → 直接载入 `film-studio`,跟着它的阶段门(gate)走;它会在每一步调用本 app 已装的工艺 skill。
2. **只缺剧本** → `screenwriter` 先把剧本/分场/对白写好,再回 `film-studio` 进入分镜与出片。
3. **要做预告片** → 剧本就绪后用 `trailer-plan-generator` 出方案。
4. **动画风格** → 涉及作画/动画质感时载入 `animation-craft`。
5. 逐镜出图/出视频阶段,镜头语言统一回 `director-orchestrator`(13 维框架),图像交 `catimation-image`,视频交 `catimation-video`,拼接用 `ffmpeg-win`。

## 边界

- 本卡只做**索引 + 路由**;成片流程的阶段门、设定锚点、交付标准都在 `film-studio` 里,需要时去读它。
- 别在这里重抄编剧/作画技法 —— 路由到对应子技能执行。
