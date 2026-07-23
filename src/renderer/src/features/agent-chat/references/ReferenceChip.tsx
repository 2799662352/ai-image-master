import type { AgentReference } from '../../../../../types/agent-reference'

const TYPE_LABELS: Record<AgentReference['type'], string> = {
  file: 'file',
  url: 'url',
  command: 'cmd',
  mcp: 'mcp',
  image: 'image',
  video: 'video',
  audio: 'audio',
  artifact: 'artifact',
  activity: 'activity',
}

export function ReferenceChip({
  reference,
  onOpen,
  onRemove,
}: {
  reference: AgentReference
  onOpen?: (reference: AgentReference) => void
  onRemove?: (reference: AgentReference) => void
}) {
  return (
    <span className="inline-flex max-w-[280px] items-center rounded-md border border-cyan-400/25 bg-cyan-400/10 text-[11px] text-cyan-100">
      <button
        type="button"
        // Don't steal textarea focus when the chip lives in MentionInput —
        // the input has a 100 ms blur-cleanup timer that would otherwise tear
        // down popups the moment the user clicks the chip. onClick still
        // fires; only the focus transfer is suppressed.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onOpen?.(reference)}
        className="inline-flex min-w-0 items-center gap-1.5 px-2 py-1 hover:text-cyan-50"
        title={`${reference.type}: ${reference.label}`}
      >
        <span className="uppercase tracking-[0.16em] text-cyan-300/80">{TYPE_LABELS[reference.type]}</span>
        <span className="truncate">{reference.label}</span>
      </button>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${reference.label}`}
          onClick={() => onRemove(reference)}
          className="border-l border-cyan-400/20 px-1.5 py-1 text-cyan-200/70 hover:text-cyan-50"
        >
          x
        </button>
      ) : null}
    </span>
  )
}
