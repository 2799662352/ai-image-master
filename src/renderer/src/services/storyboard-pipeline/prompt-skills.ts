import type { CharacterAnchor } from './schemas'
import { loadAllSkills } from './skill-loader'

export type PassType = 'scene' | 'character' | 'shot' | 'verify'

export interface PipelineStateSlice {
  retryFeedback?: string
  previousShots?: Array<{ id: string; desc: string }> | null
  characters?: CharacterAnchor[] | null
  sceneDescription?: string
}

export interface PromptSkill {
  id: string
  rules: string | ((state: PipelineStateSlice) => string)
  appliesTo: PassType[]
  priority: number
  condition?: (state: PipelineStateSlice) => boolean
}

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

const DYNAMIC_SKILLS: PromptSkill[] = [
  { id: 'continuity', rules: buildContinuityLock, appliesTo: ['shot'], priority: 30 },
]

const embeddedFiles = import.meta.glob('@skills/*/SKILL.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
let _cachedSkills: PromptSkill[] | null = null

async function loadSkillsFromDisk(): Promise<Record<string, string>> {
  try {
    const api = (window as any).electronAPI
    if (api?.loadSkills) return await api.loadSkills()
  } catch { /* not in Electron */ }
  return {}
}

export async function initSkills(): Promise<PromptSkill[]> {
  const embedded = loadAllSkills(embeddedFiles)
  const skillMap = new Map<string, PromptSkill>()
  for (const s of embedded) skillMap.set(s.id, s)

  const diskFiles = await loadSkillsFromDisk()
  const diskSkills = loadAllSkills(
    Object.fromEntries(Object.entries(diskFiles).map(([name, content]) => [`skills/${name}/SKILL.md`, content]))
  )
  for (const s of diskSkills) skillMap.set(s.id, s)

  const merged = Array.from(skillMap.values())
  const diskCount = diskSkills.length
  console.log(`[PromptSkill] ${merged.length} skills (${diskCount} from disk, ${merged.length - diskCount} embedded)`)
  _cachedSkills = [...merged, ...DYNAMIC_SKILLS]
  return _cachedSkills
}

export function getBuiltinSkills(): PromptSkill[] {
  if (_cachedSkills) return _cachedSkills
  const embedded = loadAllSkills(embeddedFiles)
  _cachedSkills = [...embedded, ...DYNAMIC_SKILLS]
  return _cachedSkills
}

export const BUILTIN_SKILLS = getBuiltinSkills()

export function buildRulesForPass(
  pass: PassType,
  skills: PromptSkill[],
  state?: PipelineStateSlice
): string {
  const matched = skills
    .filter(s => s.appliesTo.includes(pass))
    .filter(s => !s.condition || s.condition(state || {}))
    .sort((a, b) => a.priority - b.priority)

  const ids = matched.map(s => s.id)
  console.log(`[PromptSkill] Pass "${pass}" → ${ids.length} skills: [${ids.join(', ')}]`)

  return matched
    .map(s => {
      const rules = typeof s.rules === 'function' ? s.rules(state || {}) : s.rules
      if (!rules) return ''
      return `[Skill:${s.id}]\n${rules}`
    })
    .filter(Boolean)
    .join('\n\n')
}
