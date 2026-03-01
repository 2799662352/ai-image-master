import type { PromptSkill, PassType, PipelineStateSlice } from './prompt-skills'

interface SkillFrontmatter {
  name: string
  appliesTo: PassType[]
  priority: number
}

function parseFrontmatter(raw: string): { meta: SkillFrontmatter; body: string } | null {
  const match = raw.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]
  const body = match[2].trim()

  const name = yamlBlock.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const priorityStr = yamlBlock.match(/^priority:\s*(\d+)$/m)?.[1]
  const appliesToMatch = yamlBlock.match(/^appliesTo:\s*\[([^\]]+)\]$/m)?.[1]

  if (!name || !appliesToMatch) return null

  const appliesTo = appliesToMatch.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')) as PassType[]
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50

  return { meta: { name, appliesTo, priority }, body }
}

export function loadSkillFromMarkdown(raw: string): PromptSkill | null {
  const parsed = parseFrontmatter(raw)
  if (!parsed) return null

  return {
    id: parsed.meta.name,
    rules: parsed.body,
    appliesTo: parsed.meta.appliesTo,
    priority: parsed.meta.priority,
  }
}

export function loadAllSkills(rawFiles: Record<string, string>): PromptSkill[] {
  const skills: PromptSkill[] = []
  for (const [path, content] of Object.entries(rawFiles)) {
    const skill = loadSkillFromMarkdown(content)
    if (skill) {
      skills.push(skill)
    } else {
      console.warn(`[SkillLoader] Failed to parse: ${path}`)
    }
  }
  return skills.sort((a, b) => a.priority - b.priority)
}
