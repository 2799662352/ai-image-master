import type { Message } from '../../../../types/agent-timeline'
import { EvidenceStack } from './evidence/EvidenceStack'
import { groupTimelineItemsForChat } from './evidence/evidenceModel'
import { TimelineItemRenderer } from './TimelineItemRenderer'

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  const groups = groupTimelineItemsForChat(message.items)

  return (
    <div className={`mb-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[88%] rounded-2xl px-3 py-2 shadow-lg',
          isUser
            ? 'rounded-br-sm border border-cyan-300/30 bg-cyan-400/15 text-cyan-50'
            : 'rounded-bl-sm border border-zinc-700/70 bg-zinc-900/90 text-zinc-100',
        ].join(' ')}
      >
        {groups.map((group) => (
          group.type === 'item' ? (
            <TimelineItemRenderer key={group.item.id} item={group.item} />
          ) : (
            <EvidenceStack key={group.items.map((item) => item.id).join(':')} items={group.items} />
          )
        ))}
        {message.items.length === 0 && (
          <span className="text-sm text-zinc-500 italic">Empty message</span>
        )}
      </div>
    </div>
  )
}
