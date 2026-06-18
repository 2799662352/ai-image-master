---
description: 反推 — 把参考图/爆款视频拆解成可复刻的镜头、运动学与提示词
---

反推参考素材时:

1. 图片反推 → 加载 `storyboard-scene-breakdown` + `storyboard-style-extraction-logic`(提取可复用风格逻辑,而非语义拟合)。
2. 视频反推 → 加载 `storyboard-kinematic-reverse-engineering`(三帧分析:起始帧/爆发帧/结尾帧 + 相机运动)。
3. 需要结构化标注 → 配合 director 插件的 `director-structured-captioning`。
4. 产出:可直接喂生成模型的结构化提示词 + 复刻要点;商业素材仅作学习参考并标注出处。

参考素材/诉求在下方(可附图片路径):

$ARGUMENTS
