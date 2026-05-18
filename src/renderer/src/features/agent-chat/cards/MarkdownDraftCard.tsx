import { MarkdownContent } from '../MarkdownContent'

type DraftStatus = 'streaming' | 'created' | 'failed'

export function MarkdownDraftCard({
  path,
  content,
  status,
  error,
  onOpen,
}: {
  path: string
  content: string
  status: DraftStatus
  error?: string
  onOpen: (path: string) => void
}) {
  const canOpen = status === 'created' && Boolean(path)

  const label =
    status === 'failed'
      ? `Failed to create ${path}`
      : status === 'streaming'
        ? `Creating ${path}...`
        : `Created ${path}`

  return (
    <button
      type="button"
      aria-label={`Open ${path}`}
      disabled={!canOpen}
      onClick={() => {
        if (canOpen) onOpen(path)
      }}
      className="my-2 block w-full overflow-hidden rounded-lg border border-cyan-400/20 bg-zinc-950/70 text-left transition hover:border-cyan-300/40 disabled:cursor-default disabled:hover:border-cyan-400/20"
    >
      <div className="flex items-center gap-2 border-b border-cyan-500/10 px-2.5 py-1.5 text-[11px] text-cyan-100">
        {status === 'streaming' && (
          <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono" title={path}>
          {label}
        </span>
      </div>
      {error && (
        <div className="border-b border-red-400/10 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-100">
          {error}
        </div>
      )}
      <div className="max-h-[360px] overflow-auto px-3 py-2">
        <MarkdownContent source={content} />
      </div>
    </button>
  )
}
