import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'
import type {
  CodexAuditLogEntry,
  CodexConfigScope,
  CodexMcpServerInput,
  CodexMcpServerListItem,
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
