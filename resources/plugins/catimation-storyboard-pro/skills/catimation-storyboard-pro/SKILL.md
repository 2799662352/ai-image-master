---
name: catimation-storyboard-pro
description: Use when 用户给了剧本/场景创意/广告概念/镜头清单,需要一键产出完整的导演级故事板制作包(逐镜),供 Image 2 与 SceneDance/Seedance 出图出视频时。Triggers on storyboard / 故事板 / 分镜制作包 / 镜头表 / create storyboard / 广告分镜.
---

# 分镜 Pro 插件总览(catimation-storyboard-pro · 索引)

<!-- skill-budget: standard -->

本技能是 **catimation-storyboard-pro 插件的入口卡**。本插件聚焦于**一键产出"导演级故事板制作包"**。完整家族目录与周边插件分工,读 `references/family-catalog.md`(相对本 skill 目录)。

## 路由

1. 拿到剧本/创意 → 载入 `create-storyboard`(本插件主入口)产出分镜制作包。
2. 有剧本/分场/镜头清单**要逐镜拆解**,或要一张**人能看的逐镜生产表**(镜头行 + 景别/运镜列 + 逐条提示词 + 可搜索可筛选的单文件 HTML)→ 载入 `shotlist-builder`。用户不必点名「分镜表」;拆镜这件事本身就是它的触发条件。它可独立于制作包使用,也可作为制作包的交付环节。
3. 单镜镜头语言细节(构图/打光/演技/调色)的精修,以及制作包产出后的出图/出视频落点,见 references/family-catalog.md 的周边插件分工 —— 按需加载,不在本卡强制。

## 边界

- 本卡只做**索引 + 路由**,制作包的格式与字段在 create-storyboard 里。
- 一键成板(本插件)与单点画面精修(工艺技能库插件)的区别见 references/family-catalog.md。
