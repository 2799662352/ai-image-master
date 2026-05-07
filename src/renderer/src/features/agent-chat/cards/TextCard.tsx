import type { TextItem } from '../../../../../types/agent-timeline'

export function TextCard({ item }: { item: TextItem }) {
  if (!item.content) return null
  return <div className="whitespace-pre-wrap text-sm leading-relaxed">{item.content}</div>
}
