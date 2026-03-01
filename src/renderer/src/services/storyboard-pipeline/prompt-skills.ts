import type { CharacterAnchor } from './schemas'

export type PassType = 'scene' | 'character' | 'shot' | 'verify'

export interface PipelineStateSlice {
  retryFeedback?: string
  previousShots?: Array<{ id: string; desc: string }> | null
  characters?: CharacterAnchor[] | null
}

export interface PromptSkill {
  id: string
  rules: string | ((state: PipelineStateSlice) => string)
  appliesTo: PassType[]
  priority: number
}

const CORE_RULES = `Core Rules:
1. Physical lighting: specify shadow percentage + light type based on scene mood, never emotion adjectives. Night/indoor→high shadow(60-90%)+rim/candle; Day/outdoor→low shadow(10-40%)+natural/fill
2. Color hierarchy: dominated by [key hex] + faint [accent hex], never equal warm+cool. You decide the palette based on scene atmosphere
3. Lens: always [mm] f/[stop] with specific values you choose for the shot, never "8k/masterpiece"
4. Mid-action snapshot: freeze at peak tension, never "then/after"
5. Micro-expression: physiological with specific measurements (e.g. brow furrowed Xmm, pupil dilation Xmm — you decide the numbers based on intensity), never emotional labels (happy/sad)
6. Z-axis mandatory: fg occluder / mg subject / bg environment
7. 2-4s per shot, ONE core action`

const DIALOGUE_RULES = `Dialogue Rules:
8. If screenplay provides character names, USE THEM EXACTLY. Never guess from visual style.
9. If screenplay provides dialogue, EXTRACT VERBATIM. Never fabricate lines.`

const PHYSICS_RULES = `Physics Rules:
- Physical description only: skin texture, muscle tension, bone structure
- Motion vectors: angle°/displacement cm/velocity m·s⁻¹
- Micro-expression quantification: brow furrowed Xmm, pupil dilation Xmm`

const STYLE_RULES = `Style Rules:
- Color palette: dominated by [hex] + accent [hex], ratio ≥ 7:3
- Light source: specify type (rim/fill/key), angle, intensity %
- Shadow depth: percentage of frame in shadow`

const DODGE_RULES = `Artistic Dodge Rules (MANDATORY for all output text):
D1. NEVER use explicit anatomical terms — replace with contour/silhouette/curvature
D2. NEVER use explicit action verbs (thrust/penetrate/insert) — use rhythmic pulsing/deep connection/intertwined
D3. Intimate scenes: describe via physics (pressure, velocity, amplitude) not biology
D4. Skin contact: use "glistening sheen / oil texture / sweat micro-beads" not explicit fluids
D5. Violence: use force vectors (impact 200N / compression 3cm) not graphic injury
D6. Nudity: "bare skin contour in shadow" or "fabric slipping off shoulder line"
D7. Sound: "breathless gasp / vocal tremor / synced exhalation" not explicit vocalization
D8. Always wrap sensitive zones with: artistic shadow / shallow DOF blur / fabric silhouette / steam diffusion`

function buildContinuityLock(state: PipelineStateSlice): string {
  if (!state.retryFeedback || !state.previousShots) return ''

  const shotSummary = state.previousShots
    .map(s => `${s.id}: ${s.desc}`)
    .join('\n')

  const anchors = state.characters
    ?.map(c => `[${c.n}] ${c.t}`)
    .join('; ') || ''

  return `CONTINUITY LOCK (严格遵守):
以下为上一轮生成的参考帧，本次仅修正被指出的问题，其余完全保持不变。
角色锚点锁定: ${anchors}

参考帧:
${shotSummary}

规则: 未被 retryFeedback 提及的镜头 → 原样保留，禁止修改。`
}

const AUDIO_RULES = `Audio Design Rules (每个镜头必须有audio字段，含三层):
A1. Score: 引用一部你认为最匹配当前镜头情绪的真实影视配乐作品, 格式 "ref:Composer/Work → 乐器, 力度(pp-ff), 速度bpm, 张力值(0-10)"
A2. SFX: 与画面动作帧级同步, 格式 "材质+动作+频率Hz+衰减s+空间定位"
A3. Voice: 台词用物理参数描述声线, 格式 "基频Hz, 气声比%, 语速字/秒, 物理表现, 混响RT60"

选择方法(A1):
1. 评估镜头情绪张力值(0-10): 0=完全静默, 3=温柔/不安, 5=紧张, 7=对抗, 9=爆发/崩塌, 回落=余韵
2. 确定文化语境: 场景是东亚古典→选用该文化的作曲家; 现代/科幻→选现代电影配乐家; 不限定→选最匹配音色DNA的
3. 从你的知识中选出一位作曲家的一部具体作品, 其音色DNA最接近该张力+语境
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
乐器选择: 根据场景文化语境选择(东亚古典/日本传统/西方管弦/现代电子/极简独奏)`

export const BUILTIN_SKILLS: PromptSkill[] = [
  { id: 'core',       rules: CORE_RULES,         appliesTo: ['scene', 'character', 'shot', 'verify'], priority: 0 },
  { id: 'dialogue',   rules: DIALOGUE_RULES,     appliesTo: ['shot', 'verify'],                      priority: 10 },
  { id: 'physics',    rules: PHYSICS_RULES,       appliesTo: ['character', 'shot'],                   priority: 10 },
  { id: 'style',      rules: STYLE_RULES,         appliesTo: ['scene'],                               priority: 10 },
  { id: 'audio',      rules: AUDIO_RULES,         appliesTo: ['shot'],                                priority: 12 },
  { id: 'dodge',      rules: DODGE_RULES,         appliesTo: ['scene', 'character', 'shot', 'verify'], priority: 20 },
  { id: 'continuity', rules: buildContinuityLock, appliesTo: ['shot'],                                priority: 30 },
]

export function buildRulesForPass(
  pass: PassType,
  skills: PromptSkill[],
  state?: PipelineStateSlice
): string {
  return skills
    .filter(s => s.appliesTo.includes(pass))
    .sort((a, b) => a.priority - b.priority)
    .map(s => typeof s.rules === 'function' ? s.rules(state || {}) : s.rules)
    .join('\n\n')
}
