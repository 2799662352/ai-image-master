import type { AgentReference } from '../../../../types/agent-reference'
import { JsonResourcePreview } from './JsonResourcePreview'
import { ShellOutputPreview } from './ShellOutputPreview'
import { UrlPreview } from './UrlPreview'
import { toRenderableUri } from './uri'

/**
 * Inline image preview for reference tabs whose backing file lives outside the
 * workspace allowed roots (e.g. attachment uploads under userData/agent/uploads).
 * openTab() refused them via fs:list-dir / fs:stat allowedRoots check; here we
 * fall back to the local-file:// protocol which has its own (broader) handler.
 */
function ImageReferencePreview({ reference }: { reference: AgentReference }) {
  if (reference.source.kind !== 'localPath') return <UnsupportedReference />
  const src = toRenderableUri(reference.source.path)
  return (
    <div className="flex h-full items-center justify-center bg-black/40 p-2">
      <img
        src={src}
        alt={reference.label}
        className="max-h-full max-w-full object-contain"
      />
    </div>
  )
}

function VideoReferencePreview({ reference }: { reference: AgentReference }) {
  if (reference.source.kind !== 'localPath') return <UnsupportedReference />
  const src = toRenderableUri(reference.source.path)
  return (
    <div className="flex h-full items-center justify-center bg-black/40 p-2">
      {/* controls 让用户能 seek/暂停;不 autoplay 避免抢焦点 + 节省 CPU。 */}
      <video src={src} controls className="max-h-full max-w-full bg-black object-contain" />
    </div>
  )
}

function UnsupportedReference() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-xs text-zinc-400">
      Unsupported reference source.
    </div>
  )
}

export function ReferencePreview({ reference }: { reference: AgentReference }) {
  switch (reference.openBehavior) {
    case 'url':
      return <UrlPreview reference={reference} />
    case 'shellOutput':
      return <ShellOutputPreview reference={reference} />
    case 'jsonResource':
    case 'diff':
      return <JsonResourcePreview reference={reference} />
    case 'image':
      return <ImageReferencePreview reference={reference} />
    case 'video':
      return <VideoReferencePreview reference={reference} />
    case 'code':
    case 'markdown':
    case 'pdf':
      // openTab() 已经处理了正常路径;走到这里意味着 openTab 失败(allowedRoots
      // 拒绝 / 文件被删等)。code/markdown/pdf 没法用 local-file:// 直接渲,
      // 给个明确兜底,避免白屏。
      return (
        <div className="flex h-full flex-col gap-2 p-4 text-xs text-amber-200">
          <p>This reference points at a file but reached the synthetic-preview dispatcher.</p>
          <p className="opacity-70">Local-path file references should be delegated to the existing viewer.</p>
        </div>
      )
    default:
      // 显式兑底:openBehavior 未来再扩(比如 'audio')时此处至少不会白屏,
      // 并在 dev console 留一条可定位的线索。
      // eslint-disable-next-line no-console
      if (typeof console !== 'undefined') console.warn('[ReferencePreview] unhandled openBehavior:', reference.openBehavior)
      return <UnsupportedReference />
  }
}
