# catimation-core 家族目录与跨插件协作

本文件是 `catimation-core` 入口卡的完整家族目录。入口卡正文只保留最小路由;跨插件的协作关系与背景放在这里,需要时再读。

## 家族子技能(本插件内)

| 子技能 | 能力 | 什么时候加载 |
|--------|------|--------------|
| catimation-image | **首选出图器** | 任何"生成图片 / 出图 / 画一张"的需求 —— 用应用内 `generate_image` / `generate_images`,**优先于内置 imagegen**(后者在 Windows 不可用且不持久化结果) |
| catimation-portrait-library | 人像库 / 素材库 | 管理可去重持久化的 图片/视频/音频 资产;"记住这个角色/场景"、复用同一角色保一致性、整理/检索素材时 |
| catimation-brainstorm | 卡片式头脑风暴 | 需求模糊或高价值(「做个宣传片」)时,用 `ask_user` 可点选卡片**一次一问**帮用户定方向,而不是让他打字 |

## 跨插件协作关系(背景知识,不构成强制加载)

- 本插件是底座:导演/分镜类插件(catimation-director、catimation-storyboard 家族)写好提示词后,**出图都落到 catimation-image**;视频落到 catimation-video 插件。
- 出图前的镜头语言统一框架由 catimation-director 插件的 orchestrator 提供(STEP 0 定方向),catimation-image 内部已有指引,不需要从本入口卡强制路由。
- 角色一致性的根:先在人像库建**人物卡**(catimation-portrait-library),再被各处引用。
