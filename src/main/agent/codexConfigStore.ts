import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import YAML from 'yaml'
import type {
  CodexAuditLogEntry,
  CodexConfigScope,
  CodexMcpServerInput,
  CodexMcpServerListItem,
  CodexSkillInput,
  CodexSkillListItem,
  CodexWorkspacePaths,
} from '../../types/agent'

export interface ResolvePathsInput {
  home: string
  cwd: string
  userData: string
}

export function resolveWorkspacePaths(input: ResolvePathsInput): CodexWorkspacePaths {
  return {
    personalConfigToml: path.join(input.home, '.codex', 'config.toml'),
    personalSkillsRoot: path.join(input.home, '.agents', 'skills'),
    workspaceConfigToml: path.join(input.cwd, '.codex', 'workspace-mcp.toml'),
    workspaceSkillsRoot: path.join(input.cwd, '.agents', 'skills'),
    runtimeConfigToml: path.join(input.userData, 'codex-runtime', 'config.toml'),
    auditLogPath: path.join(input.userData, 'codex-runtime', 'audit.log'),
  }
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
}

export async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  await ensureParentDir(filePath)
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  const handle = await fs.open(tmp, 'w')
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(tmp, filePath)
}

export async function appendAuditLog(
  auditLogPath: string,
  entry: CodexAuditLogEntry,
): Promise<void> {
  await ensureParentDir(auditLogPath)
  await fs.appendFile(auditLogPath, JSON.stringify(entry) + '\n', 'utf8')
}

export async function readAuditLog(
  auditLogPath: string,
  options: { limit?: number; sinceIso?: string } = {},
): Promise<CodexAuditLogEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(auditLogPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const parsed: CodexAuditLogEntry[] = []
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as CodexAuditLogEntry)
    } catch {
      // skip malformed lines
    }
  }
  let filtered = parsed
  if (options.sinceIso) filtered = filtered.filter((e) => e.tsIso >= options.sinceIso!)
  if (options.limit) filtered = filtered.slice(-options.limit)
  return filtered
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw err
  }
}

function parseMcpServers(raw: string): Record<string, Record<string, unknown>> {
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = parseToml(raw)
  } catch {
    return {}
  }
  const root =
    (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).mcp_servers) || {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = v as Record<string, unknown>
    }
  }
  return out
}

function summarizeServer(
  name: string,
  raw: Record<string, unknown>,
  scope: CodexConfigScope,
  lastModifiedIso: string,
): CodexMcpServerListItem {
  const command = typeof raw.command === 'string' ? raw.command : ''
  const args = Array.isArray(raw.args) ? (raw.args as unknown[]).map(String) : []
  const env =
    raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)
      ? (raw.env as Record<string, unknown>)
      : {}
  const envKeys = Object.keys(env).sort()
  const description = typeof raw.description === 'string' ? raw.description : undefined
  const enabled = raw.enabled === false ? false : true
  return {
    id: `${scope}:${name}`,
    name,
    scope,
    enabled,
    command,
    argsSummary: [command, ...args].join(' ').trim(),
    envKeysRedacted: envKeys,
    description,
    lastModifiedIso,
    provenance: 'manual',
    warnings: [],
  }
}

export async function listMcp(paths: CodexWorkspacePaths): Promise<CodexMcpServerListItem[]> {
  const [personalRaw, workspaceRaw, personalStat, workspaceStat] = await Promise.all([
    readFileOrEmpty(paths.personalConfigToml),
    readFileOrEmpty(paths.workspaceConfigToml),
    fs.stat(paths.personalConfigToml).catch(() => null),
    fs.stat(paths.workspaceConfigToml).catch(() => null),
  ])
  const items: CodexMcpServerListItem[] = []
  for (const [name, raw] of Object.entries(parseMcpServers(personalRaw))) {
    items.push(
      summarizeServer(
        name,
        raw,
        'personal',
        personalStat?.mtime.toISOString() ?? new Date().toISOString(),
      ),
    )
  }
  for (const [name, raw] of Object.entries(parseMcpServers(workspaceRaw))) {
    items.push(
      summarizeServer(
        name,
        raw,
        'workspace',
        workspaceStat?.mtime.toISOString() ?? new Date().toISOString(),
      ),
    )
  }
  return items.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getMcpDetail(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<CodexMcpServerInput | null> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return null
  const target = scope === 'personal' ? paths.personalConfigToml : paths.workspaceConfigToml
  const raw = await readFileOrEmpty(target)
  const servers = parseMcpServers(raw)
  const entry = servers[name]
  if (!entry) return null
  const env =
    entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? (entry.env as Record<string, unknown>)
      : {}
  return {
    id,
    name,
    scope,
    enabled: entry.enabled === false ? false : true,
    command: typeof entry.command === 'string' ? entry.command : '',
    args: Array.isArray(entry.args) ? (entry.args as unknown[]).map(String) : [],
    env: Object.entries(env).map(([key, value]) => ({ key, value: String(value ?? '') })),
    description: typeof entry.description === 'string' ? entry.description : undefined,
  }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

function validateName(name: string): string | null {
  if (!name) return 'name is required'
  if (name.includes('\0')) return 'name must not contain NUL'
  if (name.includes('/') || name.includes('\\')) return 'name must not contain path separators'
  if (name === '.' || name === '..') return 'name must not be a relative path'
  if (!NAME_RE.test(name)) return 'name must match [A-Za-z0-9][A-Za-z0-9_.-]{0,63}'
  return null
}

export interface SaveMcpResult {
  ok: boolean
  id?: string
  error?: string
  warnings: string[]
}

export async function saveMcp(
  paths: CodexWorkspacePaths,
  input: CodexMcpServerInput,
): Promise<SaveMcpResult> {
  const nameError = validateName(input.name)
  if (nameError) return { ok: false, error: nameError, warnings: [] }
  const target = input.scope === 'personal' ? paths.personalConfigToml : paths.workspaceConfigToml
  const raw = await readFileOrEmpty(target)
  let document: Record<string, unknown> = {}
  if (raw.trim()) {
    try {
      document = parseToml(raw) as Record<string, unknown>
    } catch (err) {
      return {
        ok: false,
        error: `existing TOML parse error: ${(err as Error).message}`,
        warnings: [],
      }
    }
  }
  const servers = (
    document.mcp_servers && typeof document.mcp_servers === 'object'
      ? document.mcp_servers
      : {}
  ) as Record<string, Record<string, unknown>>
  const envObject: Record<string, string> = {}
  for (const { key, value } of input.env) {
    if (!key) continue
    envObject[key] = value
  }
  const entry: Record<string, unknown> = {
    command: input.command,
    args: input.args,
  }
  if (Object.keys(envObject).length > 0) entry.env = envObject
  if (input.description) entry.description = input.description
  if (input.enabled === false) entry.enabled = false
  servers[input.name] = entry
  document.mcp_servers = servers
  const serialized = iarnaToml.stringify(document as iarnaToml.JsonMap)
  await atomicWriteFile(target, serialized)
  return { ok: true, id: `${input.scope}:${input.name}`, warnings: [] }
}

async function rewriteScope(
  paths: CodexWorkspacePaths,
  scope: CodexConfigScope,
  mutate: (servers: Record<string, Record<string, unknown>>) => void,
): Promise<{ ok: boolean; error?: string }> {
  const target = scope === 'personal' ? paths.personalConfigToml : paths.workspaceConfigToml
  const raw = await readFileOrEmpty(target)
  let document: Record<string, unknown> = {}
  if (raw.trim()) {
    try {
      document = parseToml(raw) as Record<string, unknown>
    } catch (err) {
      return { ok: false, error: `existing TOML parse error: ${(err as Error).message}` }
    }
  }
  const servers = (
    document.mcp_servers && typeof document.mcp_servers === 'object'
      ? document.mcp_servers
      : {}
  ) as Record<string, Record<string, unknown>>
  mutate(servers)
  if (Object.keys(servers).length === 0) delete document.mcp_servers
  else document.mcp_servers = servers
  await atomicWriteFile(target, iarnaToml.stringify(document as iarnaToml.JsonMap))
  return { ok: true }
}

export async function deleteMcp(paths: CodexWorkspacePaths, id: string) {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return { ok: false, error: 'bad scope' }
  return rewriteScope(paths, scope, (servers) => {
    delete servers[name]
  })
}

export async function setMcpEnabled(paths: CodexWorkspacePaths, id: string, enabled: boolean) {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return { ok: false, error: 'bad scope' }
  return rewriteScope(paths, scope, (servers) => {
    if (!servers[name]) return
    if (enabled) delete servers[name].enabled
    else servers[name].enabled = false
  })
}

// ---------------------------------------------------------------------------
// Skill CRUD
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

interface ParsedFrontmatter {
  description?: string
  whenToUse?: string
  name?: string
  body: string
}

function parseFrontmatter(raw: string): ParsedFrontmatter {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return { body: raw }
  let parsed: Record<string, unknown> = {}
  try { parsed = (YAML.parse(m[1]) ?? {}) as Record<string, unknown> } catch { /* malformed */ }
  return {
    name: typeof parsed.name === 'string' ? parsed.name : undefined,
    description: typeof parsed.description === 'string' ? parsed.description : undefined,
    whenToUse: typeof parsed.whenToUse === 'string' ? parsed.whenToUse : undefined,
    body: m[2],
  }
}

function buildSkillFile(input: CodexSkillInput): string {
  const fm: Record<string, string> = { name: input.name }
  if (input.description) fm.description = input.description
  if (input.whenToUse) fm.whenToUse = input.whenToUse
  const yaml = YAML.stringify(fm).trimEnd()
  return `---\n${yaml}\n---\n${input.instructions}\n`
}

async function listSkillsInRoot(
  root: string,
  scope: CodexConfigScope,
): Promise<CodexSkillListItem[]> {
  const entries: CodexSkillListItem[] = []
  let dirents: import('node:fs').Dirent[]
  try { dirents = await fs.readdir(root, { withFileTypes: true }) } catch { return [] }
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const skillPath = path.join(root, d.name, 'SKILL.md')
    let raw: string
    try { raw = await fs.readFile(skillPath, 'utf8') } catch { continue }
    const fm = parseFrontmatter(raw)
    entries.push({
      id: `${scope}:${d.name}`,
      name: fm.name ?? d.name,
      scope,
      path: skillPath,
      description: fm.description,
      warnings: [],
    })
  }
  return entries
}

export async function listSkills(paths: CodexWorkspacePaths): Promise<CodexSkillListItem[]> {
  const [personal, workspace] = await Promise.all([
    listSkillsInRoot(paths.personalSkillsRoot, 'personal'),
    listSkillsInRoot(paths.workspaceSkillsRoot, 'workspace'),
  ])
  return [...personal, ...workspace].sort((a, b) => a.name.localeCompare(b.name))
}

export async function getSkillDetail(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<CodexSkillInput | null> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return null
  const root = scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const filePath = path.join(root, name, 'SKILL.md')
  let raw: string
  try { raw = await fs.readFile(filePath, 'utf8') } catch { return null }
  const fm = parseFrontmatter(raw)
  return {
    id,
    name: fm.name ?? name,
    scope,
    description: fm.description ?? '',
    whenToUse: fm.whenToUse ?? '',
    instructions: fm.body.trimStart(),
  }
}

export async function saveSkill(
  paths: CodexWorkspacePaths,
  input: CodexSkillInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const err = validateName(input.name)
  if (err) return { ok: false, error: err }
  const root = input.scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const dir = path.join(root, input.name)
  const file = path.join(dir, 'SKILL.md')
  await fs.mkdir(dir, { recursive: true })
  await atomicWriteFile(file, buildSkillFile(input))
  return { ok: true, id: `${input.scope}:${input.name}` }
}

export async function deleteSkill(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (scope !== 'personal' && scope !== 'workspace') return { ok: false, error: 'bad scope' }
  const root = scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const dir = path.join(root, name)
  await fs.rm(dir, { recursive: true, force: true })
  return { ok: true }
}
