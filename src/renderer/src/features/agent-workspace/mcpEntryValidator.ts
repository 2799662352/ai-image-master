/**
 * Local pre-flight validation for a single `[mcp_servers.<name>]` entry.
 *
 * ## Why this exists
 *
 * Codex 0.132.0's `McpServerConfig::deserialize`
 * (codex-rs/core/src/config/types.rs:124-155) rejects any entry where BOTH
 * `command` and `url` are missing with the bare message:
 *
 *   `invalid transport`
 *
 * The error originates inside the Rust binary, so it bubbles up to the
 * renderer as an opaque RPC failure with NO indication of which server is
 * broken or which field is missing. Worse, when codex rejects ANY single
 * entry on `batchWriteConfig`, the entire write is aborted — even valid
 * entries in the same batch don't land.
 *
 * Pre-validating in the renderer turns that opaque codex rejection into a
 * concrete, actionable inline error (`"apiyi" 缺少 command 或 url`) BEFORE
 * we ever round-trip to codex. Saves a UX dead-end and a network round
 * trip per typo.
 *
 * ## Scope
 *
 * Mirrors codex's deserialize logic, NOT its full schema. We only check the
 * "is this a syntactically valid transport block" gate that causes
 * `"invalid transport"`. Deeper validation (e.g. transport-specific field
 * compatibility — `http_headers` not allowed for stdio) is still
 * delegated to codex; surfacing those errors inline would mean duplicating
 * codex's entire schema in TypeScript.
 *
 * ## Reference: codex source
 *
 * codex-rs/core/src/config/types.rs at the McpServerConfig Deserialize
 * impl. The decision tree is:
 *
 *     - if raw.command is Some  -> Stdio variant (passes)
 *     - else if raw.url is Some -> StreamableHttp variant (passes)
 *     - else                    -> Err("invalid transport")
 *
 * We replicate ONLY the final else branch — empty/missing-transport
 * detection. Deeper validation (transport-specific field compatibility)
 * is still delegated to codex.
 */

export type McpEntryValidationError =
  | { kind: 'not-object'; name: string }
  | { kind: 'missing-transport'; name: string }
  | { kind: 'empty-command'; name: string }
  | { kind: 'empty-url'; name: string }
  | { kind: 'invalid-command-type'; name: string }
  | { kind: 'invalid-url-type'; name: string }

export function formatValidationError(err: McpEntryValidationError): string {
  switch (err.kind) {
    case 'not-object':
      return `服务器 "${err.name}" 的值必须是一个 JSON 对象 (像 { "command": "..." })`
    case 'missing-transport':
      // Worded to match codex's bare "invalid transport" so users
      // who Google the error message find this matches.
      return `服务器 "${err.name}" 缺少 command 或 url (必须二选一) — 这是 codex 报 "invalid transport" 的根因`
    case 'empty-command':
      return `服务器 "${err.name}" 的 command 不能是空字符串`
    case 'empty-url':
      return `服务器 "${err.name}" 的 url 不能是空字符串`
    case 'invalid-command-type':
      return `服务器 "${err.name}" 的 command 必须是字符串 (例如 "node" 或绝对路径)`
    case 'invalid-url-type':
      return `服务器 "${err.name}" 的 url 必须是字符串 (例如 "https://..." )`
  }
}

/**
 * Returns null when the entry passes codex's transport gate, or a
 * structured error describing the FIRST issue found. We deliberately
 * return at most one error per entry — the user fixes that one, presses
 * Save again, and we either pass or surface the next one. This is faster
 * to act on than a wall of every issue at once.
 *
 * `null` / `undefined` config values are treated as a `not-object` failure
 * rather than silently skipped. If the user wants to DELETE an entry,
 * they should remove the key from the JSON entirely; we shouldn't paper
 * over `"apiyi": null` as "delete intent" because that's an easy footgun
 * (one missed undo and the whole server vanishes).
 */
export function validateMcpServerEntry(name: string, config: unknown): McpEntryValidationError | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return { kind: 'not-object', name }
  }

  const obj = config as Record<string, unknown>
  const hasCommandKey = 'command' in obj
  const hasUrlKey = 'url' in obj

  if (hasCommandKey) {
    const command = obj.command
    if (typeof command !== 'string') {
      return { kind: 'invalid-command-type', name }
    }
    if (command.trim() === '') {
      return { kind: 'empty-command', name }
    }
    // Command is valid string → stdio transport, gate passed.
    return null
  }

  if (hasUrlKey) {
    const url = obj.url
    if (typeof url !== 'string') {
      return { kind: 'invalid-url-type', name }
    }
    if (url.trim() === '') {
      return { kind: 'empty-url', name }
    }
    // Url is valid string → streamable_http transport, gate passed.
    return null
  }

  return { kind: 'missing-transport', name }
}
