---
name: storyboard-time-words
description: 用于通过时间词让 AI 图像/视频获得情绪、动态和因果痕迹,解决画面像死物、摆拍、蜡像、没有生活气息的问题。适用于 过去式、现在进行时、将来时、just finished、after、leftover、mid-leap、billowing、about to、moments before、impending、时间补偿机制、情绪残留、决定性瞬间、势能与悬念。
---

# Storyboard Time Words / 时间词动态控制

核心信念:画面之所以像死物,常常是因为只描述了空间,没有描述时间。时间词会触发 AI 的因果补偿:过去式补痕迹,现在式补动势,将来时补压迫和悬念。

提炼自中文教程《学!如何用“时间词”强行带出ai情绪与动态》。参考: <https://www.super-i.cn/info-2515.html>

## 三种时间状态

### 过去式:情绪残留

过去式不是表现动作,而是表现后果。

关键词:

```text
after, just finished, leftover, half-eaten, crumpled, broken, used, abandoned, recently cried, still wet, traces of
```

弱写法:

```text
A delicious breakfast on the table.
```

强写法:

```text
A table after a messy family breakfast, leftover crumbs, spilled milk, half-eaten toast, crumpled napkin, morning sunlight striking dirty plates.
```

情绪例子:

```text
一个刚刚哭过的人,眼眶仍然发红,睫毛被泪水打湿,头发贴在脸侧,房间空气像刚刚沉默下来。
```

### 现在进行时:决定性瞬间

现在进行时激活物理引擎:边缘拖影、布料翻涌、粒子运动、肌肉受力。

关键词:

```text
mid-leap, falling, splashing, billowing, scattering, straining, twisting, frozen action, high shutter speed, motion blur
```

弱写法:

```text
A girl dancing ballet.
```

强写法:

```text
A ballet dancer mid-leap, muscles straining, skirt billowing dynamically, dust motes dancing in the stage light, frozen action, high shutter speed.
```

### 将来时:势能与悬念

将来时描绘事件发生前 0.1 秒,画面充满势能。

关键词:

```text
about to, moments before, on the verge of, impending, preparing to, inhaling before fire, hand hovering before impact
```

弱写法:

```text
A knight fighting a dragon.
```

强写法:

```text
A knight standing before a colossal dragon, moments before the breath of fire, dragon inhaling deeply, throat glowing red, impending doom, extreme tension, scale comparison.
```

## 时间词选择

- **过去式**:忧郁、怀旧、战损、生活感、故事感。
- **现在式**:运动、舞蹈、战斗、自然灾害、冲击力。
- **将来时**:恐怖、惊悚、决战前夕、悬念、压迫。

不要在一个 prompt 里混用多个时态:

```text
坏:刚刚结束 + 正在爆炸 + 即将发生
好:主体 + 环境 + 一个明确时间状态 + 风格
```

## 时间词模板

```text
主体:
[谁/什么]

时间状态:
[after / mid-action / about to]

因果痕迹:
[过去留下的痕迹] 或 [现在的动势] 或 [未来的预备动作]

视觉证据:
[碎屑/湿痕/拖影/布料/肌肉/负空间/光线]
```

## 出稿前检查

- 画面是否只有静态说明,没有时间状态?
- 是否选择了唯一时态?
- 过去式是否有痕迹和后果?
- 现在式是否有动势和边缘变化?
- 将来时是否有蓄力、负空间和悬念?
