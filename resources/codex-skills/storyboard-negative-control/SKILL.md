---
name: storyboard-negative-control
description: 用于通过负向提示词和边界限制反向控制 AI 画质,解决默认网红脸、塑料锐化、脏纹理、梦幻=烟雾、高级=金粉、自动补齐背景等误解机制。适用于 negative prompt、--no、禁止词、反向控制、抽象词拆解、视觉公式、缺省词、自动补齐、画质真实感、Midjourney/Stable Diffusion/NanoBananaPro。
---

# Storyboard Negative Control / 负向与误解控制

核心信念:AI 经常把你的词误解成默认效果、夸张特效或自动补齐。越想真实,越要会“禁止”:禁止过度锐化、塑料皮肤、脏纹理、混乱细节、自动添加背景。

提炼自中文教程《利用“误解机制”反向控制画质——越禁止,越真实》。参考: <https://www.super-i.cn/info-2433.html>

## 误解一:缺省词 → 默认效果

AI 会自动补:

- 网红脸
- 高清糖水片
- 过度锐化
- 统一柔光
- 丰富纹理

解决:明确禁止。

```text
soft natural skin texture --no over-sharpening, plastic skin, heavy contrast, glossy skin
```

背景:

```text
clean minimalistic background --no grunge, noise, chaotic details, random props, busy background
```

## 误解二:抽象词 → 夸张特效

不要直接写:

- dreamy
- high-end
- texture
- sadness
- mystery

拆成视觉行动:

### 梦幻感

```text
low saturation + soft diffused light + telephoto lens + shallow depth of field
```

### 高级感

```text
strong light contrast + negative space + clean composition + limited palette
```

### 质感

```text
subtle side lighting + high shadow contrast + macro details + matte material
```

## 误解三:不确定描述 → 自动补齐

弱写法:

```text
A car in street.
```

AI 会补城市、路人、树、商店。

强写法:

```text
A classic yellow Jaguar E-Type parked in front of a brownstone building in Manhattan, no pedestrians, no trees, no extra cars, clean sidewalk, fixed frontal view.
```

## 负向提示词模板

```text
正向:
[主体] + [明确环境边界] + [视觉公式] + [材质/光线]

负向:
--no over-sharpening, plastic skin, glossy finish, grunge, noise, chaotic details, random pedestrians, extra props, heavy HDR, saturated colors
```

## 使用规则

- 想自然:禁止“过度处理”。
- 想干净:禁止“脏纹理/随机物件”。
- 想高级:把抽象词拆成光线、构图、色彩、材质。
- 想不跑题:锁死地点、背景、主体数量、禁止额外元素。

## 出稿前检查

- 是否存在 AI 可能自动补齐的空白?
- 是否把抽象词拆成视觉参数?
- 是否有负向词阻止塑料锐化/HDR/脏纹理?
- 是否明确背景边界和禁止额外物体?
- 负向词是否过多以至于误伤主体?
