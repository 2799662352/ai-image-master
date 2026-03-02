/// <reference types="vite/client" />
import type { PipelineSkill } from './types'

// ==================== Build-time Eager Loading ====================

const promptModules = import.meta.glob(
  '/config/prompts/director/*.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

const skillModules = import.meta.glob(
  '/skills/director-*/SKILL.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

// ==================== Prompt Template Parser ====================

interface PromptFrontmatter {
  [key: string]: string | number | boolean | string[]
}

interface ParsedPromptMd {
  meta: PromptFrontmatter
  body: string
}

function parsePromptFrontmatter(raw: string): ParsedPromptMd {
  const normalized = raw.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: normalized.trim() }

  const meta: PromptFrontmatter = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let val: string | number | boolean | string[] = line.slice(idx + 1).trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map(s => s.trim())
    } else if (val === 'true') {
      val = true
    } else if (val === 'false') {
      val = false
    } else if (/^\d+$/.test(val)) {
      val = Number(val)
    }
    meta[key] = val
  }
  return { meta, body: match[2].trim() }
}

// ==================== Skill Parser (aligned with storyboard skill-loader) ====================

function parseSkillFromMarkdown(raw: string): PipelineSkill | null {
  const normalized = raw.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yaml = match[1]
  const body = match[2].trim()

  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const appliesToRaw = yaml.match(/^appliesTo:\s*\[([^\]]+)\]$/m)?.[1]
  if (!name || !appliesToRaw) return null

  const appliesTo = appliesToRaw.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
  const priorityStr = yaml.match(/^priority:\s*(\d+)$/m)?.[1]
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50

  return { id: name, rules: body, appliesTo, priority }
}

// ==================== Template Engine ====================

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

// ==================== Prompt Configs ====================

export interface PromptConfig {
  pass: number
  name: string
  label: string
  vision: string | boolean
  template: string
}

const promptCache = new Map<string, PromptConfig>()

function ensurePromptsLoaded(): void {
  if (promptCache.size > 0) return
  for (const [, raw] of Object.entries(promptModules)) {
    const { meta, body } = parsePromptFrontmatter(raw)
    const name = (meta.name as string) || ''
    if (!name) continue
    promptCache.set(name, {
      pass: (meta.pass as number) || 0,
      name,
      label: (meta.label as string) || name,
      vision: typeof meta.vision === 'string' || typeof meta.vision === 'boolean'
        ? meta.vision
        : false,
      template: body,
    })
  }
}

export function getPromptTemplate(passName: string): PromptConfig | undefined {
  ensurePromptsLoaded()
  return promptCache.get(passName)
}

export function getAllPromptConfigs(): PromptConfig[] {
  ensurePromptsLoaded()
  return Array.from(promptCache.values()).sort((a, b) => a.pass - b.pass)
}

// ==================== Skill Configs ====================

let _skillCache: PipelineSkill[] | null = null

function ensureSkillsLoaded(): void {
  if (_skillCache) return
  const skills: PipelineSkill[] = []
  for (const [path, raw] of Object.entries(skillModules)) {
    const skill = parseSkillFromMarkdown(raw)
    if (skill) {
      skills.push(skill)
    } else {
      console.warn(`[prompt-loader] Failed to parse skill: ${path}`)
    }
  }
  _skillCache = skills.sort((a, b) => a.priority - b.priority)
}

export function getDirectorSkillsFromConfig(): PipelineSkill[] {
  ensureSkillsLoaded()
  return [..._skillCache!]
}
