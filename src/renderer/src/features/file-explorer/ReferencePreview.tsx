import type { AgentReference } from '../../../../types/agent-reference'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { JsonResourcePreview } from './JsonResourcePreview'
import { ShellOutputPreview } from './ShellOutputPreview'
import { UrlPreview } from './UrlPreview'
import { toRenderableUri } from './uri'

/**
 * Inline image preview for reference tabs whose backing file lives outside
 * the workspace allowed roots (e.g. attachment uploads under
 * userData/agent/uploads, or user-dragged files from arbitrary disk paths).
 *
 * Goes through `useResolvedMediaSrc` for the same reason MediaThumbnail and
 * Lightbox do: directly using `local-file://` in `<img src>` triggers
 * Chromium's standard-scheme URL normalisation, which strips the Windows
 * drive letter (`%3A` collapses) and the protocol handler then gets a path
 * like `/27996/AppData/...` with no `C:` prefix and 500s. The hook routes
 * through the `attachments:read-thumb` IPC and renders a blob URL.
 */
function ImageReferencePreview({ reference }: { reference: AgentReference }) {
  if (reference.source.kind !== 'localPath') return <UnsupportedReference />
  return <ResolvedMediaPreview path={reference.source.path} alt={reference.label} kind="image" />
}

function VideoReferencePreview({ reference }: { reference: AgentReference }) {
  if (reference.source.kind !== 'localPath') return <UnsupportedReference />
  return <ResolvedMediaPreview path={reference.source.path} alt={reference.label} kind="video" />
}

function ResolvedMediaPreview({
  path,
  alt,
  kind,
}: {
  path: string
  alt: string
  kind: 'image' | 'video'
}) {
  // toRenderableUri normalises the raw OS path into the same `local-file://`
  // shape the hook accepts (and that MediaThumbnail/Lightbox see), so all
  // three surfaces hit the same code path in `useResolvedMediaSrc`.
  const resolvedSrc = useResolvedMediaSrc(toRenderableUri(path), kind)
  if (resolvedSrc == null) {
    return (
      <div className="flex h-full items-center justify-center bg-black/40 p-2 text-xs text-zinc-400">
        Loading…
      </div>
    )
  }
  return (
    <div className="flex h-full items-center justify-center bg-black/40 p-2">
      {kind === 'video' ? (
        /* controls 让用户能 seek/暂停;不 autoplay 避免抢焦点 + 节省 CPU。 */
        <video src={resolvedSrc} controls className="max-h-full max-w-full bg-black object-contain" />
      ) : (
        <img src={resolvedSrc} alt={alt} className="max-h-full max-w-full object-contain" />
      )}
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
    case 'audio':
      // 最小音频兜底:图标 + 文件名(不做播放器)。音频字节由 codex 端的
      // `localAudio` 输入项承运,预览面板只需可辨识。
      return (
        <div className="flex h-full items-center justify-center gap-2 p-4 text-xs text-zinc-300">
          <span aria-hidden="true">🎵</span>
          <span className="max-w-full truncate font-mono">{reference.label}</span>
        </div>
      )
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
