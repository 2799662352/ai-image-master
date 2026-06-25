---
name: catimation-core
description: Use when 在 CATIMATION 应用里要生成图片/出图/画一张、管理人像库或素材库、记住某个角色或场景以保持一致性、或需求模糊高价值要先定方向时。Triggers on image / 出图 / 画一张 / 生成图片 / 人像库 / 素材库 / 角色一致性 / brainstorm / 定方向.
---

# 核心插件总览(catimation-core · 索引 + 路由器)

本技能是 **catimation-core 插件的入口卡**。这三个子技能是 CATIMATION 桌面应用的**核心能力底座**,几乎所有图片/视频工作都会用到其中之一。像 `using-superpowers` 一样:判断需要哪种核心能力,就加载对应子技能。

## 子技能与触发时机

| 子技能 | 能力 | 什么时候加载 |
|--------|------|--------------|
| `catimation-image` | **首选出图器** | 任何"生成图片 / 出图 / 画一张"的需求 —— 用应用内 `generate_image` / `generate_images`,**优先于内置 imagegen**(后者在 Windows 不可用且不持久化结果) |
| `catimation-portrait-library` | 人像库 / 素材库 | 管理可去重持久化的 图片/视频/音频 资产;"记住这个角色/场景"、复用同一角色保一致性、整理/检索素材时 |
| `catimation-brainstorm` | 卡片式头脑风暴 | 需求模糊或高价值(「做个宣传片」)时,用 `ask_user` 可点选卡片**一次一问**帮用户定方向,而不是让他打字 |

## 用法

1. **要出图** → 载入 `catimation-image`,用 `generate_image`/`generate_images`(写提示词前先走 `director-orchestrator` 的 STEP 0)。
2. **要存/复用素材或角色** → `catimation-portrait-library`,把素材入库拿到 `asset://assetId` 再引用,保跨图/跨视频一致性。
3. **需求不清/要先聊方向** → `catimation-brainstorm` 摊一张 `ask_user` 卡片,定下方向再开工。

## 交互弹窗 `ask_user`(系统级 · 随时可用 · 不限头脑风暴)

`ask_user` 是**系统级交互工具**,和 `generate_image` / `view_image` 同级,**永远直接可调用**,不需要先命中 `catimation-brainstorm`。判定很简单:**只要你准备给用户列 2 个以上选项/方案/选项/方向,或遇到该由用户拍板的决策(景别/风格/运镜/模型/下一步…),就直接调用 `ask_user` 渲染可点击选项卡,而不是发纯文字编号列表。** 一次一问、所有方案塞进同一张卡(6–8 个也行)。`catimation-brainstorm` 只是把这套用法包成「先聊方向」的完整流程,**不是 `ask_user` 的唯一入口**。

## 与其它插件的关系

- 本插件是底座:`catimation-director` / `catimation-storyboard` 写好提示词后,**出图都落到 `catimation-image`**;视频落到 `catimation-video`。
- 角色一致性的根:先在人像库建**人物卡**(`catimation-portrait-library`),再被各处引用。

## 边界

- 本卡只做**索引 + 路由**,工具参数与最佳实践在各子技能里,需要时去读。
