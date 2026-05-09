import type {
  ActivityItem,
  AttachmentRef,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'
import type { AgentReference } from '../../../../../types/agent-reference'
import { FileDiffBlock } from '../cards/FileDiffBlock'

type EvidenceDetailsProps = {
  item: TimelineItem
  reference: AgentReference | null
  onOpenReference: (reference: AgentReference) => void
}

export function EvidenceDetails({ item, reference, onOpenReference }: EvidenceDetailsProps) {
  return (
    <div className="mt-1 rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-2 text-xs text-zinc-300">
      {reference ? (
        <button
          type="button"
          onClick={() => onOpenReference(reference)}
          className="mb-2 rounded border border-cyan-500/40 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/10 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 focus-visible:outline-none"
        >
          Open in panel
        </button>
      ) : null}
      {renderDetails(item)}
    </div>
  )
}

function renderDetails(item: TimelineItem) {
  switch (item.type) {
    case 'shell':
      return <ShellDetails item={item} />
    case 'fileEdit':
      return <FileEditDetails item={item} />
    case 'activity':
      return <ActivityDetails item={item} />
    case 'artifact':
      return <AttachmentList title="Artifacts" items={item.artifacts} />
    case 'attachment':
      return <AttachmentList title="Attachments" items={item.attachments} />
    case 'text':
    case 'reasoning':
      return null
  }
}

function ShellDetails({ item }: { item: ShellItem }) {
  return (
    <div className="space-y-2">
      <div>
        <div className="mb-1 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">Command</div>
        <pre className="overflow-x-auto rounded border border-zinc-800/70 bg-zinc-950 p-2 font-mono text-[11px] whitespace-pre-wrap text-zinc-200">
          {item.command}
        </pre>
      </div>
      {item.stdout || item.stderr ? (
        <div className="max-h-[360px] overflow-y-auto rounded border border-zinc-800/70 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed">
          {item.stdout ? <pre className="whitespace-pre-wrap text-zinc-300">{item.stdout}</pre> : null}
          {item.stderr ? <pre className="whitespace-pre-wrap text-red-300/90">{item.stderr}</pre> : null}
        </div>
      ) : (
        <div className="rounded border border-zinc-800/70 bg-zinc-950 p-2 text-[11px] text-zinc-500 italic">
          No output
        </div>
      )}
    </div>
  )
}

function FileEditDetails({ item }: { item: FileEditItem }) {
  return (
    <div>
      {item.changes.map((change) =>
        change.diff.trim().length > 0 ? (
          <FileDiffBlock key={change.path} change={change} />
        ) : (
          <div key={change.path} className="mb-2 rounded border border-zinc-800/70 bg-zinc-950 p-2">
            <div className="mb-1 font-mono text-[11px] text-zinc-200">{change.path}</div>
            <div className="text-[11px] text-zinc-500">File changed, but no diff was provided.</div>
          </div>
        ),
      )}
    </div>
  )
}

function ActivityDetails({ item }: { item: ActivityItem }) {
  if (!item.detail) return null

  return (
    <pre className="max-h-[220px] overflow-y-auto rounded border border-zinc-800/70 bg-zinc-950 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-zinc-300">
      {item.detail}
    </pre>
  )
}

function AttachmentList({ title, items }: { title: string; items: AttachmentRef[] }) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">{title}</div>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item.id} className="rounded border border-zinc-800/70 bg-zinc-950 px-2 py-1">
            <div className="font-medium text-zinc-200">{item.name}</div>
            <div className="text-[11px] text-zinc-500">
              {item.mime} - {item.size} bytes
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
