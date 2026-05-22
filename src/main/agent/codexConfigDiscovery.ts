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
  /** Optional path to the packaged installer's resources dir (process.resourcesPath). */
  resourcesPath?: string
  /**
   * Extra legacy USER-scope roots to scan alongside `$HOME/.agents/skills`.
   * Entries surface as `user` scope and are de-duplicated by SKILL.md
   * directory name (the directory that contains the SKILL.md file, *not* the
   * frontmatter `name`, so two different on-disk directories that happen to
   * declare the same `name:` still both surface). The canonical
   * `$HOME/.agents/skills` entry wins on collision.
   *
   * Why we need this:
   *   - This app's pre-Codex `save-skill` IPC writes to `<userData>/skills`,
   *     and existing user content lives there.
   *   - The Codex CLI continues to honour the legacy `$HOME/.codex/skills`
   *     path even after introducing `.agents/skills` (openai/codex#14337).
   * Without this list the `/` palette and `$skill` popup silently miss any
   * skill that doesn't live exactly under `$HOME/.agents/skills`.
   */
  legacyUserSkillsRoots?: string[]
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

export interface RawCodexConfigResult {
  /** Best-effort parsed TOML. `null` when ENOENT or TOML parse failed. */
  config: Record<string, unknown> | null
  /** Raw file contents when readable (regardless of whether TOML parsing
   *  succeeded). Useful so the renderer can surface the malformed section
   *  to the user even when `config` is null. */
  raw: string | null
  /** Parse error message when TOML itself is malformed. */
  parseError?: string
}

/**
 * Read and TOML-parse `~/.codex/config.toml` directly, bypassing the codex
 * Rust binary's stricter schema validation.
 *
 * The Rust `config/read` RPC fails the whole call if ANY `[mcp_servers.X]`
 * block is invalid (e.g. unknown `transport` value). When that happens the
 * renderer is otherwise blind and the user gets stuck on an error screen
 * with no way to edit the file. This raw read lets the renderer keep
 * rendering server cards (so the JSON editor remains reachable) and lets
 * the editor reload its source after a save without bouncing off the
 * codex validator.
 *
 * Contract:
 * - Missing file → `{ config: {}, raw: null }` (treat as empty config).
 * - Unreadable file (perm, etc.) → throws (caller should report).
 * - Malformed TOML → `{ config: null, raw, parseError }` so the editor can
 *   still display the bad bytes.
 */
export async function readRawCodexConfig(configPath: string): Promise<RawCodexConfigResult> {
  let raw: string
  try {
    raw = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { config: {}, raw: null }
    }
    throw err
  }

  try {
    const parsed = parseToml(raw)
    const record = asRecord(parsed) ?? {}
    return { config: record, raw }
  } catch (err) {
    return {
      config: null,
      raw,
      parseError: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function discoverCodexSkills({
  cwd,
  home,
  resourcesPath,
  legacyUserSkillsRoots,
}: DiscoverSkillsOptions): Promise<CodexSkillsSummary> {
  const warnings: string[] = []
  // Codex official skill scopes (https://developers.openai.com/codex/skills):
  // REPO (.agents/skills walked from CWD up to repo root)
  // USER ($HOME/.agents/skills)
  // SYSTEM (bundled with installation)
  const repoTask = discoverSkillsInRoot(path.join(cwd, '.agents', 'skills'), 'repo', warnings)
  const userTask = discoverSkillsInRoot(path.join(home, '.agents', 'skills'), 'user', warnings)
  const systemTask = resourcesPath
    ? discoverSkillsInRoot(path.join(resourcesPath, '.agents', 'skills'), 'system', warnings)
    : Promise.resolve<CodexSkillSummary[]>([])
  const legacyTasks = (legacyUserSkillsRoots ?? []).map((root) =>
    discoverSkillsInRoot(root, 'user', warnings),
  )

  const [repo, user, system, ...legacyGroups] = await Promise.all([
    repoTask,
    userTask,
    systemTask,
    ...legacyTasks,
  ])

  // Merge USER-scope entries: official `$HOME/.agents/skills` wins on dir
  // name collision, then each legacy root in declaration order.
  const seenUserDirNames = new Set<string>()
  const mergedUser: CodexSkillSummary[] = []
  for (const entry of user) {
    seenUserDirNames.add(skillDirName(entry.path))
    mergedUser.push(entry)
  }
  for (const group of legacyGroups) {
    for (const entry of group) {
      const dirName = skillDirName(entry.path)
      if (seenUserDirNames.has(dirName)) continue
      seenUserDirNames.add(dirName)
      mergedUser.push(entry)
    }
  }
  mergedUser.sort((a, b) => a.name.localeCompare(b.name))

  return {
    skills: [...repo, ...mergedUser, ...system],
    warnings,
  }
}

// `<root>/<dirName>/SKILL.md` → `<dirName>`. We dedupe by the on-disk folder
// name rather than the frontmatter `name:` so two genuinely different skills
// that happen to share a name in their frontmatter both surface; only true
// path collisions (same folder copied to two roots) collapse.
function skillDirName(skillMdPath: string): string {
  return path.basename(path.dirname(skillMdPath))
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
