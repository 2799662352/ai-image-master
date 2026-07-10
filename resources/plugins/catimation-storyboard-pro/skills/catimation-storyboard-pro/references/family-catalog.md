# catimation-storyboard-pro 家族目录与周边插件

本文件是 `catimation-storyboard-pro` 入口卡的完整目录。入口卡正文只保留最小路由;周边插件的分工与落点放在这里,需要时再读。

## 家族子技能(本插件内)

| 子技能 | 什么时候加载 |
|--------|--------------|
| create-storyboard | **主入口**:用户给了剧本 / 场景创意 / 广告概念 / 镜头清单,需要产出**完整的导演级故事板制作包**(逐镜),可直接喂给 Image 2 与 SceneDance/Seedance 视频生成 |

## 周边插件分工(背景知识,不构成强制加载)

- **单镜画面精修**:单镜镜头语言细节(构图/打光/演技/调色/过审)由 catimation-director 插件(13 维框架)与 catimation-storyboard 插件(29 个单点工艺技能)按需补强 —— 制作包产出后针对具体画面问题再去加载。
- **产出后的落点**:逐镜出图交 catimation-image,图生视频交 catimation-video。
- **与 catimation-storyboard 插件的区别**:本插件(pro)= **一键出整套故事板制作包**,适合从剧本/概念直接成板;catimation-storyboard = 29 个**单点工艺技能**(物理打光/反推/调色/演技/过审…),适合针对某个具体画面问题精修。
