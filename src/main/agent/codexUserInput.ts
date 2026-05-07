import type { CodexUserInput } from './codexProtocol'
import type { AgentInput } from './types'

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
