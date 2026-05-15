import { parse as parseToml } from 'toml'
import * as iarnaToml from '@iarna/toml'

interface MergeInput {
  personalToml: string
  workspaceToml: string
  collectWarnings?: boolean
}

interface MergeResultWithWarnings {
  merged: string
  warnings: string[]
}

function tryParse(label: string, raw: string, warnings: string[]): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    return parseToml(raw) as Record<string, unknown>
  } catch (err) {
    warnings.push(`${label} TOML parse error: ${err instanceof Error ? err.message : String(err)}`)
    return {}
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function mergeCodexConfigs(input: MergeInput & { collectWarnings: true }): MergeResultWithWarnings
export function mergeCodexConfigs(input: MergeInput): string
export function mergeCodexConfigs(input: MergeInput): string | MergeResultWithWarnings {
  const warnings: string[] = []
  const personal = tryParse('personal', input.personalToml, warnings)
  const workspace = tryParse('workspace', input.workspaceToml, warnings)

  const personalServers = isPlainObject(personal.mcp_servers) ? personal.mcp_servers : {}
  const workspaceServers = isPlainObject(workspace.mcp_servers) ? workspace.mcp_servers : {}

  const mergedServers: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(personalServers)) {
    if (!isPlainObject(value)) continue
    if (value.enabled === false) continue
    mergedServers[name] = stripEnabledTrue(value)
  }
  for (const [name, value] of Object.entries(workspaceServers)) {
    if (!isPlainObject(value)) continue
    if (value.enabled === false) {
      delete mergedServers[name]
      continue
    }
    mergedServers[name] = stripEnabledTrue(value)
  }

  const document: Record<string, unknown> = { ...personal }
  delete document.mcp_servers
  if (Object.keys(mergedServers).length > 0) document.mcp_servers = mergedServers

  const merged = iarnaToml.stringify(document as iarnaToml.JsonMap)
  return input.collectWarnings ? { merged, warnings } : merged
}

function stripEnabledTrue(record: Record<string, unknown>): Record<string, unknown> {
  if (record.enabled !== true) return record
  const { enabled: _enabled, ...rest } = record
  return rest
}
