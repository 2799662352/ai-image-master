# 启动开场动画 · 配音提示词

> **现状(临时):** `src/renderer/public/audio/startup/` 里现在放的是上游项目
> dsh-startup-screen 自带的 6 句配音(`line-1` 到 `line-6`),只是先让动画有声音。
> 想换成自己的:按下面的稿子生成 mp3,**同名覆盖**这 6 个文件即可,不用改代码。
> 来源与许可风险见 `src/renderer/src/features/startup-screen/THIRD_PARTY_NOTICE.md`——
> **正式发版前要换掉**(前 5 句截自上游作者的原片真声,第 6 句是自制落幕词,
> 早期版本用 XTTS-v2 克隆,该模型条款是非商用)。

启动开场动画的 6 句配音:按下面的文件名放进 `src/renderer/public/audio/startup/` 就会自动生效。
**缺任何一句都不会卡住动画**——那一句静音,画面照常走完,所以可以先交一部分、以后再补。

> 这个目录是构建时打进安装包的静态资源:**本地开发**(`pnpm dev`)放进去刷新就能听到;
> **已安装的应用**要等提交进仓库、随下一个版本发布才有声音。每个文件只有几十 KB,可以直接提交。

## 放哪儿、叫什么

```
src/renderer/public/audio/startup/
  line-1.mp3   需要访问许可        (第 1 步,点击「网页登录授权 / 授予访问权限」前后念)
  line-2.mp3   身份资料确认        (第 2 步,点击「确认身份」前后念)
  line-3.mp3   接收访问需求        (第 3 步,自动)
  line-4.mp3   开始读取权限        (第 4 步,自动)
  line-5.mp3   读取完毕 · 核验通过  (第 5 步,自动)
  line-6.mp3   终幕欢迎语          (「欢迎 xxx 访问」亮起的同一刻开念)
```

文件名固定、小写、扩展名 `.mp3`,不用改任何代码。

## 每一句的稿子

画面是「放行 / 授权」的叙事:一份档案被读取、核验,最后放行。配音像**系统自己在播报状态**,
不是在跟人聊天。

| 文件 | 中文稿(推荐) | 英文稿(备选) | 目标时长 |
|---|---|---|---|
| `line-1` | 需要访问许可。 | Access permission required. | 1.5–2.5 秒 |
| `line-2` | 身份资料确认。 | Identity verification. | 1.5–2.5 秒 |
| `line-3` | 接收访问需求。 | Access request received. | 1.5–2.5 秒 |
| `line-4` | 开始读取权限。 | Beginning permission read. | 1.5–2.5 秒 |
| `line-5` | 读取完毕,核验通过。 | Read complete. Verification passed. | 2–3.5 秒 |
| `line-6` | 身份验证完成,会话已建立。欢迎回来。 | Identity verified. Session established. Welcome back. | 3–4.5 秒 |

要点:

- **`line-6` 里不要出现名字。** 画面上的「欢迎 ○○ 访问」是实时写上去的名字(登录用户的昵称,
  没登录是「创作者」),录音做不到逐人播报。所以结尾只说「欢迎回来」这一类通用句。
- **句子宁短勿长。** 动画是跟着配音走的:一句念完才进下一步。1–5 步的画面停留本来只有
  0.7–1.6 秒,配音越长,用户等得越久。
- **单句不要超过 15 秒。** 超过会被「卡死保护」判成停滞并强制结束动画(代码里的看门狗,
  上游就有),这是硬上限,不是建议。

## 语气 / 声音设定(给 TTS 或配音演员)

> 年轻女声,中低音域,冷静克制,像一台很有礼貌的系统在播报状态。
> 吐字清晰、略带电子质感但不要机器人腔;语速中等偏慢,句尾轻微下沉,不拖尾音。
> 不要夸张的情绪、不要笑意、不要「客服腔」。`line-6` 比前五句稍微放松一点点——
> 是「完成了」的那种平稳,不是「欢迎光临」的热情。

给 TTS 的指令可以直接贴:

```
Voice: a calm young female voice, slightly low register, composed and precise,
like a polite system status announcer. Clear articulation, a faint synthetic
sheen but not robotic. Medium-slow pace, sentence endings settle downward, no
trailing drawl. No emotion, no smile, no call-center tone. Keep all six lines
in the SAME voice, pitch and loudness.
```

中文版:

```
声音:年轻女声,中低音域,冷静克制,像一台很有礼貌的系统在播报状态。吐字清晰,
带一点电子质感但不要机器人腔。语速中等偏慢,句尾下沉,不拖音。没有情绪起伏、
没有笑意、不要客服腔。六句必须是同一个声音、同一个音高、同一个响度。
```

如果用应用里自带的 `generate_audio`(seed-audio),一句一句生成,**六句用同一个音色**,
别每句换一次。

## 文件规格

- **格式**:MP3,单声道或立体声都行,44.1 kHz 或 48 kHz,128 kbps 足够。
- **响度**:六句统一到约 **−16 LUFS**(单句峰值不超过 −1 dBFS)。动画里还有合成的界面音效
  (点击声、提示音),配音太响会把它们盖掉,太轻又听不清。
- **首尾静音**:开头静音 ≤ 80 ms,结尾静音 ≤ 150 ms。**开头留得越长,声音越晚于画面。**
- **去掉底噪和呼吸声**,不要混背景音乐——动画自己有氛围音。
- 每个文件控制在 100 KB 以内(2–4 秒的 128 kbps 本来就只有 30–60 KB)。

## 验证

1. 把文件放进目录,在设置之外手动触发一次完整版:开发者工具里执行
   `localStorage.setItem('catimation.startup.v1', JSON.stringify({ mode: 'always' }))`,
   刷新页面。看完后改回 `daily`(或直接 `localStorage.removeItem('catimation.startup.v1')`)。
2. 听 6 句是否都出声、顺序对、音量接近;第 1、2 步要点击才会往下走。
3. 缺的句子会静音、动画照常走;想确认哪一句没加载,看网络面板里 `audio/startup/line-N.mp3`
   是不是 404。单句加载最多等 3 秒,等不到就放弃那一句。

## 没做 / 不保证

- 这套稿子是我按画面节奏写的,**没有用真实 TTS 试听过**。念出来的实际时长可能和上面的目标
  差一点,第一次试听后可以按需要改稿。
- 动画里还有合成的界面音效(点击、扫描、提示),**默认开着**;想全关请告诉我,加一个开关。
- 英文稿只是备选。画面主文案是中文,中英混用(画面中文、配音英文)是上游原版的做法,
  是否沿用由你定。
