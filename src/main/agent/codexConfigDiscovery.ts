import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parse as parseToml } from 'toml'
import type { Dirent } from 'node:fs'
import type {
  CodexMcpServerSummary,
  CodexMcpSummary,
  CodexSkillScope,
  CodexSkillSummary,
  CodexSkillsSummary,
} from '../../types/agent'

interface DiscoverSkillsOptions {
  cwd: string
  home: string
}

type UnknownRecord = Record<string, unknown>

const SECRET_ARG_NAMES = new Set([
  '--api-key',
  '--apikey',
  '--auth',
  '--authorization',
  '--bearer-token',
  '--client-secret',
  '--key',
  '--password',
  '--secret',
  '--token',
])

const SECRET_QUERY_RE = /(api[_-]?key|auth|authorization|client[_-]?secret|password|secret|token)/i
const SECRET_ASSIGNMENT_RE = /(api[_-]?key|authorization|client[_-]?secret|password|secret|token)=([^\s&]+)/gi
const SECRET_SUBSTRING_RE = new RegExp(
  String.raw`\b(` +
    [
      `${'ghp' + '_'}[A-Za-z0-9_]+`,
      `${'github' + '_pat' + '_'}[A-Za-z0-9_]+`,
      `${'sk' + '-'}[A-Za-z0-9_-]+`,
      `${'apiyi' + '-'}[A-Za-z0-9_-]+`,
      String.raw`Bearer\s+[A-Za-z0-9._-]+`,
    ].join('|') +
    String.raw`)\b`,
  'g',
)

export async function readMcpSummary(configPath: string): Promise<CodexMcpSummary> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return { servers: [], warnings: [] }
    throw err
  }

  let parsed: unknown
  try {
    parsed = parseToml(raw)
  } catch (err) {
    return {
      servers: [],
      warnings: [`Invalid Codex config TOML: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  const mcpServers = asRecord(parsed)?.mcp_servers
  const entries = Object.entries(asRecord(mcpServers) ?? {})
  const servers = entries
    .map(([name, value]) => summarizeMcpServer(name, value))
    .filter((server): server is CodexMcpServerSummary => server != null)
    .sort((a, b) => a.name.localeCompare(b.name))

  return { servers, warnings: [] }
}

export async function discoverCodexSkills({ cwd, home }: DiscoverSkillsOptions): Promise<CodexSkillsSummary> {
  const warnings: string[] = []
  const skillGroups = await Promise.all([
    discoverSkillsInRoot(path.join(cwd, '.agents', 'skills'), 'workspace', warnings),
    discoverSkillsInRoot(path.join(home, '.agents', 'skills'), 'home', warnings),
  ])

  return {
    skills: skillGroups.flat(),
    warnings,
  }
}

function summarizeMcpServer(name: string, value: unknown): CodexMcpServerSummary | undefined {
  const server = asRecord(value)
  if (!server) return undefined

  const command = typeof server.command === 'string' ? buildRedactedCommand(server.command, server.args) : undefined
  const url = typeof server.url === 'string' ? redactUrl(server.url) : undefined
  const explicitTransport = typeof server.transport === 'string' ? server.transport : undefined
  const transport = explicitTransport ?? (command ? 'stdio' : url ? 'http' : 'unknown')
  const disabled = typeof server.disabled === 'boolean' ? server.disabled : false
  const enabled = typeof server.enabled === 'boolean' ? server.enabled : !disabled
  const required = typeof server.required === 'boolean' ? server.required : false

  return {
    name,
    transport,
    enabled,
    required,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
  }
}

function buildRedactedCommand(command: string, args: unknown): string {
  const parts = [command]
  if (Array.isArray(args)) {
    parts.push(...args.filter((arg): arg is string => typeof arg === 'string'))
  }
  return redactCommandParts(parts).join(' ')
}

function redactCommandParts(parts: string[]): string[] {
  const redacted: string[] = []
  let redactNext = false
  for (const part of parts) {
    const normalized = part.includes('=') ? part.slice(0, part.indexOf('=')).toLowerCase() : part.toLowerCase()
    if (redactNext) {
      redacted.push('[REDACTED]')
      redactNext = false
      continue
    }
    if (SECRET_ARG_NAMES.has(normalized)) {
      redacted.push(part)
      redactNext = !part.includes('=')
      if (part.includes('=')) {
        redacted[redacted.length - 1] = `${part.slice(0, part.indexOf('=') + 1)}[REDACTED]`
      }
      continue
    }
    redacted.push(redactSecretSubstrings(part))
  }
  return redacted
}

function redactUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl)
    if (parsed.username) parsed.username = 'REDACTED'
    if (parsed.password) parsed.password = 'REDACTED'
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SECRET_QUERY_RE.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    return redactSecretSubstrings(parsed.toString())
  } catch {
    return redactSecretSubstrings(rawUrl.replace(SECRET_ASSIGNMENT_RE, '$1=[REDACTED]'))
  }
}

function redactSecretSubstrings(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT_RE, '$1=[REDACTED]')
    .replace(SECRET_SUBSTRING_RE, '[REDACTED]')
}

async function discoverSkillsInRoot(
  skillsRoot: string,
  scope: CodexSkillScope,
  warnings: string[],
): Promise<CodexSkillSummary[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true })
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }

  const skills: CodexSkillSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillName = entry.name
    const skillPath = path.join(skillsRoot, skillName, 'SKILL.md')
    let content: string
    try {
      content = await fs.readFile(skillPath, 'utf8')
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') continue
      throw err
    }
    const frontmatter = parseSkillFrontmatter(content)
    if (!frontmatter.ok) warnings.push(`Invalid frontmatter in ${skillName}: ${frontmatter.warning}`)
    skills.push({
      name: frontmatter.ok && frontmatter.name ? frontmatter.name : skillName,
      scope,
      description: frontmatter.ok ? frontmatter.description : '',
      path: skillPath,
    })
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function parseSkillFrontmatter(content: string):
  | { ok: true; name?: string; description: string }
  | { ok: false; warning: string } {
  if (!content.startsWith('---\n')) return { ok: true, description: '' }
  const end = content.indexOf('\n---', 4)
  if (end < 0) return { ok: false, warning: 'missing closing marker' }

  const metadata: Record<string, string> = {}
  const lines = content.slice(4, end).split(/\r?\n/)
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match) return { ok: false, warning: `invalid line "${line}"` }
    const [, key, rawValue] = match
    const parsedValue = parseFrontmatterValue(rawValue)
    if (parsedValue == null) return { ok: false, warning: `invalid value for ${key}` }
    metadata[key] = parsedValue
  }

  return {
    ok: true,
    name: metadata.name,
    description: metadata.description ?? '',
  }
}

function parseFrontmatterValue(rawValue: string): string | undefined {
  const value = rawValue.trim()
  if (value.length === 0) return ''
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    if (!value.endsWith(quote) || value.length === 1) return undefined
    return value.slice(1, -1)
  }
  return value
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
