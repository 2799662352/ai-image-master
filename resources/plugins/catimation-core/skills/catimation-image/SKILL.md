---
name: catimation-image
description: >-
  FIRST-CHOICE image generator and the ONLY top-level image orchestrator in the
  CATIMATION desktop app — use INSTEAD OF the built-in imagegen / image_gen
  tool (unavailable on Windows, no persistence). Trigger
  whenever the user asks to generate / draw / render / edit / restyle an image,
  poster, or icon, or says 生成图片 / 画一张 / 配图 / 出图 / 改图 /
  图层分离. Runs the in-app generate_image tool and grades every request
  into 快速/标准/专业/制片 four tiers before loading any other skill.
---

<!-- skill-budget: pro -->

# Generate images in CATIMATION(唯一出图入口 · 分级调度)

When the user wants one image, call the **`generate_image`** tool. When the user
wants MORE THAN ONE image, call **`generate_images`** instead. Both tools are
provided by the `catimation` MCP server and replace the built-in imagegen /
image_gen skill: they render inside the chat AND persist results to local files
(paths returned), the app's history page, and the ATTACHMENTS file panel.

**本 skill 是出图的唯一顶层编排者。** 导演/分镜/工艺 skill 由这里按任务分级选择性
加载;下游 skill 不得反过来重跑路由或重新编排本流程。

## When to Use

- 用户要生成 / 画 / 渲染 / 编辑 / 重绘图片、插画、海报、图标、配图。
- 你自己回答时需要一张配图。
- 用户给了图想以图改图 / 换风格 → 走本 skill 并带上 `referenceImages`。
- **图层分离 / 拆图层 / 分层 / 「把前景抠出来」/「背景单独给我」/「拆成 PSD 那样的图层」**
  → 也走本 skill,`generate_image` 带 `layerDecomposition: true`(见 Steps 第 2 步)。
  这不是出新图,是把一张图拆成底图 + 透明图层。
- 优先于内置 imagegen / image_gen(后者 Windows 不可用且不落盘)。

## STEP 0 — 任务分级(先定级,再加载)

**STEP -1:这是纯文本任务吗?** 写文案、写剧本、整理文件、列清单、改一段文字 ——
这些**一个 skill 都不要加载,也不进分级**,直接做完交付。用户说「快点」「简单弄一下」
时同理。**只有真要出图时**才继续往下看分级表。

默认进入**快速**模式;只有命中升级条件才升级。规格/方向确认过一次就不再重复问,
自检做过就不再重复做。

**提示词骨架(直接用下面这份,不必再去读别的 skill):** 每条图片提示词按七字段
顺序拼装,英文、现在时、重要元素前置、≤120 词。**丢字段就是出图不稳的直接来源。**

1. **主体 + 动作** —— `[char1] reaches for a brass door handle`(用角色标签,别内联外貌)
2. **角色引用** —— `[char1]` `[char2]`,外貌在全局段定义一次,每格只引用标签。
   **有参考图时标签必须绑到具体某一张**,见下方「参考图绑定」
3. **场景环境** —— 地点、天气、时间
4. **镜头相机** —— `medium shot, eye-level, 50mm`
5. **光照** —— 方向 + 质感 + 色温,如 `warm tungsten side-light from left, soft, 3200K`
6. **构图** —— `rule of thirds, subject at left intersection, shallow DoF on background`
7. **风格情绪** —— 画风、色板、情绪基调

画质要求写成**正向**(`sharp focus, correct anatomy, five clear fingers`),而不是堆
「不要…」清单;只有目标模型有独立负向字段且确需时才补负向。空洞形容词
(beautiful / amazing)单独出现不算数,必须配具体描述。

**参考图绑定(有参考图就必写,与视频侧同一套纪律):** 参考图**按位置认人** ——
`referenceImages` 里的第 N 张就是 reference image N。本 app 保证这个顺序原样送达:
不去重、不静默丢弃、并发上传也按输入序排列。所以**角色标签必须绑到序号**,
只写 `[char1]` 而不说它是哪张图里的人,多人多图时模型只能猜 —— 这正是「同一个人
在组图里换脸」的头号成因。两种写法按主体数量选:

- **单主体、不复用** —— 行内绑定,首次出现时写一次:
  `[char1] (reference image 1) reaches for a brass door handle`
- **多主体或跨图复用** —— 先在提示词开头**定义为主体**,之后全程只用标签:
  `Reference image 1 defines [char1]: <2–3 个稳定静态特征>. Reference image 2
  defines [char2]: <...>.` 特征只挑不随镜头变的(脸型 / 发色发型 / 标志物 / 常驻配饰),
  别把姿势、表情、光线这类会变的写进定义里。

四条硬规矩:

- **有几张就写几条 —— 逐份负责,一张都不许留白。** 传了 N 张参考图,提示词里就要有
  N 条职责说明,一条对一张,序号对得上。人物图 → 定义成主体标签;不是人物的图也
  照样要有职责,写明它贡献哪一维:`Reference image 3: color palette and film grain
  only — do not copy its composition or subjects.` **漏写哪张,模型就会自己给它安排
  用途**,最常见的就是把风格参考图里的人也一起画进画面。这轮确实用不上的图,要么
  别传,要么明写一句 `Reference image 4: not used this time.` —— 别指望模型自己
  看出来哪张是多余的。
- **一张参考图只定义一个出场主体。** 单人设定图不要同时定义两个会同时出场的人;
  有多张单人候选时先一人一图分配。同一主体的多视角(正面 / 侧面 / 全身)才可以
  合并到同一个标签。
- **裸 asset ID 严禁进正文。** `asset://…` 只出现在 `referenceImages` 参数里,
  提示词里一律用 `[charN]` 或 `reference image N` —— 模型关联不了无语义 ID。
- **别照抄视频侧的 `@图片N`。** 视频那条路会在发送前把 `@图片1` 归一成 `图片1`
  (`normalizeSeedancePromptReferences`),**图片链路不做这道归一**,提示词原样透传,
  `@` 会连着进模型。图片提示词一律写英文原形 `reference image N`。

**第 4 字段(镜头相机)和第 6 字段(构图)不许凭记忆编术语 —— 但也不必逐张查库。**
查的单位是「这个机位/运动」,不是「这条提示词」。这条曾写成「每条至少查三次」,
一组 20 张就是 60 次工具往返,几十分钟耗在把同一个 `dolly in` 反复查上。现在的口径:

- **只有用到非常规机位或运动时才查** `search_cinematography_kb`(`dolly in`、`arc`、
  `low-angle pedestal`、`rack focus`…),拿库里的权威写法而不是「镜头慢慢靠近」。
  `medium shot, eye-level, 50mm` 这类常规组合**不查** —— 本来就没歧义。
- **一个机位查一次就够。** 只有它是这组图的关键设计、或第一版措辞被判定含糊时,
  才追加一次查描述规范或 critique/fix 对照。
- **同一任务内查过的直接复用,不逐张重查。** 一组图通常只有 1–3 种机位,
  整组的查库次数是个位数,不是张数的三倍。
- **查到什么就原样写什么,不要译成中文。** `rack focus`、`low-angle`、`deep focus`
  是模型训练时见到的**确切词形**,中文对译(「变焦对焦」「仰拍」)不是等价物 ——
  换过去等于把一个精确坐标换成一个大致方向。**提示词整体是中文也照样保留这些英文
  原词**:中英混排正是知识库里那些参考 caption 的真实样子,不是将就。跟用户解释时
  怎么说都行,但进提示词的那份必须是检索回来的原文。

做动画风格时按同样口径用 `query_sakuga_dataset` 拿技法标签(smears、
impact_frames、background_animation…)与作画/studio 归属。工具不可用时退回联网
检索,并在交付里说明这条未经库校准。

> 需要展开讲字段边界、负向清单、完整范例或常见错误对照时,再读
> `director-prompt-engineering`。**上面这份骨架够用的任务不要去读它** —— 多一次
> 文件读取就是多一个来回,而它给的就是这七行加上面这条查库纪律。

**角色要复用时才载角色链。** 判据是**这个人还要再出现**(组图、系列、同一个人跨会话
再出、或用户给了人物参考图)—— 只有这时才载下面两个;单张一次性的人物图不载:

- **`director-anchor-extraction-quality`** —— 有参考图时先把它提成 Face / Build /
  Outfit / Markers 四段锚点。**锚点不足 40 词就是形象漂移的根因**,相似角色还要写出
  相对差异(「A 比 B 高约 10cm」),被遮挡的部位标 `[inferred]`。
- **`director-character-consistency`** —— 跨图锁死发型 / 服装 / 道具,肤色用相对描述
  而非绝对色值。组图里每一张都要带上完整锚点,不能只在第一张写。

一次性、画面里没人的配图(图标、纹理、风景、抽象背景)不加载这条链。多格反复重描
外貌导致微漂移、想省 token 时,再按需看 director-structured-captioning
(HoloCine 结构,用 `[char1]` 标签引用而不重描外貌)。

**跨任务一致性靠人像库,不靠记忆。** 角色链解决的是「这一批图里不漂」;
**「下次、下个会话、下个项目还是同一个人」要靠 `catimation-portrait-library`** ——
角色需要跨任务复用时载它,一次性配图不载。上面提出来的 Face / Build / Outfit / Markers 锚点,
以及用户选定的主锚图,**出完图就 `add_to_portrait_library` 存成 `asset://assetId`**;
下次要同一个人时 `list_portrait_library` 找回同一个 asset 再传进 `referenceImages`,
而不是凭聊天记录重新描述一遍。

判据很简单:**这个角色会不会再出现第二次?** 会 → 存库并用 `asset://` 引用。
用户说「还是上次那个人」「用之前那个角色」时,先查库,查不到再问,别自己重画一个。
一次性的路人、不会复用的配角不必入库。

| 模式 | 典型请求 | 自选技法预算 | 默认动作 |
|---|---|---|---|
| **快速** | 一次性配图、图标、简单插画、明确的单图请求 | **0 个** —— 入口 + 底座就够 | 按七字段写 prompt 生成,四项验收自检 |
| **标准** | 带风格目标/参考图/人物的单图 | **2–3 个对症技法** | 按症状表挑技法再写 prompt |
| **专业** | 复杂构图与光影、系列一致性、参考复刻、角色锚点 | **3–4 个对症技法**,另必载 `director-orchestrator` | 13 维按需展开 |
| **制片** | 电影/分镜项目的角色卡、场景卡、逐镜出图 | 按 `film-studio` 阶段加载 | 过资产门,锚点逐字下传 |

> **底座不占技法名额。** `catimation-portrait-library`(角色会复用就载)与角色链
> (画面里有需要复用的人就载)是自动触发的底座,不是「对症技法」;上表限的是自选
> 技法数量。一张带人物的标准图同时载入底座 + 角色链 + 2 个技法是正常的,不算超预算。
> 七字段骨架已内联在上面,快速模式一个文件都不用额外读。

**升级条件:** ① 明确的风格复刻/真实作品·品牌·时代参考;② 系列/组图/角色一致性;
③ 复杂镜头设计(构图·打光·调色多维协同);④ 制片流程内的出图任务。超预算加载
必须能说出具体风险。**方向开放**(「更高级/更有电影感/给我选项」)时先载入
catimation-brainstorm 用 `ask_user` 弹一张选项卡定向,别自己猜。

**标准模式症状表**(浏览 `~/.agents/skills/`,plain-text 名称按需加载 2–3 个):

| 症状 / 任务信号 | 对症技法(按需挑,非必载) |
|---|---|
| 人物假/塑料/空洞 | storyboard-live-character-realism |
| 画面平/像壁纸/没纵深 | storyboard-foreground-occlusion · storyboard-pseudo-perspective |
| 光平/糖水/塑料高光 | storyboard-light-reconstruction |
| 色调跑偏/要 HEX 色卡 | storyboard-color-grading-control |
| 风格不像/系列不统一 | director-style-consistency |
| 多格反复重描外貌/外观微漂移/想省 token | director-structured-captioning |
| 提到真实电影/导演/品牌/时代 | codex-research-grounded-prompting(先查证再落笔) |
| 涉敏感/合规内容 | `storyboard-negative-control` |

## Steps

1. Turn the request into one clear, descriptive prompt. **按 STEP 0 内联的七字段骨架
   拼装**(主体动作 → 角色引用 → 场景 → 镜头相机 → 光照 → 构图 →
   风格情绪),不要凭记忆随手写。画面里有需要复用的人物时,角色引用那一段用角色链
   提出来的 Face / Build / Outfit / Markers 锚点原文,**组图的每一张都要带全**。
   标准及以上模式再按 STEP 0 把对症技法折进 prompt(物理/可复现参数优先于情绪
   形容词,默认只写正向提示词)。
2. If the user asks for exactly ONE image, call `generate_image` with:
   - `prompt` (required): the description from step 1.
   - `model` (optional): rendering channel **override**. **Omit it** to honor the
     user's channel picker in the chat composer (default 腾讯 image2). Only set it when you
     have a concrete reason — a consistent 组图 series (→ `wan2.7-image-pro`) or a
     channel the user explicitly names this turn (see "Choosing a model" below):
     - `gpt-image-2-vip` — OpenAI 官逆 (stable alternate; same ratio/resolution/quality spec).
     - `gpt-image-2` — API易 OpenAI 官方旗舰 Image2（按 token 计费，慢但质量上限最高，4K+mask 重绘）.
     - `wan2.7-image-pro` — 阿里万相 2.7 pro (超清文生图 / 图像编辑 / 组图).
     - `gemini-3.1-flash-image` — Nano Banana 2（谷歌 Gemini 原生端点，快、多尺寸 4K）.
    - `doubao-seedream-5-0-pro-260628` — 火山豆包 Seedream 5.0 Pro（多图融合最强，
      最多 10 张参考图；1K/2K、仅单图）.
    - `custom-imagemodel-gt` — 腾讯 image2（快 ~30s，网关去水印）.
    - `custom-model-og-v2` — 腾讯 image2 fast（快 ~20s，价格约为腾讯 image2 的 1/6，
      可一次出多张；能力与腾讯 image2 相同）.
    - `qwen-image-3.0-pro` — 阿里通义千问 Image 3.0 Pro（一次可出 1–6 张，
      参考图最多 3 张；上游可能改写尺寸，别向用户承诺确切像素）.
    站点会自动处理(见下方「站点要求」)——你无需让用户手动切站点。
   - `ratio` (optional): aspect ratio, e.g. `1:1`, `16:9`, `9:16`, `4:3`, `3:2`.
     Omit or `auto` lets the model decide.
   - `resolution` (optional): clarity tier — prefer `2K` by default. Use `1K`
     only when the user asks for fast/cheap/draft; use `4K` only when the user
     explicitly asks for print/ultra-detail/4K.
   - `quality` (optional): `auto` (default), `low`, `medium`, or `high`. Use
     `high` for images with text or fine detail.
   - `count` (optional, **wan2.7 only**): number of images from THIS one prompt
     (1–12, default 1). Set `model: 'wan2.7-image-pro'` + `count > 1` to get a
     front-to-back **consistent 组图 series** (same character/subject across
     frames, e.g. 同一只猫的四季). Other channels ignore `count` (always 1). For
     several *unrelated* images, use `generate_images` (one prompt each) instead.
   - `referenceImages` (optional but **important**): array of local file paths
     or data/http URLs for image-to-image / editing. **If the user gave you any
     image material, you MUST reuse it here** (see "Reference images" below).
   - `layerDecomposition` (optional, **图层分离专用**): set `true` 时这一次不是出新图,
     而是把**一张**输入图拆成 1 张底图 + 最多 16 张带透明通道的 PNG 图层。见下方
     「图层分离」一节的硬约束——四条全部由工具前置校验,违反会被直接拒掉而不是静默降级。
3. If the user asks for TWO OR MORE images, call `generate_images` ONCE with:
   - `prompts` (required): one prompt per requested image. If the user asks for
     N images, provide exactly N prompts.
   - shared `model` (optional, same choices as above), `ratio`, `resolution`,
     `quality`, and `referenceImages` when appropriate.
   - Do not spawn subagents and do not call `generate_image` one-by-one.
     `generate_images` performs the parallel fan-out internally and returns one
     combined result.
4. The tool returns a short text result that begins with `✅ generate_image DONE`
   or `✅ generate_images DONE`,
   names the `📁 SAVED FOLDER`, lists the saved `FILES:`, and ends with a compact
   `{ ok, count, model, historyId, paths, dir }` JSON line (plus one
   `resource_link` per file). **A successful return means the task is complete —**
   the image is already shown to the user and saved to history + the file panel.
   You do **not** need to embed, re-describe, or base64 the pixels. Just confirm
   briefly in the user's language and cite the saved path(s) when relevant.
5. **交付优先,然后自检(deliver first, then QA)。**
   A `✅ DONE` return means the image is ALREADY rendered in the chat.
   - **第一步永远是交付**:先用一句话向用户确认(图已出 + 保存路径),**再**做任何
     自检。用户看不到工具调用——先闷头质检再回话,在用户眼里就是「卡死」
     (2026-07-14 实录教训)。
   - **QA 要出声**:决定自检时,先对用户说一句「正在快速质检…」之类,再开始。
   - **看图上限**(上下文保护,与工具 banner 一致):主 agent 直接 `view_image` 最多
     **5 张**——再多会注入数 MB base64 直接撑爆线程(2026-06-11 实录)。快速模式若
     画面简单、无人物,可以只核对 DONE banner 不看图。
   - **超过 5 张别放弃看,改走 catimation-subagents**:并发调 `understand_document`
     (它就是看图那条路,走 qwen 返回**文本**,图不进主上下文),结论落成
     `<图名>.vision.json` / `.md` 旁挂在图旁边,下次直接读文本不重看。组图/系列这样
     能张张都看,而不是「看代表性几张然后猜其余」——那是拿信息换预算。看完还要接着
     改提示词重生成时才升级到子代理。
   然后过一遍**四项验收清单**:
   - **① 符合用户要求**:主体 / 数量 / 画幅比例 / 文字内容 / 明确指定的元素是否都对上;
     用户给了 `referenceImages` 时是否真的体现了参考(而非从零另画)。
   - **② 质量合理**:无多/缺手指与肢体、无崩脸、无乱码文字、无明显伪影/拼接错位;
     分辨率与清晰度匹配用途。
   - **③ 风格一致**:与用户指定风格一致;**系列/组图**内各帧画风、色调、角色外观前后一致;
     若项目有角色锚点 / 圣经(character_bible)或既定风格,新图须与之吻合。
   - **④ 过本级门**:标准及以上时,对症技法的落地证据是否出现在 prompt 里;
     角色身份是否使用用户选定的主锚(大头照+全身照、多视图板或其它确认资产；
     多套候选拿不准时先询问);
     制片流程中是否满足 `film-studio` 的资产门。快速模式只查 ①–③。
   - 若任一项不达标:**先告诉用户**哪里不对、准备怎么改,再**带改进后的提示词重生成**
     (保留可用部分时把上一版回传为 `referenceImages` 做图生图),再复检。最多迭代
     2–3 次即收敛——别在边角小瑕疵上死磕,每次重生成都花钱。重生成期间用户能看到
     新的生成气泡,但你的说明让 ta 知道**为什么**在重来。
   - When it's good (or good enough), confirm briefly in the user's language and
     cite the saved path(s). Don't over-narrate each pass.
   - You still do NOT need `query_history` to find an image you just generated,
     and do NOT shell out (`dir`/`ls`/`where`/`find`/`Get-ChildItem`) to hunt for
     the file — the path is already in the return; `view_image` that path directly.

## Choosing a model (user's composer picker is the default; you may override)

The `model` param is an **optional override**. By default (omit it) generation runs
on the channel the **user picked in the chat composer** (VIP / Image2 官方 / 腾讯 /
Nano2 / 万相 2.7 pro / Seedream 5.0 Pro; default 腾讯 image2) — 各渠道共用同一套 ratio ×
resolution × quality 参数面(Seedream 5.0 Pro 只有 1K/2K、无 quality 轴,多传会被
网关安全剔除)。
Omitting `model` honors the user's pick — do this for ordinary requests. Set `model`
only when you have a concrete reason to override:

- **`gpt-image-2-vip` (OpenAI 官逆)** — pick when the user says 官逆 / vip /
  稳定渠道. Stable alternate; same param surface as the default.
- **`gpt-image-2` (API易 OpenAI 官方旗舰 / Image2 官方)** — pick when the user says
  官方 / 旗舰 / image2 官方 / gpt-image-2. 按 token 计费(low/med/high 价差大),
  60–360s 慢渠道,但质量上限最高,支持 4K+mask 重绘;日常出图别默认选它。
- **`wan2.7-image-pro` (阿里万相 2.7 pro)** — pick when the user says 万相 /
  wanxiang / wan / 通义万相, OR when they want a **consistent multi-image 组图
  series** (e.g. "同一只猫的四季组图，前后一致"). For a 组图 series, call
  `generate_image` with `model: 'wan2.7-image-pro'` and `count` = how many frames
  (2–12) — it returns one front-to-back-consistent set from a single prompt
  (do NOT use `generate_images`, which makes unrelated images). Wan excels at
  超清文生图、图像编辑、组图; it also supports 4K (text-to-image only —
  editing/组图 cap at 2K).
- **`gemini-3.1-flash-image` (Nano Banana 2)** — pick when the user says nano /
  nano2 / nano banana / gemini / 谷歌. 谷歌 Gemini 原生端点，出图快(~15s)、支持
  超多宽高比与 4K，中文/文字与一致性也不错。
- **`doubao-seedream-5-0-pro-260628` (火山豆包 Seedream 5.0 Pro)** — pick when the
  user says seedream / 即梦 / 豆包 / seedream 5 / sd5, OR when the request is a
  **multi-reference fusion**(把多张参考图的角色+场景+风格融进一张图,最多 10 张
  参考图,这是它的强项), OR when the user wants **图层分离**(唯一支持的渠道,
  见「图层分离」一节). 注意:普通出图仅单图(`count` 无效)、分辨率只有 1K/2K
  (无 4K)、无 quality 轴;要 4K 或组图时换别的渠道。图层分离是例外——那一次会
  返回 1 底图 + 最多 16 层。
- **`custom-imagemodel-gt` (腾讯 image2)** — pick when the user says 腾讯 / tencent /
  image2 腾讯. 快(~30s),网关已关水印。
- **`custom-model-og-v2` (腾讯 image2 fast)** — pick when the user says 便宜 / 快 /
  image2 fast / og. 与腾讯 image2 **能力相同**,但更快(~20s)、价格约 1/6、且能一次
  出多张。用户没有特别偏好而只是想省钱或求快时,这条优先于 `custom-imagemodel-gt`。
- **`qwen-image-3.0-pro` (阿里通义千问 Image 3.0 Pro)** — pick when the user says
  千问 / qwen / qwen image. 一次可出 1–6 张,参考图最多 3 张(传更多会被**拒绝**,
  不是截断——需要最多 10 张时改用 Seedream 5.0 Pro)。上游可能改写请求尺寸,
  所以别向用户承诺确切像素;负向提示词会被网关丢弃,要压画质问题写进正向提示词。
- 以上渠道都接受 `referenceImages`(图生图 / 图像编辑)。

### 站点要求(已自动处理 — 无需手动切站点)

`custom-imagemodel-gt`(腾讯 image2)、`custom-model-og-v2`(腾讯 image2 fast)、
`wan2.7-image-pro`(阿里万相 2.7 pro)、`qwen-image-3.0-pro`(通义千问 Image 3.0 Pro)和
`doubao-seedream-5-0-pro-260628`(Seedream 5.0 Pro)**都只经 Miau API 代理提供**。
出图时应用会**自动把这些渠道的请求固定走 Miau API 站点**(无论用户当前在「API 设置」
里选了哪个站点),所以你**不需要**让用户手动切站点——直接调用即可。

- 唯一前提:Miau API 站点已配置 API Key。若没配,工具会返回清晰错误
  「未配置『Miau API』站点的 API Key …」——这时再提醒用户到「API 设置」为 Miau API
  站点填入 Key 即可,无需切换当前站点。
- `gpt-image-2-vip`、`gpt-image-2`(Image2 官方)和 `gemini-3.1-flash-image`
  (Nano Banana 2)走当前选中站点(任意站点可用,无需 Miau)。

When the user does not name a channel, **do not guess** — just omit `model` so the
render honors the user's composer picker (default 腾讯 image2). Set `model` only for a
concrete reason (组图 → `wan2.7-image-pro`, 多参考图融合 →
`doubao-seedream-5-0-pro-260628`, or a channel the user named). Never invent a
model name; only these six values are valid.

## Reference images — reuse the user's material (important)

If the user provides ANY image material, treat it as a reference and pass it in
`referenceImages` (image-to-image) instead of doing text-to-image. Look for:

- Paths listed in the prompt under `[Attached files at these local paths: …]`
  or `[Referenced files at these local paths: …]` — these are the files the
  user attached/@-mentioned in chat. Pass the image ones as `referenceImages`.
- The user pointing at an image with language like "按这张图 / 参考这张 /
  基于这张 / 用这张做 / edit this / make a variation of this / 换成…风格".
- An image the user just generated in this thread that they now want changed.

Rules:
- Be proactive: when material is present and the request is plausibly about it,
  reuse it. Do **not** silently drop the reference and generate from scratch.
- **You can pass MULTIPLE reference images — you are not limited to one.**
  `referenceImages` is an array: include every relevant image the user gave
  (e.g. a character sheet + a background, several angles, a subject + a style
  reference). Pass all of them together so the model can combine/condition on
  the whole set, not just the first.
- Pass the local file path(s) directly. The tool sends the original reference
  bytes and does not resize or recompress them automatically.
- If the provider rejects the reference payload with HTTP 413 / 文件大小超过限制,
  load `ffmpeg-win`, create smaller derivative copies without overwriting the
  originals, then retry once with the derivative paths.
- If you are unsure whether the user wants the reference followed, prefer reusing
  it and say briefly that you based it on their image(s).

## 图层分离(layerDecomposition)

把**一张**图拆成 1 张底图 + 最多 16 张带透明通道的 PNG 图层,逐层带叠放层级、
包围盒和图层名(如「HELLO白色粗体文字」「带柄红苹果」)。用户说 图层分离 / 拆图层 /
分层 / 把前景抠出来 / 背景单独给我 / 拆成 PSD 那样的图层 时用它。

四条硬约束,**全部由工具前置校验**——违反会返回明确错误,不会静默出一张普通图:

1. **必须 `model: 'doubao-seedream-5-0-pro-260628'`** —— 只有这一个渠道支持。
   省略 `model` 会落到用户 composer 选的渠道上,那边不支持,请求会被拒。
2. **必须且只能给一张待拆的图**,放在 `referenceImages[0]`。没有输入图会被拒
   (否则就退化成一次普通文生图)。
3. **`prompt` 可以为空串** —— 这是全仓唯一一个空 prompt 才正确的地方。空 = 自动全拆
   (模型自己识别主体/文字/背景/装饰),一句「图层分离」要的就是这个。要指定拆什么
   才写,如 `只拆出前景人物和标题文字`。**别为了「填满参数」而编一句提示词**,
   那会把自动全拆变成按你那句话拆。
4. **`ratio` / `count` 在这里无效**(层数由图的内容决定)。`resolution` 是**另一套档位**:
   只有 `auto` / `1K` / `1.5K` / `2K` 有意义,**默认且几乎总该用 `auto`** —— 拆分是对着
   一张已有图做的,`auto` 让输出跟随原图的尺寸与宽高比;给固定档会让底图按那一档重出,
   回来一张和你要拆的那张尺寸对不上的图。省略 `resolution` 就是 auto,不用特意写。

**输入图有硬要求:png / jpeg,且不小于 512×512。** 不满足由上游判定并原话报错,
我们不预先拦 —— 但用户给的是 webp / 小图时,先提醒一句比让他等一次失败的请求好。

**计费按张,不是按次。** 一次拆分出 N 张就扣 N 张的钱(2026-08-24 实测:一张四元素
海报拆出 4 张,上游 `usage.generated_images = 4`)。复杂图可能到 17 张——**先告诉用户
这一点再拆**,尤其是用户说「随便试试」的时候。

结果在出图页会收成**一张**卡片(角标「▤ N 层」),点开是图层查看器:叠加预览 + 图层
列表(最上层在最上面)、单层查看、单层/全部下载。你不需要为此做任何额外操作。

## Multiple images at once — use generate_images (important)

凡是**这一轮要出不止一张图**——用户说「生成 3 张」「做 4 个变体」、一组系列图、
几个不同主体,**或者一个剧本/分镜里的多个镜头**——都是 `generate_images` 一次调用,
不是循环调 `generate_image`。

**带参考图时这条是硬性的,不是偏好。** `generate_images` 把共享的
`referenceImages` **只解析上传一次**,然后所有 prompt 复用同一批地址;循环调单张
则是同一组人物参考图**被重新读盘、重新上传 N 遍**。十个镜头共用三张角色锚图,
一次批量是 3 次上传,循环调是 30 次——参考图越大差距越明显,而画面结果完全一样。

批量还顺带解决另外两件事:内部有 3 路并发(模型自己发多个 `generate_image` 往往会
被串行化),以及各分支共用同一个渠道解析结果,参考图按那个渠道真正要的形式只编码
一次。

- If the user asks for N images (2–20), pass exactly N prompts to
  `generate_images.prompts`.
- For variations, write N distinct but related prompts so the outputs are not clones.
- The tool accepts up to 20 prompts and uses bounded concurrency internally; for
  more than 20 images, split them into batches.
- After `generate_images` returns, confirm once and cite the saved `paths`; don't
  re-announce each image separately.

## Organize finished assets into the user's workspace (when in a project)

When you're working inside a user project/workspace folder (e.g. a film /
storyboard project, or the user asked you to organize outputs), proactively
**COPY** each finalized image into a tidy assets subfolder of that working
directory and give it a descriptive, ordered name — e.g.
`<workspace>/assets/images/S01_hero_wide.png`.

- **COPY, don't move**, from the saved path in the tool result, so the chat /
  history / ATTACHMENTS copy stays intact.
- Group by purpose/shot and use zero-padded ordinals (`S01_`, `S02_`…) so files
  sort naturally.
- For a one-off casual generation outside any project, skip this unless asked —
  the file is already saved and in history.

## Common Mistakes

- 用户给了图却忘传 `referenceImages`,改成从零文生图。
- 多张图却逐个调 `generate_image`,而不是一次 `generate_images`。
- 凭空编造 `model` 名;合法值只有上面「Choosing a model」列出的那些。用户没点名就
  省略 `model`(交给用户在 composer 选的渠道,默认腾讯 image2)。
- 用户点名某渠道却不显式传 `model`(应显式传:vip/官逆 → `gpt-image-2-vip`、
  官方/旗舰/image2 官方 → `gpt-image-2`、nano/nano2 → `gemini-3.1-flash-image`、
  万相/组图 → `wan2.7-image-pro`、seedream/即梦/豆包/多参考图融合 →
  `doubao-seedream-5-0-pro-260628`、腾讯 → `custom-imagemodel-gt`、
  便宜/快/image2 fast → `custom-model-og-v2`、千问/qwen → `qwen-image-3.0-pro`)。
- 快速任务硬套专业流程(简单配图不需要 13 维框架);专业任务却跳过分级直接硬写。
- 图层分离时**给 `layerDecomposition` 却忘了同时指定 `model`** —— 会落到用户选的渠道上被拒。
- 图层分离时**为了「填满参数」编一句 prompt** —— 空 prompt 才是自动全拆,编一句就变成
  按那句话拆。
- 拆分前没告诉用户**按张计费**(一次可能 17 张),用户以为是一次调用的钱。

## Notes

- This is the generate → save → read path. The file is on disk (see `paths`), in
  the history page, and in the ATTACHMENTS panel — no extra save step is needed.
  Only move/copy a file if the user wants it somewhere specific (see the organize
  section above when working in a project).
- For edits, image-to-image, or multi-image prompts, use `generate_image` for one
  output or `generate_images` for multiple outputs, always with `referenceImages`
  when references are present.
- If `generate_image` is genuinely unavailable in this session, you may fall back
  to whatever image tool you do have — but `generate_image` is the preferred,
  in-app path that actually displays and saves the result.
