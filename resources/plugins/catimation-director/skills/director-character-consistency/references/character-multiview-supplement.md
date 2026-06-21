# 角色多视图补充:三视图 / 四视图 / 转台 / 表情模组(可选)

> 来源:忠实移植自 updream `character-turnaround`(人物三视图)与 `character-four-view`(四视图合图),
> 已适配本 app 工具(`generate_image` / `generate_images` / `generate_video` + 人像库),去除其平台专有调用
> (`image_generate` / `banana-pro` / `kling` / `hub.use_tool` / `canvas_media_create`)。
>
> **定位(锚点纪律):** 角色身份锚**默认**用单锚点人像库「大头照(正脸无表情)+ 全身照」。
> 本文件的三视图 / 四视图 / 转台 / 表情模组是**可选补充**,**慎用**——多视图易触发 ID 漂移与双胞胎,
> 仅在确有需要(角色设计立稿、建模 / 美术参考、需要系统化展示角色全貌)时使用。
> 用作生成参考时,优先以已锁定的单锚点(或一张清晰全身定妆图)作 `referenceImages`,保证一致性。

## 何时用本补充

- 角色「从无到有」立设计稿,需要一次性看清正 / 侧 / 背全貌(配合 `character-design-profiles.md` 的美术版)。
- 需要建模 / 美术 / 外包参考稿。
- 需要角色表情库(同一张脸的多种情绪)供后续分镜挑用。
- **不需要时别用**:常规出镜角色用单锚点即可,不要默认产出多视图。

## A. 四视图合图(单张,风格天然最一致 — 推荐的多视图形态)

一次出一张「正视图 + 左视图 + 后视图 + 面部特写」水平排列的设计稿。单张合图各视图同源,
风格 / 比例 / 外观天然一致,优于分别出图再拼。

- 工具:`generate_image`(默认渠道 `gpt-image-2-vip`;若要超清可让用户指定 `wan2.7-image-pro` 走 Miau 站点)。
- `ratio`: `21:9`(超宽,四图横排);`resolution`: `2K`;有参考图时带上 `referenceImages`。

**英文提示词模板:**
```
[character_description, ]Professional character design sheet, four views arranged horizontally from left to right:
1) Front view - A-pose (arms naturally hanging down at 15-30 degree angle from body),
2) Left side view - A-pose (arms naturally hanging down),
3) Back view - A-pose (arms naturally hanging down),
4) Face close-up - horizontal composition with clear facial details.
Pure black background, studio three-point lighting (key light at 45 degrees, fill light for shadow softening, rim light for edge definition),
professional character design sheet style, high detail, 2K resolution
```

**中文提示词模板:**
```
[角色描述,]专业角色设计稿,四个视图从左到右水平排列:
1)正视图 - A-pose 姿势,手臂自然下垂与身体呈 15-30 度角,
2)左视图 - 左侧 A-pose 姿势,手臂自然下垂,
3)后视图 - 背面 A-pose 姿势,手臂自然下垂,
4)面部特写 - 横向构图,面部细节清晰。
纯黑色背景,工作室三点布光(主光 45 度角照射,辅光填充阴影,轮廓光勾勒边缘),
专业角色设计稿风格,高细节,2K 分辨率
```

技术规格:比例 21:9 / 分辨率 2K / 背景纯黑 #000000 / 三点布光 / A-pose / 单张合图。
有清晰的角色全身参考图时效果最佳,务必传 `referenceImages`。

## B. 三视图(正 / 侧 / 背)+ 360° 转台 + 六表情模组

需要更完整的视觉资产包时:

1. **收集信息(一次性提问):** 角色名称 / 类型(主角·配角·反派·龙套)/ 外貌服装发型配饰 / 风格(写实·卡通·赛璐珞·3D)/ 色调。
2. **三视图:** 先出正视图作基准,再以它作 `referenceImages` 出侧、背视图(保证一致);或用上面的四视图合图一次搞定。
   单图提示词结构:`Character design sheet, [角色描述], front view / side view / back view, full body, T-pose standing, clean white background, professional character turnaround, [风格], [色调], highly detailed`。
3. **360° 转台动画(可选):** 以正视图为首帧,用 `generate_video` 出约 5s 转台:
   `360 degree character turnaround rotation, smooth spinning animation, [角色描述], [风格]`。需先备好首帧资产。
4. **六表情模组(可选):** 以基准脸作 `referenceImages`,用 `generate_images` 一次出六张(仅改面部表情、保持外观一致):
   喜悦 / 悲伤 / 愤怒 / 惊讶 / 恐惧 / 自然中性。
   提示词结构:`Character expression sheet, [角色描述], [表情关键词], portrait shot, consistent character design, [风格], [色调], clean background, detailed facial features`。
5. **入库复用:** 选定的视图 / 表情存进**人像库**得 `asset://assetId`,供后续分镜复用;转台视频入视频素材库。

## 一致性要点

- 多视图 / 表情的核心是**角色一致性**:始终以同一基准图(单锚点或正视图)作参考,别每张从零生成。
- 四视图合图因「单次单图」天然最一致,优先用 A 方案。
- 产出后按 `catimation-image` 的四项验收(符合要求 / 质量 / 风格一致 / 过门)复检;不一致就以基准图重生成。
- 多视图是**资产生产工具**,最终落地到分镜 / 视频时,角色身份仍以人像库锚点为准。
