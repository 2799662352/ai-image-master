import type { ThreadEvent } from './types'

/**
 * Parse a single line of `codex exec --json` output into a {@link ThreadEvent}.
 *
 * Returns `null` for anything that isn't a JSON OBJECT carrying a string
 * `type` — blank lines, human-readable log noise, and non-object JSON
 * (numbers/arrays/strings) are all skipped rather than throwing, so a stray
 * line never aborts a whole run.
 */
export function parseJsonlLine(line: string): ThreadEvent | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const type = (value as { type?: unknown }).type
  if (typeof type !== 'string') return null
  return value as ThreadEvent
}

/**
 * Parse a full `codex exec --json` stream (a string with `\n`/`\r\n` framing,
 * or an array of already-split lines) into the list of {@link ThreadEvent}s,
 * dropping noise and blank lines.
 */
export function parseJsonl(stream: string | readonly string[]): ThreadEvent[] {
  const lines = typeof stream === 'string' ? stream.split('\n') : stream
  const events: ThreadEvent[] = []
  for (const line of lines) {
    const evt = parseJsonlLine(line)
    if (evt) events.push(evt)
  }
  return events
}
