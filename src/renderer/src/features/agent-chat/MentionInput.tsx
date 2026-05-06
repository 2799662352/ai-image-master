import { useAgentChatStore } from './store'

const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 250 * 1024 * 1024

export function MentionInput() {
  const input = useAgentChatStore((state) => state.input)
  const isRunning = useAgentChatStore((state) => state.isRunning)
  const attachments = useAgentChatStore((state) => state.attachments)
  const setInput = useAgentChatStore((state) => state.setInput)
  const setError = useAgentChatStore((state) => state.setError)
  const addAttachment = useAgentChatStore((state) => state.addAttachment)
  const send = useAgentChatStore((state) => state.send)
  const cancel = useAgentChatStore((state) => state.cancel)

  async function onFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    const remainingSlots = Math.max(MAX_ATTACHMENTS - attachments.length, 0)
    let totalBytes = attachments.reduce((sum, item) => sum + item.size, 0)
    let skipped = 0

    for (const file of files.slice(0, remainingSlots)) {
      if (file.size > MAX_ATTACHMENT_BYTES || totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        skipped += 1
        continue
      }
      addAttachment({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        buffer: await file.arrayBuffer(),
      })
      totalBytes += file.size
    }

    if (files.length > remainingSlots) skipped += files.length - remainingSlots
    setError(skipped > 0 ? `Skipped ${skipped} file(s) because of attachment limits.` : undefined)

    event.target.value = ''
  }

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
      <label className="mt-2 flex cursor-pointer items-center justify-between rounded-xl border border-dashed border-cyan-400/25 px-3 py-2 text-xs text-cyan-100/80 hover:bg-cyan-400/10">
        <span>Add references or files</span>
        <span>{attachments.length}/{MAX_ATTACHMENTS}</span>
        <input
          className="hidden"
          disabled={isRunning || attachments.length >= MAX_ATTACHMENTS}
          multiple
          onChange={(event) => void onFileChange(event)}
          type="file"
        />
      </label>
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
