import type { AgentChatMessage } from './types'

export function MessageBubble({ message }: { message: AgentChatMessage }) {
  const isUser = message.role === 'user'

  return (
    <div className={`mb-3 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'max-w-[88%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-lg',
          isUser
            ? 'rounded-br-sm border border-cyan-300/30 bg-cyan-400/15 text-cyan-50'
            : 'rounded-bl-sm border border-zinc-700/70 bg-zinc-900/90 text-zinc-100',
        ].join(' ')}
      >
        {message.content}
      </div>
    </div>
  )
}
