import { useAgentChatStore } from './store'

export function MentionInput() {
  const input = useAgentChatStore((state) => state.input)
  const isRunning = useAgentChatStore((state) => state.isRunning)
  const setInput = useAgentChatStore((state) => state.setInput)
  const send = useAgentChatStore((state) => state.send)
  const cancel = useAgentChatStore((state) => state.cancel)

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void send()
      }}
    >
      <textarea
        className="h-24 w-full resize-none rounded-xl border border-cyan-400/25 bg-black/40 p-3 text-sm text-cyan-50 outline-none placeholder:text-zinc-500 focus:border-cyan-300/60"
        disabled={isRunning}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            void send()
          }
        }}
        placeholder="Ask Codex to generate, inspect, batch, or edit..."
        value={input}
      />
      <div className="mt-2 flex items-center gap-2">
        <button
          className="flex-1 rounded-xl bg-cyan-300 px-3 py-2 text-sm font-bold text-zinc-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
          disabled={isRunning || input.trim().length === 0}
          type="submit"
        >
          {isRunning ? 'Running' : 'Send'}
        </button>
        {isRunning ? (
          <button
            className="rounded-xl border border-red-400/30 px-3 py-2 text-sm text-red-200 hover:bg-red-500/10"
            onClick={() => void cancel()}
            type="button"
          >
            Stop
          </button>
        ) : null}
      </div>
    </form>
  )
}
