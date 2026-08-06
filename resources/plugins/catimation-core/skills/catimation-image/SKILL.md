---
name: catimation-image
description: >-
  FIRST-CHOICE image generator and the ONLY top-level image orchestrator in the
  CATIMATION desktop app — use INSTEAD OF the built-in imagegen / image_gen
  tool (unavailable on Windows, no persistence). Trigger
  whenever the user asks to generate / draw / render / edit / restyle an image,
  illustration, poster, or icon, or says 生成图片 / 画一张 / 配图 / 出图 /
  改图. Runs the in-app generate_image tool and grades every request
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
- 优先于内置 imagegen / image_gen(后者 Windows 不可用且不落盘)。

## STEP 0 — 任务分级(先定级,再加载)

默认进入**快速**模式;只有命中升级条件才升级。规格/方向确认过一次就不再重复问,
自检做过就不再重复做。

**提示词骨架(直接用下面这份,不必再去读别的 skill):** 每条图片提示词按七字段
顺序拼装,英文、现在时、重要元素前置、≤120 词。**丢字段就是出图不稳的直接来源。**

1. **主体 + 动作** —— `[char1] reaches for a brass door handle`(用角色标签,别内联外貌)
2. **角色引用** —— `[char1]` `[char2]`,外貌在全局段定义一次,每格只引用标签
3. **场景环境** —— 地点、天气、时间
4. **镜头相机** —— `medium shot, eye-level, 50mm`
5. **光照** —— 方向 + 质感 + 色温,如 `warm tungsten side-light from left, soft, 3200K`
6. **构图** —— `rule of thirds, subject at left intersection, shallow DoF on background`
7. **风格情绪** —— 画风、色板、情绪基调

画质要求写成**正向**(`sharp focus, correct anatomy, five clear fingers`),而不是堆
「不要…」清单;只有目标模型有独立负向字段且确需时才补负向。空洞形容词
(beautiful / amazing)单独出现不算数,必须配具体描述。

**第 4 字段(镜头相机)和第 6 字段(构图)不许凭记忆写。** 每条提示词落笔前至少查
三次 `search_cinematography_kb`,三次各查一个面,不要用同义词把同一个问题问三遍:

1. **术语** —— 你打算用的那个机位/运动本身(`dolly in`、`arc`、`low-angle
   pedestal`、`rack focus`…),拿库里的权威写法,而不是「镜头慢慢靠近」。
2. **描述规范** —— 这个镜头在结构化描述里该怎么落字(机位高度 / 角度 / 景别 /
   焦点 / 景深 / 主体位置 / 空间层次)。
3. **范例或修正对** —— 找一条同类专业 caption,或一条 critique/fix 对照着改措辞。
   修正对尤其值钱,它直接告诉你这类描述通常错在哪。

做动画风格时再加一次 `query_sakuga_dataset`,拿真实技法标签(smears、
impact_frames、background_animation…)与作画/studio 归属。**同一条镜头运动在同一个
任务里查过一次就复用结论,不必逐张重查;换了运动才重查。** 工具不可用时退回联网
检索,并在交付里说明这条未经库校准。

> 需要展开讲字段边界、负向清单、完整范例或常见错误对照时,再读
> `director-prompt-engineering`。**上面这份骨架够用的任务不要去读它** —— 多一次
> 文件读取就是多一个来回,而它给的就是这七行加上面这条查库纪律。

**画面里有人,再自动加载角色链(第二个例外):** 要出的图里有人物/角色/IP,**且它需要
复用**(组图、系列、同一个人跨会话再出、或用户给了人物参考图)——自动加载:

- **`director-anchor-extraction-quality`** —— 有参考图时先把它提成 Face / Build /
  Outfit / Markers 四段锚点。**锚点不足 40 词就是形象漂移的根因**,相似角色还要写出
  相对差异(「A 比 B 高约 10cm」),被遮挡的部位标 `[inferred]`。
- **`director-character-consistency`** —— 跨图锁死发型 / 服装 / 道具,肤色用相对描述
  而非绝对色值。组图里每一张都要带上完整锚点,不能只在第一张写。

一次性、画面里没人的配图(图标、纹理、风景、抽象背景)不加载这条链。多格反复重描
外貌导致微漂移、想省 token 时,再按需看 director-structured-captioning
(HoloCine 结构,用 `[char1]` 标签引用而不重描外貌)。

**跨任务一致性靠人像库,不靠记忆(第三个例外):** 角色链解决的是「这一批图里不漂」;
**「下次、下个会话、下个项目还是同一个人」要靠 `catimation-portrait-library`**——
自动加载,同样不需用户点名。上面提出来的 Face / Build / Outfit / Markers 锚点,
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
     user's channel picker in the chat composer (default VIP). Only set it when you
     have a concrete reason — a consistent 组图 series (→ `wan2.7-image-pro`) or a
     channel the user explicitly names this turn (see "Choosing a model" below):
     - `gpt-image-2-vip` — OpenAI 官逆 (stable alternate; same ratio/resolution/quality spec).
     - `gpt-image-2` — API易 OpenAI 官方旗舰 Image2（按 token 计费，慢但质量上限最高，4K+mask 重绘）.
     - `wan2.7-image-pro` — 阿里万相 2.7 pro (超清文生图 / 图像编辑 / 组图).
     - `gemini-3.1-flash-image` — Nano Banana 2（谷歌 Gemini 原生端点，快、多尺寸 4K）.
     - `doubao-seedream-5-0-pro-260628` — 火山豆包 Seedream 5.0 Pro（多图融合最强，
       最多 10 张参考图；1K/2K、仅单图）.
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
Nano2 / 万相 2.7 pro / Seedream 5.0 Pro; default VIP) — 各渠道共用同一套 ratio ×
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
  参考图,这是它的强项). 注意:仅单图输出(`count` 无效)、分辨率只有 1K/2K
  (无 4K)、无 quality 轴;要 4K 或组图时换别的渠道。
- All six accept `referenceImages` for image-to-image / editing.

### 站点要求(已自动处理 — 无需手动切站点)

`custom-imagemodel-gt`(腾讯 image2)、`wan2.7-image-pro`(阿里万相 2.7 pro)和
`doubao-seedream-5-0-pro-260628`(Seedream 5.0 Pro)**都只经 Miau API 代理提供**。
出图时应用会**自动把这些渠道的请求固定走 Miau API 站点**(无论用户当前在「API 设置」
里选了哪个站点),所以你**不需要**让用户手动切站点——直接调用即可。

- 唯一前提:Miau API 站点已配置 API Key。若没配,工具会返回清晰错误
  「未配置『Miau API』站点的 API Key …」——这时再提醒用户到「API 设置」为 Miau API
  站点填入 Key 即可,无需切换当前站点。
- `gpt-image-2-vip`、`gpt-image-2`(Image2 官方)和 `gemini-3.1-flash-image`
  (Nano Banana 2)走当前选中站点(任意站点可用,无需 Miau)。

When the user does not name a channel, **do not guess** — just omit `model` so the
render honors the user's composer picker (default VIP). Set `model` only for a
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
- 凭空编造 `model` 名;只有六个合法值。用户没点名就省略 `model`(交给用户在 composer 选的渠道,默认 VIP)。
- 用户点名某渠道却不显式传 `model`(应显式传:vip/官逆 → `gpt-image-2-vip`、
  官方/旗舰/image2 官方 → `gpt-image-2`、nano/nano2 → `gemini-3.1-flash-image`、
  万相/组图 → `wan2.7-image-pro`、seedream/即梦/豆包/多参考图融合 →
  `doubao-seedream-5-0-pro-260628`)。
- 快速任务硬套专业流程(简单配图不需要 13 维框架);专业任务却跳过分级直接硬写。

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
