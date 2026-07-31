---
name: catimation-film
description: >-
  Use when 做一整部片子/短片/宣传片/微电影/MV/剧集/预告片,要把一个想法或故事一条龙做成成片,
  或需要写剧本、分镜成片、批量出图出视频再拼接交付时。这是 catimation-film 插件的入口卡,
  只做分诊与路由:确认是成片项目后由它加载 film-studio 门控流水线,确认只缺剧本则转
  screenwriter。先加载本卡,不要跳过它直接进 film-studio,也不要两个一起加载。
  阶段技能(配音、剪辑、出图等)也不要预载:进到该阶段时由本卡或流水线点名。
  Triggers on film / movie / 短片 / 宣传片 / 预告片 / 剧本 / 成片 / trailer / screenplay.
---

# 电影插件总览(catimation-film · 索引 + 路由器)

<!-- skill-budget: standard -->

本技能是 **catimation-film 插件的入口卡**。当任务是"做一整部片子"(短片 / 宣传片 / 微电影 / MV / 剧集 / 预告片),先从这里路由。完整家族目录与典型流水线读 `references/family-catalog.md`(相对本 skill 目录)。

## 路由(最小集)

1. **整片项目 / 一条龙成片** → 载入 `film-studio`(端到端总编排器,本插件主入口),跟着它的阶段门(gate)走;逐镜出图/出视频/拼接的落点由它调度。
2. **只缺剧本**(剧情/分场/对白/节拍表/改稿/片长) → `screenwriter` 先写好,再回 film-studio 进入分镜与出片。
3. **要做预告片**(已有剧本/梗概,出 90 秒方案) → `trailer-plan-generator`。
4. **动画作画风格**(絵コンテ/芝居/作画技法) → 本插件另有日式动画作画子技能,名称与加载时机见 references/family-catalog.md。

## 边界

- 本卡只做**索引 + 路由**;成片流程的阶段门、设定锚点、交付标准都在 film-studio 里,需要时去读它。
- 别在这里重抄编剧/作画技法 —— 路由到对应子技能执行。
