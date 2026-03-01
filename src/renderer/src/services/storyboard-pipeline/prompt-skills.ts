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
1. Physical lighting: 80% deep shadows + single rim light, never emotion adjectives
2. Color hierarchy: dominated by [key] + faint [accent], never equal warm+cool
3. Lens: always [mm] f/[stop], never "8k/masterpiece"
4. Mid-action snapshot: freeze at peak tension, never "then/after"
5. Micro-expression: physiological (brow furrowed 2mm) not emotional (happy/sad)
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

export const BUILTIN_SKILLS: PromptSkill[] = [
  { id: 'core',       rules: CORE_RULES,         appliesTo: ['scene', 'character', 'shot', 'verify'], priority: 0 },
  { id: 'dialogue',   rules: DIALOGUE_RULES,     appliesTo: ['shot', 'verify'],                      priority: 10 },
  { id: 'physics',    rules: PHYSICS_RULES,       appliesTo: ['character', 'shot'],                   priority: 10 },
  { id: 'style',      rules: STYLE_RULES,         appliesTo: ['scene'],                               priority: 10 },
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
