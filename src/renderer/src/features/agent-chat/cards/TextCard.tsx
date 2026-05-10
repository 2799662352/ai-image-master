import type { TextItem } from '../../../../../types/agent-timeline'
import { MarkdownContent } from '../MarkdownContent'

export function TextCard({ item }: { item: TextItem }) {
  if (!item.content) return null
  return <MarkdownContent source={item.content} />
}
