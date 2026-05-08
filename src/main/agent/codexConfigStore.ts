import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CodexAuditLogEntry, CodexWorkspacePaths } from '../../types/agent'

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
