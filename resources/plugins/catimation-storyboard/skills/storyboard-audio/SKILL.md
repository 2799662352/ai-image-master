---
name: storyboard-audio
description: 【分镜模式·音频 / Storyboard · Audio】触发词:配乐 / 音效 / 配音 / 声音设计 / BGM / 三层音频 / 乐器 / bpm / 混响 / score / SFX / voice / sound design。Use when each shot needs a three-layer audio field — A1 Score (ref:Composer/Work + 乐器 + 力度 pp-ff + 速度 bpm + 张力值 0-10, derived via score_bpm = motion_freq × 60), A2 SFX (材质 + 动作 + 频率Hz + 衰减s + 空间定位), A3 Voice (基频Hz + 气声比% + 语速字/秒 + 混响 RT60) — banning emotion adjectives in favor of physical parameters (配乐 / 音效 / 配音) — applies to image-generation models (Midjourney, DALL-E, FLUX, Stable Diffusion, Imagen, Ideogram, Recraft), video-generation models (Sora, Veo, Runway, Kling, Seedance, Hailuo, Higgsfield, Hunyuan), screenplays, scripts, storyboards, AI video, AI image, 提示词, 视频模型, 图像模型, 写剧本, 脚本, 分镜.
---

Audio Design Rules (每个镜头必须有audio字段，含三层):
A1. Score: 引用一部你认为最匹配当前镜头情绪的真实影视配乐作品, 格式 "ref:Composer/Work → 乐器, 力度(pp-ff), 速度bpm, 张力值(0-10)"
A2. SFX: 与画面动作帧级同步, 格式 "材质+动作+频率Hz+衰减s+空间定位"
A3. Voice: 台词用物理参数描述声线, 格式 "基频Hz, 气声比%, 语速字/秒, 物理表现, 混响RT60"

选择方法(A1):
1. 评估镜头情绪张力值(0-10): 0=完全静默, 3=温柔/不安, 5=紧张, 7=对抗, 9=爆发/崩塌, 回落=余韵
2. 确定文化语境: 场景是东亚古典→选用该文化的作曲家; 现代/科幻→选现代电影配乐家; 不限定→选最匹配音色DNA的
3. 从你的知识中选出一位作曲家的一部具体作品 — 优先选择获得奥斯卡/金球奖/BAFTA提名的配乐, 或公认大师级作曲家的代表作, 其音色DNA最接近该张力+语境
4. 每镜头只选一部作品, 且整个分镜序列中尽量不重复同一作曲家

音色DNA选择标准(按张力维度):
T0-1: 单一乐器+大量留白, 音符间沉默>音符本身
T1-3: 独奏或小编制, pp力度, 慢速<70bpm, 旋律简单温暖
T3-5: 不谐和音程, 不规则节奏, 低频drone, 令人不安但未爆发
T5-7: 渐强ostinato, 半音阶上行, 打击乐或工业音色加入
T7-8: 低音弦乐墙+打击脉冲, ff力度, 压迫性渐强无释放
T8-9: 全编制齐奏, 铜管/合唱爆发, 节奏峰值
T9-10: 旋律碎裂为噪音, 频率过载, 可能骤停
T回落: 混响尾音拉长, 单音衰减, 归于环境底噪

同步公式: score_bpm = 主体运动频率Hz × 60; 音量dB = 张力值 × 6 - 40
声线规则: 禁止情绪形容词(sexy/angry/sad), 用物理参数(Hz/bpm/%)替代
音频dodge: 呻吟→声带颤抖, 尖叫→频率突破3kHz, 喘息→呼吸频率加速
乐器选择: 根据场景文化语境选择(东亚古典/日本传统/西方管弦/现代电子/极简独奏)

## 示例

一个镜头的 audio 字段(黄昏推门进屋,张力 4):
- A1 Score: ref:Jóhann Jóhannsson/Arrival → 低音弦乐 drone + 雾化合唱, pp→mp, 56bpm, 张力 4
- A2 SFX: 木门铰链摩擦 + 缓慢推开, 220Hz, 衰减 0.8s, 偏左 30° 近场
- A3 Voice: 基频 180Hz, 气声比 35%, 语速 3 字/秒, 喉部紧绷, 混响 RT60 0.6s
(全部用物理参数,无 sad/tense 等情绪词;score_bpm 由主体动作频率推得。)
