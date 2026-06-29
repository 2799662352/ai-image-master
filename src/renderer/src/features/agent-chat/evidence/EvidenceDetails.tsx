import type {
  ActivityItem,
  AttachmentRef,
  FileEditItem,
  ShellItem,
  TimelineItem,
} from '../../../../../types/agent-timeline'
import type { AgentReference } from '../../../../../types/agent-reference'
import { classifyMediaKind } from '../../../components/shared/media/MediaThumbnail'
import { toRenderableUri } from '../../file-explorer/uri'
import { MediaThumbWithPoster } from '../MediaThumbWithPoster'
import { FileDiffBlock } from '../cards/FileDiffBlock'

type EvidenceDetailsProps = {
  item: TimelineItem
  reference: AgentReference | null
  openError: boolean
  onOpenReference: (reference: AgentReference) => void
}

export function EvidenceDetails({ item, reference, openError, onOpenReference }: EvidenceDetailsProps) {
  return (
    <div className="mt-1 rounded-lg border border-zinc-800/80 bg-zinc-950/70 p-2 text-xs text-zinc-300">
      {reference ? (
        <div className="mb-2 flex flex-col items-start gap-1">
          <button
            type="button"
            onClick={() => onOpenReference(reference)}
            className="rounded border border-cyan-500/40 px-2 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/10 focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 focus-visible:outline-none"
          >
            Open in panel
          </button>
          {openError ? (
            <div className="text-[11px] text-amber-300">Could not open reference in panel.</div>
          ) : null}
        </div>
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
      {item.changes.map((change, index) =>
        change.diff.trim().length > 0 ? (
          <FileDiffBlock key={`${change.operation}:${change.path}:${index}`} change={change} />
        ) : (
          <div
            key={`${change.operation}:${change.path}:${index}`}
            className="mb-2 rounded border border-zinc-800/70 bg-zinc-950 p-2"
          >
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
        {items.map((item) => {
          // image/video 在 row 左侧补一张 mini 缩略图;mime + bytes 文本保留(给
          // Codex CLI 截屏 / 截图 OCR 的语义信息)。普通文件保持原样。
          const kind = classifyMediaKind({ kind: item.kind, mime: item.mime, name: item.name })
          const src = item.thumbnailUri ?? item.uri
          const renderable = kind != null && typeof src === 'string' && src.length > 0
          return (
            <li
              key={item.id}
              className="flex items-center gap-2 rounded border border-zinc-800/70 bg-zinc-950 px-2 py-1"
            >
              {renderable ? (
                <MediaThumbWithPoster
                  src={toRenderableUri(src)}
                  videoUri={item.uri}
                  thumbnailUri={item.thumbnailUri}
                  kind={kind}
                  name={item.name}
                  className="h-10 w-10 shrink-0"
                />
              ) : null}
              <div className="min-w-0">
                <div className="truncate font-medium text-zinc-200" title={item.name}>{item.name}</div>
                <div className="text-[11px] text-zinc-500">
                  {item.mime} - {item.size} bytes
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
