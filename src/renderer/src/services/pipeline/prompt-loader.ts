/// <reference types="vite/client" />
import type { PipelineSkill } from './types'

// ==================== Build-time Eager Loading ====================

// Vite docs confirm import.meta.glob supports resolve.alias paths.
// @skills → <root>/skills, @config → <root>/config (see electron.vite.config.ts)
const promptModules = import.meta.glob(
  './../../../../../config/prompts/director/*.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

const skillModules = import.meta.glob(
  './../../../../../skills/director-*/SKILL.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

if (import.meta.env.DEV) {
  console.log(`[prompt-loader] promptModules: ${Object.keys(promptModules).length} files`, Object.keys(promptModules))
  console.log(`[prompt-loader] skillModules: ${Object.keys(skillModules).length} files`, Object.keys(skillModules))
}

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
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const match = normalized.match(/^\s*---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yaml = match[1]
  const body = match[2].trim()

  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const appliesToInlineRaw = yaml.match(/^appliesTo:\s*\[([^\]]*)\]\s*$/m)?.[1]
  const appliesToBlockRaw = yaml.match(/^appliesTo:\s*\n((?:\s*-\s*.+\n?)*)/m)?.[1]
  const appliesTo = appliesToInlineRaw
    ? appliesToInlineRaw
      .split(',')
      .map(s => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
    : (appliesToBlockRaw
      ? appliesToBlockRaw
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.startsWith('- '))
        .map(line => line.slice(2).trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      : [])
  if (!name || appliesTo.length === 0) return null

  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
  const priorityStr = yaml.match(/^priority:\s*(\d+)$/m)?.[1]
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50

  return { id: name, description, rules: body, appliesTo, priority }
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

let _builtinSkillCache: PipelineSkill[] | null = null
let _skillCache: PipelineSkill[] | null = null
let _skillInitPromise: Promise<void> | null = null
let _lastSkillLoadStats: DirectorSkillLoadStats | null = null

export interface DirectorSkillLoadStats {
  builtinCount: number
  userCount: number
  mergedCount: number
  addedCount: number
  overriddenCount: number
}

function getBuiltinDirectorSkills(): PipelineSkill[] {
  if (_builtinSkillCache) return _builtinSkillCache
  const builtinSkills: PipelineSkill[] = []
  for (const [path, raw] of Object.entries(skillModules)) {
    const skill = parseSkillFromMarkdown(raw)
    if (skill) {
      builtinSkills.push(skill)
    } else {
      console.warn(`[prompt-loader] Failed to parse skill: ${path}`)
    }
  }
  _builtinSkillCache = builtinSkills.sort((a, b) => a.priority - b.priority)
  return _builtinSkillCache
}

async function loadUserDirectorSkills(): Promise<PipelineSkill[]> {
  const loadSkills = window.electronAPI?.loadSkills
  if (typeof loadSkills !== 'function') return []

  let skillContents: Record<string, string>
  try {
    skillContents = await loadSkills()
  } catch (error) {
    console.warn('[prompt-loader] Failed to load user skills', error)
    return []
  }

  const userSkills: PipelineSkill[] = []
  for (const [path, raw] of Object.entries(skillContents)) {
    const skill = typeof raw === 'string' ? parseSkillFromMarkdown(raw) : null
    if (skill) {
      userSkills.push(skill)
    } else {
      console.warn(`[prompt-loader] Failed to parse user skill: ${path}`)
    }
  }
  return userSkills
}

function mergeDirectorSkills(
  builtinSkills: PipelineSkill[],
  userSkills: PipelineSkill[],
): PipelineSkill[] {
  const merged = new Map<string, PipelineSkill>()
  for (const skill of builtinSkills) merged.set(skill.id, skill)
  for (const skill of userSkills) merged.set(skill.id, skill)
  return Array.from(merged.values()).sort((a, b) => a.priority - b.priority)
}

async function loadAndCacheDirectorSkills(): Promise<void> {
  const builtinSkills = getBuiltinDirectorSkills()
  const userSkills = await loadUserDirectorSkills()
  _skillCache = mergeDirectorSkills(builtinSkills, userSkills)
  const builtinIds = new Set(builtinSkills.map((s) => s.id))
  let overriddenCount = 0
  let addedCount = 0
  for (const skill of userSkills) {
    if (builtinIds.has(skill.id)) overriddenCount += 1
    else addedCount += 1
  }
  _lastSkillLoadStats = {
    builtinCount: builtinSkills.length,
    userCount: userSkills.length,
    mergedCount: _skillCache.length,
    addedCount,
    overriddenCount,
  }
}

export async function initDirectorSkills(): Promise<void> {
  if (_skillCache) return
  if (_skillInitPromise) {
    await _skillInitPromise
    return
  }
  _skillInitPromise = loadAndCacheDirectorSkills().finally(() => {
    _skillInitPromise = null
  })
  await _skillInitPromise
}

export async function reloadDirectorSkills(): Promise<void> {
  if (_skillInitPromise) await _skillInitPromise
  _skillCache = null
  await initDirectorSkills()
}

export function getDirectorSkillsFromConfig(): PipelineSkill[] {
  if (_skillCache) return [..._skillCache]
  return [...getBuiltinDirectorSkills()]
}

export function getDirectorSkillLoadStats(): DirectorSkillLoadStats {
  if (_lastSkillLoadStats) return { ..._lastSkillLoadStats }
  const builtinCount = getBuiltinDirectorSkills().length
  return {
    builtinCount,
    userCount: 0,
    mergedCount: builtinCount,
    addedCount: 0,
    overriddenCount: 0,
  }
}
