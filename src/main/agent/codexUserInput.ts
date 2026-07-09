import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CodexTextElement, CodexUserInput } from './codexProtocol'
import type { AgentInput } from './types'
import type { AgentReference } from '../../types/agent-reference'

const IMAGE_EXTENSIONS = new Set([
  '.apng',
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
])

/**
 * Translate the renderer-facing AgentInput.items shape into the wire-format
 * CodexUserInput[] expected by the bundled `codex app-server`. Field names
 * follow the protocol exactly: `text_elements` is snake_case, image references
 * use `url` (not `imageUrl`), and on-disk attachments use `path`.
 */
export function mapUserInput(items: AgentInput['items']): CodexUserInput[] {
  const mentions = items.filter(
    (item): item is Extract<AgentInput['items'][number], { type: 'mention' }> => item.type === 'mention',
  )
  return items.map((item) => {
    switch (item.type) {
      case 'text':
        return { type: 'text', text: item.text, text_elements: mentionTextElements(item.text, mentions) }
      case 'localImage':
        return { type: 'localImage', path: item.path }
      case 'image':
        return { type: 'image', url: item.url }
      case 'skill':
        return { type: 'skill', name: item.name, path: item.path }
      case 'mention':
        return { type: 'mention', name: item.name, path: item.path }
    }
  })
}

/**
 * Official-compat write-side of `text_elements` (app-server v2 `TextElement`,
 * "UI-defined spans within text used to render or persist special elements"):
 * mark every `@token` span in `text` that corresponds to a resolved `mention`
 * item riding the same input, so the rollout knows where the invocation sat.
 *
 * - Token derives from the mention path (`plugin://<token>@<marketplace>` or
 *   `app://<token>`) — the same identity the renderer committed into the text.
 * - Byte offsets are UTF-8 (the server is Rust and indexes the text buffer by
 *   bytes; UTF-16 code-unit offsets corrupt spans after any CJK/emoji char).
 * - Word-boundary rules mirror extractMentionTokens: start-of-text or
 *   whitespace before the `@`, so emails/mid-word `@` never match.
 */
function mentionTextElements(
  text: string,
  mentions: ReadonlyArray<{ name: string; path: string }>,
): CodexTextElement[] {
  if (mentions.length === 0) return []
  const placeholderByToken = new Map<string, string>()
  for (const mention of mentions) {
    const token = mentionTokenFromPath(mention.path)
    if (token) placeholderByToken.set(token, mention.name)
  }
  if (placeholderByToken.size === 0) return []

  const elements: CodexTextElement[] = []
  const re = /(^|\s)(@([A-Za-z0-9_][\w.-]*))/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const placeholder = placeholderByToken.get(match[3])
    if (placeholder === undefined) continue
    const tokenStartUnits = match.index + match[1].length
    const start = Buffer.byteLength(text.slice(0, tokenStartUnits), 'utf8')
    elements.push({
      byteRange: { start, end: start + Buffer.byteLength(match[2], 'utf8') },
      placeholder,
    })
  }
  return elements
}

function mentionTokenFromPath(mentionPath: string): string | null {
  const pluginMatch = /^plugin:\/\/([^@]+)@/.exec(mentionPath)
  if (pluginMatch) return pluginMatch[1]
  const appMatch = /^app:\/\/(.+)$/.exec(mentionPath)
  if (appMatch) return appMatch[1]
  return null
}

export interface ReferenceInputMapping {
  items: AgentInput['items']
  textMentions: string[]
  /**
   * Labels of local references skipped because their path no longer
   * resolves (uploads-cache file written on another machine/user profile,
   * or already removed by AttachmentService.cleanup). Callers surface these
   * as a notice instead of failing the whole send.
   */
  skippedReferences: string[]
}

export async function mapReferencesToInputItems(
  references: readonly AgentReference[] | undefined,
  allowedRoots: readonly string[],
): Promise<ReferenceInputMapping> {
  const items: AgentInput['items'] = []
  const textMentions: string[] = []
  const skippedReferences: string[] = []
  const seenLocalImages = new Set<string>()
  const normalizedAllowedRoots = await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => undefined)))
  const realAllowedRoots = normalizedAllowedRoots.filter((root): root is string => typeof root === 'string')

  for (const reference of references ?? []) {
    if (reference.source.kind === 'localPath') {
      let resolvedPath: string
      try {
        resolvedPath = await fs.realpath(reference.source.path)
      } catch {
        // Stale reference: the file is unreadable/gone, so it cannot leak
        // anything — skip it rather than hold the whole message hostage to
        // a dead chip (e.g. edit-and-resend of a thread whose uploads live
        // on another machine). Paths that DO exist but resolve outside
        // allowed roots still hard-reject below: that is the
        // arbitrary-file-read security boundary and it stays.
        skippedReferences.push(reference.label)
        continue
      }
      if (!isInsideAnyRoot(resolvedPath, realAllowedRoots)) {
        throw new Error(`Reference path is outside allowed roots: ${reference.source.path}`)
      }
      if (isImageReference(reference, resolvedPath)) {
        if (!seenLocalImages.has(resolvedPath)) {
          seenLocalImages.add(resolvedPath)
          items.push({ type: 'localImage', path: resolvedPath })
        }
      } else {
        textMentions.push(`${reference.label}: ${resolvedPath}`)
      }
      continue
    }

    if (reference.source.kind === 'url') {
      const safeUrl = parseHttpsUrl(reference.source.url)
      if (!safeUrl) {
        throw new Error(`Reference URL uses unsupported protocol: ${reference.source.url}`)
      }
      if (isImageReference(reference, safeUrl.pathname)) {
        items.push({ type: 'image', url: safeUrl.toString() })
      }
    }
  }

  return { items, textMentions, skippedReferences }
}

function isInsideAnyRoot(filePath: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, filePath)
    return (
      relative === '' ||
      (relative.length > 0 &&
        relative !== '..' &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    )
  })
}

function parseHttpsUrl(value: string): URL | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

function isImageReference(reference: AgentReference, nameOrPath: string): boolean {
  return (
    reference.type === 'image' ||
    reference.openBehavior === 'image' ||
    reference.preview?.mime?.startsWith('image/') === true ||
    IMAGE_EXTENSIONS.has(path.extname(nameOrPath).toLowerCase())
  )
}
