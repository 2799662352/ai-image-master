import type { Message } from '../../../../types/agent-timeline'
import { TimelineItemRenderer } from './TimelineItemRenderer'

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'

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
        {message.items.map((item) => (
          <TimelineItemRenderer key={item.id} item={item} />
        ))}
        {message.items.length === 0 && (
          <span className="text-sm text-zinc-500 italic">Empty message</span>
        )}
      </div>
    </div>
  )
}
