---
name: catimation-subagents
description: >-
  Look at images and videos WITHOUT burning the main context, and delegate
  batch work. Trigger when more than one image/frame/board needs looking at,
  when a contact sheet or reference set must be judged, or when several
  independent jobs could run side by side (多图分析 / 批量看图 / 分头去做 /
  并行 / 委派 / 子代理). Media analysis lands as a `.vision.json` +
  `.vision.md` sidecar next to the file, so the next session reads text
  instead of re-opening pixels.
---

# 看图不烧上下文 · 委派与旁挂

<!-- skill-budget: standard -->

**一张图进主上下文的代价远高于它携带的信息。** 九宫格、参考图组、一板卡片的产物——
挨个 `view_image` 会把主上下文塞满,后面所有推理都在一个被稀释的窗口里进行。

解决办法不是「少看几张」(那是在用信息换预算),而是**让别人去看,把结论以文本带回来**,
并且**把结论落在图片旁边**,下次直接读文本。

## 硬上限:一次 5 张

**主 agent 直接 `view_image` 的上限是 5 张。** 第 6 张起一律走下面两条路 —— 并发 MCP
理解或子代理,拿文本回来,不再往主上下文里塞像素。

这个数不是拍脑袋:五张之内还看得清彼此关系(参考图组、一组分镜的头几格),再多就只是
在稀释后面每一步推理可用的窗口。

例外(这些本来就不该看):

- **自己刚生成的产物不看。** 用户已经在聊天里看着它了,再 `view_image` 一遍纯属浪费。
  需要判断质量时走下面的路,拿文字结论。
- 宫格图(contact sheet)算**一张**。它本来就是为「一张看完整段」拼的,别再拆开逐格看。

## 两条路,按「看完还要不要干活」选

### 路 A(默认):MCP 理解工具并发

**超过 5 张、或看一眼就够只要一个结论时走这条。** 图不进主上下文,回来的是中文文本。

| 素材 | 工具 | 说明 |
|---|---|---|
| **图片**(png/jpg/webp/gif/avif) | **`understand_document`** | ⚠️ 名字带 document,但**它就是看图那条路** —— 图片 mime 在它的白名单里。别被名字骗过去 |
| 视频 | `understand_video` | 整段看,懂剧情/台词/连续性 |
| 画布上的视频 | `understand_canvas_video` | 不用先找路径 |
| PDF / 图文页 | `understand_document` | 上游对原生文档只有部分支持,**先渲成图**再传效果最好 |

三件事让这条路便宜:

1. **返回文本,不返回像素。** 主上下文只涨一段话。
2. **同一轮可以并发发多个调用。** 九张图就是九个 `understand_document`,一起发出去。
   这不是子代理,没有 `agents.max_threads` 的限制。
3. **默认 `qwen3.7-plus`**(便宜)。硬骨头才传 `model="max"`;失败时渲染层会自动回退一次。

**问题要问具体。** `question` 决定这次调用值不值:

```
❌ "这张图怎么样"
✅ "这张图里的人物:发型、上衣款式与颜色、下装、鞋、随身道具各是什么?
    有没有多指/断肢/脸部崩坏/文字乱码?背景里有几个人在动?"
```

问得含糊,拿回来的就是一段没法用的观感;问得具体,拿回来的直接能写进锚点或质检结论。

### 路 B:子代理

**看完还要接着干活时才用这条** —— 需要独立的工具权限和推理预算,而不只是一个答案。
典型:「把这九张分镜逐张核对锚点,不符的直接改提示词并重生成」。

- 上限 8 路并发(`agents.max_threads=8`),深度 1(子代理不能再开子代理)。
- 理解类的重活可以把子代理钉到 qwen:`modelProvider="qwen"`,`model="qwen3.7-max-dashscope"`
  (详见 catimation-understand 的 Path B;未配 Miau 令牌时该 provider 不可用)。
- **交接要写全。** 子代理看不到你的对话历史。派活时必须带上:要看哪个文件的绝对路径、
  判据是什么(锚点原文 / 质检四项 / 具体要找的穿帮)、产物写到哪、以什么格式回话。
  少一样,它就得靠猜,你拿回来的东西没法直接用。
- **别为了拆而拆。** 一张图、一个问题,用路 A;子代理的启动成本比一次 qwen 调用高得多。

## 旁挂:结论落在图片旁边

不管走哪条路,**分析结果都写成两份旁挂文件,和图同目录、同名前缀**:

```
assets/video/S01_station_wide.png
assets/video/S01_station_wide.png.vision.json    ← 给 agent 读
assets/video/S01_station_wide.png.vision.md      ← 给人读
```

这不是留档癖。它换来三件事:**下次不用重看**(省一次调用和一次上下文)、**跨会话可复用**
(明天接着做的人直接读)、**可 diff**(改了参考图,旧结论一眼看出过期)。

### `.vision.json` 字段

```json
{
  "source": "assets/video/S01_station_wide.png",
  "analyzedAt": "2026-08-03T10:12:00Z",
  "by": "understand_document/qwen3.7-plus",
  "question": "本次问的问题原文",
  "subjects": [
    { "role": "主角", "face": "…", "build": "…", "outfit": "…", "markers": "…" }
  ],
  "composition": "景别 / 机位 / 前中后景",
  "lighting": "主光方向 / 色温 / 软硬",
  "palette": ["#…", "#…"],
  "issues": ["左手六指", "背景文字乱码"],
  "verdict": "pass | needs-fix | reject",
  "notes": "自由文本补充"
}
```

用不到的字段直接省掉,**不要留空占位** —— 空字段会让下一个读它的人以为「看过了没问题」。
`subjects` 只在画面里有人时才写;`issues` 为空数组表示看过且没发现问题,与「没看」不同。

### `.vision.md`

同一份内容的人读版:一段话讲清这张图是什么、一个列表列出问题、最后一行给 verdict。
给人看的东西不要塞 JSON。

### 复用规则

动手看之前**先查旁挂文件**:存在、且 `analyzedAt` 晚于图片的 mtime → 直接读它,不重看。
图比它新(重生成过)→ 旧结论作废,重看并覆盖。

## 常见错误

| 错误 | 纠正 |
|---|---|
| 挨个 `view_image` 九宫格里的每一格 | 宫格图本来就是为「一张看完整段」拼的,看那一张(算 1 张);要逐格判就走路 A 并发 |
| 十几张卡的产物挨张 `view_image` | 超过 5 张就走路 A;主上下文只涨十几段文本,而不是十几张图 |
| 用 `view_image` 开 MP4 | 开不了。先用 ffmpeg-win 抽帧拼宫格,或直接 `understand_video` |
| 因为工具名叫 document 就不用它看图 | 它就是看图的路,图片 mime 在白名单里 |
| 为了省预算只看代表性一张、其余靠猜 | 那是用信息换预算。走路 A,九张都看,主上下文只涨九段话 |
| 派子代理却不给绝对路径和判据 | 它看不到你的历史,交接不全等于让它猜 |
| 看完不落盘 | 下次(或下个人)得重看一遍,那次调用是白花的 |
| 旁挂文件留一堆空字段 | 空字段读起来像「看过没问题」,比没有更糟 |
