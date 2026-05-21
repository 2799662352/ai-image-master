---
name: storyboard-feature-collapse
description: 用于利用 AI 绘画的特征塌陷机制,主动压缩非主体细节、制造背景语义模糊、边缘衰减、烟雾化/梦境感,并用局部锚点强化情绪。适用于 特征塌陷、Feature Collapse、减法美学、情绪肖像、背景 bokeh、soft collapse、fading edges、focus on eyes、极虚极实、Inpainting 局部重绘、梦核/赛博写意。
---

# Storyboard Feature Collapse / 特征塌陷美学

核心信念:AI 的“糊、塌、细节丢失”不一定是废片。主动压缩非主体特征,保留关键锚点,可以让画面从糖水片变成有情绪浓度的艺术图。

提炼自中文教程《特征塌陷:AI绘画的“失控”美学与情绪掌控指南》。参考: <https://www.super-i.cn/info-2509.html>

## 什么是特征塌陷

当画面信息过载或某些区域权重较低时,AI 会把非核心区域生成成:

- 色块
- 柔焦
- 模糊边缘
- 抽象光斑
- 不可名状的背景结构
- 语义简化后的形状

这可以模拟人类记忆:背景记不清,但情绪核心很清楚。

## 技巧一:压缩非主体特征

弱写法:

```text
A girl crying in the rain on a busy street, many people, cars, signs, all details clear.
```

强写法:

```text
A cinematic portrait of a girl crying in the rain, focus exclusively on her wet eyelashes and eyes; the busy city background collapses into soft creamy bokeh and abstract neon circles, shallow depth of field, no readable street details.
```

负向:

```text
--no detailed background, complex pattern, clutter, busy street details, readable signs
```

## 技巧二:用特征衰减制造张力

适合表达:

- 梦
- 逝去
- 灵魂出窍
- 爆发
- 记忆破碎
- 情绪崩塌

关键词:

```text
fading edges, dissolving silhouette, smoke-like body, ink bleeding into darkness, motion smear, features melting into shadow, semi-abstract contours
```

示例:

```text
武士的刀锋保持极度锐利,身体边缘像墨水和烟雾一样向黑暗中溶解;背景和衣摆塌陷成流动色块,只有刀、眼神和手指保持清晰。
```

## 技巧三:极虚 vs 极实

全图都糊是失败。必须保留 5%-10% 绝对清晰区域作为锚点:

- 眼睛
- 光源
- 戒指
- 刀锋
- 花
- 机械义肢

权重写法:

```text
focus on eyes::2, hyper-detailed iris::1.5, background collapsing into soft abstraction::1.2
```

## Inpainting 工作流

1. 先生成整体氛围好、背景自然塌陷的图。
2. 只涂抹视觉锚点。
3. 用高细节 prompt 重绘锚点。
4. 保留其他区域的语义模糊。

## 风格配方

### 情绪肖像

```text
背景塌陷 + 眼神锐利 + 半边脸受光 + 胶片颗粒
```

### 梦核/阈限空间

```text
全局特征衰减 + 低对比 + 异常柔焦 + 空荡空间
```

### 赛博写意

```text
霓虹色彩 + 长曝光光流 + 建筑结构塌陷为色块 + 前景机械手清晰
```

## 出稿前检查

- 是否压缩了非主体信息?
- 是否保留了清晰锚点?
- 塌陷是否服务情绪,而不是单纯画质差?
- 光源和色彩逻辑是否仍然统一?
- 是否避免用后期高斯模糊代替 AI 语义塌陷?
