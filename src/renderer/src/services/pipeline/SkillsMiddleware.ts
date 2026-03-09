import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import type { PipelineSkill } from './types'

export class VirtualSkillsBackend {
  private files: Map<string, string>

  constructor(skills: PipelineSkill[], phase: string, context?: Record<string, unknown>) {
    this.files = new Map()
    const matched = skills
      .filter(s => s.appliesTo.includes(phase))
      .filter(s => !s.condition || s.condition(context || {}))
      .sort((a, b) => a.priority - b.priority)
    for (const skill of matched) {
      if (skill._bodyLoaded === false && skill._rawBody) {
        skill.rules = skill._rawBody
        skill._bodyLoaded = true
      }
      const body = typeof skill.rules === 'function' ? skill.rules(context || {}) : skill.rules
      this.files.set(`/skills/${skill.id}/SKILL.md`, `---\nname: ${skill.id}\ndescription: ${skill.description}\n---\n\n${body}`)
    }
  }

  read(filePath: string): string {
    const content = this.files.get(filePath)
    if (!content) return `Error: File '${filePath}' not found`
    return content
  }

  ls(): string[] {
    return [...this.files.keys()]
  }

  get fileCount(): number {
    return this.files.size
  }
}

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

  createReadFileTool(phase: string, context?: Record<string, unknown>) {
    const backend = new VirtualSkillsBackend(this.skills, phase, context)
    if (backend.fileCount === 0) return null

    const paths = backend.ls()
    return tool(
      async ({ file_path }: { file_path: string }) => backend.read(file_path),
      {
        name: 'read_file',
        description: `Read a file from the skills filesystem. Available skill files:\n${paths.join('\n')}`,
        schema: z.object({
          file_path: z.string().describe('Absolute path to the skill file, e.g. /skills/my-skill/SKILL.md'),
        }),
      },
    )
  }
}
