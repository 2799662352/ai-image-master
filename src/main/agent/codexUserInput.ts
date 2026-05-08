import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CodexUserInput } from './codexProtocol'
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
  return items.map((item) => {
    switch (item.type) {
      case 'text':
        return { type: 'text', text: item.text, text_elements: [] }
      case 'localImage':
        return { type: 'localImage', path: item.path }
      case 'image':
        return { type: 'image', url: item.url }
    }
  })
}

export interface ReferenceInputMapping {
  items: AgentInput['items']
  textMentions: string[]
}

export async function mapReferencesToInputItems(
  references: readonly AgentReference[] | undefined,
  allowedRoots: readonly string[],
): Promise<ReferenceInputMapping> {
  const items: AgentInput['items'] = []
  const textMentions: string[] = []
  const seenLocalImages = new Set<string>()
  const normalizedAllowedRoots = await Promise.all(allowedRoots.map((root) => fs.realpath(root).catch(() => undefined)))
  const realAllowedRoots = normalizedAllowedRoots.filter((root): root is string => typeof root === 'string')

  for (const reference of references ?? []) {
    if (reference.source.kind === 'localPath') {
      let resolvedPath: string
      try {
        resolvedPath = await fs.realpath(reference.source.path)
      } catch {
        throw new Error(`Reference path is outside allowed roots: ${reference.source.path}`)
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

  return { items, textMentions }
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
