import type { PipelineSkill } from './types'

/**
 * SkillsMiddleware — Deep Agents-aligned skill system.
 *
 * Implements the progressive disclosure pattern from LangChain's SkillsMiddleware:
 * 1. Init: reads skill frontmatter (id + description only)
 * 2. wrapSystemPrompt: injects skill menu (descriptions) into system prompt
 * 3. loadSkill: returns full skill body on-demand (LLM calls this)
 *
 * Extended with DirectorPipeline features:
 * - appliesTo: phase-based filtering (skills only appear in relevant passes)
 * - priority: ordering within a phase
 * - condition: dynamic context-based filtering
 * - _rawBody / _bodyLoaded: lazy body loading
 */
export class SkillsMiddleware {
  readonly skills: PipelineSkill[]

  constructor(skills: PipelineSkill[]) {
    this.skills = [...skills].sort((a, b) => a.priority - b.priority)
  }

  getSkillCount(): number {
    return this.skills.length
  }

  private matchPhase(phase: string, context?: Record<string, unknown>): PipelineSkill[] {
    return this.skills
      .filter(s => s.appliesTo.includes(phase))
      .filter(s => !s.condition || s.condition(context || {}))
  }

  buildSkillMenu(phase: string, context?: Record<string, unknown>): string {
    const matched = this.matchPhase(phase, context)
    if (matched.length === 0) return ''
    return matched.map(s => `- ${s.id}: ${s.description}`).join('\n')
  }

  loadSkill(skillId: string, phase: string, context?: Record<string, unknown>): string {
    const matched = this.matchPhase(phase, context)
    const skill = matched.find(s => s.id === skillId)
    if (!skill) {
      const available = matched.map(s => s.id).join(', ')
      return `Skill '${skillId}' not found for phase '${phase}'. Available: ${available || '(none)'}`
    }

    if (skill._bodyLoaded === false && skill._rawBody) {
      skill.rules = skill._rawBody
      skill._bodyLoaded = true
    }

    const body = typeof skill.rules === 'function' ? skill.rules(context || {}) : skill.rules
    return `[Skill:${skill.id}]\n${body}`
  }

  loadSkills(skillIds: string[], phase: string, context?: Record<string, unknown>): string {
    return skillIds
      .map(id => this.loadSkill(id, phase, context))
      .filter(s => !s.startsWith("Skill '"))
      .join('\n\n')
  }

  wrapSystemPrompt(basePrompt: string, phase: string, context?: Record<string, unknown>): string {
    const menu = this.buildSkillMenu(phase, context)
    if (!menu) return basePrompt
    return `${basePrompt}\n\n## Available Skills (use loadSkill to read full content)\n${menu}\n\nIf any skills are relevant, include their IDs in your requestedSkills list. You will receive the full skill content before generating the final output.`
  }

  getAllSkillIds(phase: string, context?: Record<string, unknown>): string[] {
    return this.matchPhase(phase, context).map(s => s.id)
  }
}
