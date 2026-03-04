/// <reference types="vite/client" />
import type { PipelineSkill } from '../pipeline/types'

const promptModules = import.meta.glob(
  './../../../../../config/prompts/storyboard/*.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

const skillModules = import.meta.glob(
  './../../../../../skills/storyboard-*/SKILL.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

if (import.meta.env.DEV) {
  console.log(`[storyboard-prompt-loader] promptModules: ${Object.keys(promptModules).length} files`, Object.keys(promptModules))
  console.log(`[storyboard-prompt-loader] skillModules: ${Object.keys(skillModules).length} files`, Object.keys(skillModules))
}

interface PromptConfig {
  pass: number
  name: string
  label: string
  template: string
}

function parsePromptFrontmatter(raw: string): { meta: Record<string, any>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: normalized.trim() }
  const meta: Record<string, any> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let val: any = line.slice(idx + 1).trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s: string) => s.trim())
    } else if (val === 'true') val = true
    else if (val === 'false') val = false
    else if (/^\d+$/.test(val)) val = Number(val)
    meta[key] = val
  }
  return { meta, body: match[2].trim() }
}

function parseSkillFromMarkdown(raw: string): PipelineSkill | null {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const match = normalized.match(/^\s*---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null
  const yaml = match[1]
  const body = match[2].trim()
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const appliesToInlineRaw = yaml.match(/^appliesTo:\s*\[([^\]]*)\]\s*$/m)?.[1]
  const appliesToBlockRaw = yaml.match(/^appliesTo:\s*\n((?:\s*-\s*.+\n?)*)/m)?.[1]
  const appliesTo = appliesToInlineRaw
    ? appliesToInlineRaw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : (appliesToBlockRaw
      ? appliesToBlockRaw.split('\n').map(line => line.trim()).filter(line => line.startsWith('- ')).map(line => line.slice(2).trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : [])
  if (!name || appliesTo.length === 0) return null
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
  const priorityStr = yaml.match(/^priority:\s*(\d+)$/m)?.[1]
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50
  return { id: name, description, rules: body, appliesTo, priority }
}

const promptCache = new Map<string, PromptConfig>()

function ensurePromptsLoaded(): void {
  if (promptCache.size > 0) return
  for (const [, raw] of Object.entries(promptModules)) {
    const { meta, body } = parsePromptFrontmatter(raw)
    const name = (meta.name as string) || ''
    if (!name) continue
    promptCache.set(name, { pass: (meta.pass as number) || 0, name, label: (meta.label as string) || name, template: body })
  }
}

export function getStoryboardPromptTemplate(passName: string): PromptConfig | undefined {
  ensurePromptsLoaded()
  return promptCache.get(passName)
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

let _skillCache: PipelineSkill[] | null = null

export function getStoryboardSkills(): PipelineSkill[] {
  if (_skillCache) return [..._skillCache]
  const skills: PipelineSkill[] = []
  for (const [, raw] of Object.entries(skillModules)) {
    const skill = parseSkillFromMarkdown(raw)
    if (skill) skills.push(skill)
  }
  _skillCache = skills.sort((a, b) => a.priority - b.priority)
  return [..._skillCache]
}
