import { promises as fs } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type {
  CodexAuditLogEntry,
  CodexConfigScope,
  CodexSkillInput,
  CodexSkillListItem,
  CodexSkillListScope,
  CodexWorkspacePaths,
} from '../../types/agent'

export interface ResolvePathsInput {
  home: string
  cwd: string
  userData: string
  /**
   * Electron `process.resourcesPath` when running in packaged mode. When provided,
   * bundled skills shipped inside the installer at `<resourcesPath>/.agents/skills`
   * are exposed as a read-only 'bundled' scope.
   */
  resourcesPath?: string
}

export function resolveWorkspacePaths(input: ResolvePathsInput): CodexWorkspacePaths {
  return {
    personalConfigToml: path.join(input.home, '.codex', 'config.toml'),
    personalSkillsRoot: path.join(input.home, '.agents', 'skills'),
    workspaceConfigToml: path.join(input.cwd, '.codex', 'workspace-mcp.toml'),
    workspaceSkillsRoot: path.join(input.cwd, '.agents', 'skills'),
    systemSkillsRoot: input.resourcesPath
      ? path.join(input.resourcesPath, '.agents', 'skills')
      : undefined,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function appendMutationAudit(
  paths: CodexWorkspacePaths,
  entry: Omit<CodexAuditLogEntry, 'tsIso'>,
): Promise<void> {
  try {
    await appendAuditLog(paths.auditLogPath, {
      tsIso: new Date().toISOString(),
      ...entry,
    })
  } catch {
    // Audit logging is best-effort and must not affect mutation semantics.
  }
}

async function realpathOrParent(p: string): Promise<string> {
  const unresolvedParts: string[] = []
  let current = p
  while (true) {
    try {
      return path.join(await fs.realpath(current), ...unresolvedParts.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return p
      unresolvedParts.push(path.basename(current))
      current = parent
    }
  }
}

async function realpathAnchoredAtLeaf(p: string): Promise<string> {
  const parent = path.dirname(p)
  try {
    return path.join(await fs.realpath(parent), path.basename(p))
  } catch {
    return p
  }
}

async function assertInsideRoot(target: string, root: string): Promise<void> {
  const rRoot = await realpathAnchoredAtLeaf(root)
  const rTarget = await realpathOrParent(target)
  const rel = path.relative(rRoot, rTarget)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path is outside allowed root: ${target}`)
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
  try {
    parsed = (YAML.parse(m[1]) ?? {}) as Record<string, unknown>
  } catch {
    // Malformed frontmatter should not hide the skill body.
  }
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
  scope: CodexSkillListScope,
): Promise<CodexSkillListItem[]> {
  const entries: CodexSkillListItem[] = []
  let dirents: import('node:fs').Dirent[]
  try {
    dirents = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const readOnly = scope === 'system'
  for (const d of dirents) {
    if (!d.isDirectory()) continue
    const skillPath = path.join(root, d.name, 'SKILL.md')
    let raw: string
    try {
      raw = await fs.readFile(skillPath, 'utf8')
    } catch {
      continue
    }
    const fm = parseFrontmatter(raw)
    entries.push({
      id: `${scope}:${d.name}`,
      name: fm.name ?? d.name,
      scope,
      path: skillPath,
      description: fm.description,
      warnings: [],
      ...(readOnly ? { readOnly: true } : {}),
    })
  }
  return entries
}

export async function listSkills(paths: CodexWorkspacePaths): Promise<CodexSkillListItem[]> {
  // Codex official skill scopes: USER (~/.agents) / REPO (<projectRoot>/.agents)
  // / SYSTEM (bundled with installer). See https://developers.openai.com/codex/skills
  const tasks: Promise<CodexSkillListItem[]>[] = [
    listSkillsInRoot(paths.personalSkillsRoot, 'user'),
    listSkillsInRoot(paths.workspaceSkillsRoot, 'repo'),
  ]
  if (paths.systemSkillsRoot) {
    tasks.push(listSkillsInRoot(paths.systemSkillsRoot, 'system'))
  }
  const groups = await Promise.all(tasks)
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name))
}

export async function getSkillDetail(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<CodexSkillInput | null> {
  const [scope, ...rest] = id.split(':')
  const name = rest.join(':')
  let root: string | undefined
  // Codex official scope names (user/repo/system) plus the legacy writable
  // synonyms (personal=user, workspace=repo) for backward compatibility with
  // any persisted IDs.
  if (scope === 'user' || scope === 'personal') root = paths.personalSkillsRoot
  else if (scope === 'repo' || scope === 'workspace') root = paths.workspaceSkillsRoot
  else if (scope === 'system') root = paths.systemSkillsRoot
  else return null
  if (!root) return null
  // System skills are read-only; the editor would fail to save back, so we
  // surface the detail but the writable scope falls back to 'personal'.
  const editScope: CodexConfigScope =
    scope === 'system' ? 'personal'
    : scope === 'user' ? 'personal'
    : scope === 'repo' ? 'workspace'
    : (scope as CodexConfigScope)
  const filePath = path.join(root, name, 'SKILL.md')
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf8')
  } catch {
    return null
  }
  const fm = parseFrontmatter(raw)
  return {
    id,
    name: fm.name ?? name,
    scope: editScope,
    description: fm.description ?? '',
    whenToUse: fm.whenToUse ?? '',
    instructions: fm.body.trimStart(),
  }
}

export async function saveSkill(
  paths: CodexWorkspacePaths,
  input: CodexSkillInput,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  if ((input.scope as string) === 'system') {
    return { ok: false, error: 'System skills are read-only' }
  }
  const err = validateName(input.name)
  if (err) {
    await appendMutationAudit(paths, {
      action: 'skill.save',
      scope: input.scope,
      name: input.name,
      provenance: 'manual',
      ok: false,
      error: err,
    })
    return { ok: false, error: err }
  }
  const root = input.scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const dir = path.join(root, input.name)
  const file = path.join(dir, 'SKILL.md')
  try {
    try {
      await assertInsideRoot(file, root)
    } catch (err) {
      await appendMutationAudit(paths, {
        action: 'skill.save',
        scope: input.scope,
        name: input.name,
        provenance: 'manual',
        ok: false,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
    await fs.mkdir(dir, { recursive: true })
    await atomicWriteFile(file, buildSkillFile(input))
  } catch (err) {
    await appendMutationAudit(paths, {
      action: 'skill.save',
      scope: input.scope,
      name: input.name,
      provenance: 'manual',
      ok: false,
      error: errorMessage(err),
    })
    throw err
  }
  await appendMutationAudit(paths, {
    action: 'skill.save',
    scope: input.scope,
    name: input.name,
    provenance: 'manual',
    ok: true,
  })
  return { ok: true, id: `${input.scope}:${input.name}` }
}

export async function deleteSkill(
  paths: CodexWorkspacePaths,
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const [rawScope, ...rest] = id.split(':')
  const name = rest.join(':')
  if (rawScope === 'system') {
    return { ok: false, error: 'System skills are read-only' }
  }
  // Accept Codex-aligned `user`/`repo` and legacy `personal`/`workspace` for IDs.
  const scope: CodexConfigScope | null =
    rawScope === 'user' || rawScope === 'personal' ? 'personal'
    : rawScope === 'repo' || rawScope === 'workspace' ? 'workspace'
    : null
  if (!scope) {
    await appendMutationAudit(paths, {
      action: 'skill.delete',
      name,
      ok: false,
      error: 'bad scope',
    })
    return { ok: false, error: 'bad scope' }
  }
  const root = scope === 'personal' ? paths.personalSkillsRoot : paths.workspaceSkillsRoot
  const dir = path.join(root, name)
  try {
    try {
      await assertInsideRoot(dir, root)
    } catch (err) {
      await appendMutationAudit(paths, {
        action: 'skill.delete',
        scope,
        name,
        ok: false,
        error: errorMessage(err),
      })
      return { ok: false, error: errorMessage(err) }
    }
    await fs.rm(dir, { recursive: true, force: true })
  } catch (err) {
    await appendMutationAudit(paths, {
      action: 'skill.delete',
      scope,
      name,
      ok: false,
      error: errorMessage(err),
    })
    throw err
  }
  await appendMutationAudit(paths, {
    action: 'skill.delete',
    scope,
    name,
    ok: true,
  })
  return { ok: true }
}
