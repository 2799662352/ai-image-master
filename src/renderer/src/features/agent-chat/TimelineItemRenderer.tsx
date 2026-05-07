import type { TimelineItem } from '../../../../types/agent-timeline'
import { ReasoningCard } from './cards/ReasoningCard'
import { ShellCard } from './cards/ShellCard'
import { TextCard } from './cards/TextCard'

export function TimelineItemRenderer({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case 'text':
      return <TextCard item={item} />
    case 'reasoning':
      return <ReasoningCard item={item} />
    case 'shell':
      return <ShellCard item={item} />
    case 'fileEdit':
    case 'attachment':
    case 'artifact':
      return (
        <div className="rounded border border-zinc-700/50 bg-zinc-900/50 px-2 py-1 text-xs text-zinc-400">
          {item.type} (coming soon)
        </div>
      )
    default: {
      const _exhaustive: never = item
      void _exhaustive
      return null
    }
  }
}
