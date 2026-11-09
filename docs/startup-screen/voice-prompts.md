# 启动开场动画 · 配音提示词

> **现状(2026-11-09 晚起):** `src/renderer/public/audio/startup/line-1..6.mp3` 是从用户给的视频
> `down111load.mp4` 的音轨里切出来的(一条连续约 20 秒的整段朗读,按顺序 6 句,句间约 1–1.5 秒静音),
> **没有变调**(中位基频约 182 Hz,成年女声音域),所以 6 句音色天然统一。
> 切法:`silencedetect` 找到 6 组发声(第 5 句内部约 0.41 秒停顿保留;第 6 句 15.4–19.5 秒含内部停顿,整段一条),
> 起止各外扩一点、再裁头尾静音,响度归一到约 −17 LUFS、峰值约 −5 dBFS、单声道 24 kHz mp3。
> 单句 1.6 / 1.8 / 1.8 / 1.9 / 2.9 / 4.2 秒,合计约 14 秒。
> **没核实的:** 每一句具体念的是什么(我听不到,只按「6 组发声」的结构对上了 6 步);视频与声音的来源、
> 随产品分发的授权要用户自己确认。
> 曾经的升调版(+3 半音)备份在 `%TEMP%\startup-voice-installed-p3-before-mp4\`,想回退就拷回来同名覆盖。
> 想再换:**同名覆盖**这 6 个文件即可,不用改代码;自己生成时按下面的稿子**一次生成整段再切**(别逐句生成,音色会漂)。
> 来源与许可说明见 `src/renderer/src/features/startup-screen/THIRD_PARTY_NOTICE.md`。

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
| `line-6` | 身份验证完成,欢迎使用 CATIMATION。 | Identity verified. Welcome to CATIMATION. | 3–4.5 秒 |

要点:

- **`line-6` 里不要出现名字。** 画面上的「欢迎 ○○ 访问」是实时写上去的名字(登录用户的昵称,
  没登录是「创作者」),录音做不到逐人播报。所以结尾只说「欢迎回来」这一类通用句。
- **句子宁短勿长。** 动画是跟着配音走的:一句念完才进下一步。1–5 步的画面停留本来只有
  0.7–1.6 秒,配音越长,用户等得越久。
- **单句不要超过 15 秒。** 超过会被「卡死保护」判成停滞并强制结束动画(代码里的看门狗,
  上游就有),这是硬上限,不是建议。

## 语气 / 声音设定(给 TTS 或配音演员)

> **成年女性**(三十岁上下,自然的中音域,成熟、干练、有质感;**不要少女音、不要童声、不要奶音、不要尖细**),
> 前五句是冷静克制的系统播报(参考《生化危机》红后那种干净的英文系统女音),像一台很有礼貌的系统在播报状态。
> 吐字清晰、略带电子质感但不要机器人腔;语速中等偏慢,句尾轻微下沉,不拖尾音。
> **第 6 句要有欢迎感**:「Identity verified.」干脆、带一点满意;「Welcome to CATIMATION.」声音里带一点微笑,
> 比前五句稍暖、稍慢,Welcome 轻轻上扬,结尾温暖地落下,像迎接一个回家的人——但仍是同一个成年女声,不是客服腔。
> 前五句不要夸张的情绪、不要笑意;第 6 句的 Welcome 才允许有笑意和暖意,但不要「客服腔」「欢迎光临」式的热情。

给 TTS 的指令可以直接贴:

```
Voice: a mature adult woman in her thirties, natural mid-range female pitch, composed and
polished, like a refined AI system announcer. Not a girl, not childlike, not cute, not squeaky.
Clear articulation, a faint synthetic sheen but not robotic. Sentences 1-5: calm, even, neutral
status announcements, medium-slow pace, endings settle downward. Sentence 6: "Identity verified."
crisp and quietly satisfied, then "Welcome to CATIMATION." spoken warmly with a soft smile in the
voice, slightly slower and brighter, gently lifting on "Welcome" and landing warm on
"CATIMATION", like greeting someone arriving home. Keep all six in the SAME voice and loudness.
```

中文版:

```
声音:成熟的成年女性(三十岁上下),自然的中音域,从容、干练、有质感,像一台优雅的 AI 系统在播报。
不要少女音、童声、奶音、尖细。吐字清晰,带一点电子质感但不要机器人腔。前五句冷静平稳的状态播报,
语速中等偏慢,句尾下沉。第六句:「Identity verified.」干脆、带一点满意;「Welcome to CATIMATION.」
带着微笑说出,稍慢稍暖,Welcome 轻轻上扬,CATIMATION 温暖地落下,像迎接回家的人。六句必须是同一个声音、同一个响度。
```

如果用应用里自带的 `generate_audio`(seed-audio),**一次生成整段**:把六句按顺序写进同一条 `input`,
要求「句间约 1.5 秒静音、开头不要静音」,再用 `ffmpeg silencedetect=noise=-38dB:d=0.55` 找间隙切开
(第 5 句内部自带一次停顿,按「6 段」合并,别当成 7 句)。**不要带参考音频**:实测参考音频会把音高拉回
参考的低音区,「偏高」的要求就落空了。当前这版用的描述:

```
Mature adult woman, around thirty, English AI system voice: natural mid-range female pitch, polished,
composed, clear and a little synthetic, never girlish, never childlike, never squeaky, not husky.
Standard American English, medium-slow pace, crisp diction, even volume, absolutely no leading silence.
Sentences 1-5 are calm, even, neutral status announcements. In sentence 6, "Identity verified." is crisp
and quietly satisfied, and "Welcome to CATIMATION." is warm: a soft smile in the voice, slightly slower
and brighter, gently lifting on "Welcome" and landing warm on "CATIMATION", like greeting someone
arriving home. Read exactly these six sentences in order, verbatim, with about 1.5 seconds of silence
between sentences: 1) Access permission required. 2) Identity verification. 3) Access request received.
4) Beginning permission read. 5) Read complete. Verification passed. 6) Identity verified. Welcome to
CATIMATION. CATIMATION is pronounced Cat-ih-MAY-shun.
```

这版**不再要求「高音」**(上一版要求高音域后又后期变调,共振峰被一起抬高,听起来像小孩)。
想要更亮的声音,请在生成时靠描述(明亮、清澈、成熟),**不要后期变调**。

## 只重做第 6 句(前五句保持现状)

用户 11-09 觉得最后一句要「有礼貌一点点」(加上之前的「要有欢迎感」)。前五句已经定了,所以**只单独生成第 6 句**,
用现成的前几句当参考音频把音色拉回同一个人(`referenceAudios` 最多 2 条,用**不变调**的原始版,
因为成品装的是升了 3 个半音的版本,后期会对新的第 6 句做同样的变调):

```
参考音频: C:\Users\27996\AppData\Local\Temp\startup-voice-installed-p0\line-1.mp3
          C:\Users\27996\AppData\Local\Temp\startup-voice-installed-p0\line-5.mp3
```

提示词(整段贴给 `generate_audio.input` / 声音描述,**只念这一句**):

```
Same voice as the reference audio: the same adult woman, the same timbre and register. Read this single
line verbatim: "Identity verified. Welcome to CATIMATION."  "Identity verified." is crisp, calm and
quietly satisfied. Then pause for a quarter of a second and say "Welcome to CATIMATION." courteously and
gracefully, like a polite, gracious host receiving a guest: slightly softer and slower than the
reference lines, a faint smile in the voice, gently lifting on "Welcome" and landing warm and
respectful on "CATIMATION". Courteous, not effusive; no call-center cheer. CATIMATION is pronounced
Cat-ih-MAY-shun. No leading silence, no music.
```

要点:「有礼貌一点点」= **语气**上更柔和、更慢、更谦和,**稿子不改**;如果想连措辞一起改,可以把后半句换成
`Welcome to CATIMATION. It's a pleasure to have you.`(会多约 1.5 秒,总长仍远低于 15 秒上限)。
生成回来后:裁头尾静音 → 同一条归一链 → 同样升 3 个半音(与前五句一致)→ 覆盖 `line-6.mp3`。**音色是否真的接近前五句**
要用户耳朵确认(参考音频只能把音高 / 腔调拉近,不保证音色一致);不满意再退回「六句整段重生」。

## 文件规格

- **格式**:MP3,单声道或立体声都行,44.1 kHz 或 48 kHz,128 kbps 足够。
- **响度**:六句统一到约 **−16 LUFS**(单句峰值不超过 −1 dBFS)。动画里还有合成的界面音效
  (点击声、提示音),配音太响会把它们盖掉,太轻又听不清。
- **首尾静音**:开头静音 ≤ 80 ms,结尾静音 ≤ 150 ms。**开头留得越长,声音越晚于画面。**
- **去掉底噪和呼吸声**,不要混背景音乐——动画自己有氛围音。
- 每个文件控制在 100 KB 以内(2–4 秒的 128 kbps 本来就只有 30–60 KB)。

## 验证

1. 把文件放进目录,重启应用即可看完整版(默认每次启动都播,dev 下强制每次播)。
   想临时不播:开发者工具里执行
   `localStorage.setItem('catimation.startup.v1', JSON.stringify({ mode: 'off' }))`;
   想改成每天一次用 `mode: 'daily'`;恢复默认就
   `localStorage.removeItem('catimation.startup.v1')`。
2. 听 6 句是否都出声、顺序对、音量接近;第 1、2 步要点击才会往下走。
3. 缺的句子会静音、动画照常走;想确认哪一句没加载,看网络面板里 `audio/startup/line-N.mp3`
   是不是 404。单句加载最多等 3 秒,等不到就放弃那一句。

## 没做 / 不保证

- 这套稿子是我按画面节奏写的,**没有用真实 TTS 试听过**。念出来的实际时长可能和上面的目标
  差一点,第一次试听后可以按需要改稿。
- 动画里还有合成的界面音效(点击、扫描、提示),**默认开着**;想全关请告诉我,加一个开关。
- 英文稿只是备选。画面主文案是中文,中英混用(画面中文、配音英文)是上游原版的做法,
  是否沿用由你定。
