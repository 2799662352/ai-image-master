---
name: catimation-storyboard-pro
description: Use when 用户给了剧本/场景创意/广告概念/镜头清单,需要一键产出完整的导演级故事板制作包(逐镜),供 Image 2 与 SceneDance/Seedance 出图出视频时。Triggers on storyboard / 故事板 / 分镜制作包 / 镜头表 / create storyboard / 广告分镜.
---

# 分镜 Pro 插件总览(catimation-storyboard-pro · 索引)

本技能是 **catimation-storyboard-pro 插件的入口卡**。本插件聚焦于**一键产出"导演级故事板制作包"**。

## 子技能

| 子技能 | 什么时候加载 |
|--------|--------------|
| `create-storyboard` | **主入口**:用户给了剧本 / 场景创意 / 广告概念 / 镜头清单,需要产出**完整的导演级故事板制作包**(逐镜),可直接喂给 Image 2 与 SceneDance/Seedance 视频生成 |

## 用法

1. 拿到剧本/创意 → 载入 `create-storyboard` 产出分镜制作包。
2. 单镜镜头语言细节(构图/打光/演技/调色)→ 配合 `catimation-director`(13 维)与 `catimation-storyboard`(29 个工艺技能)按需补强。
3. 产出后:逐镜出图交 `catimation-image`,图生视频交 `catimation-video`。

## 与 catimation-storyboard 的区别

- `catimation-storyboard-pro`(本插件):**一键出整套故事板制作包**,适合从剧本/概念直接成板。
- `catimation-storyboard`:29 个**单点工艺技能**(物理打光/反推/调色/演技/过审…),适合针对某个具体画面问题精修。

## 边界

- 本卡只做**索引 + 路由**,制作包的格式与字段在 `create-storyboard` 里。
