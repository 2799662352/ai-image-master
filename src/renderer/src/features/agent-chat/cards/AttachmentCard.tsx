import type { AttachmentItem, AttachmentRef } from '../../../../../types/agent-timeline'
import type { AgentReference } from '../../../../../types/agent-reference'
import { classifyMediaKind } from '../../../components/shared/media/MediaThumbnail'
import { toRenderableUri } from '../../file-explorer/uri'
import { MediaThumbWithPoster } from '../MediaThumbWithPoster'
import { useFileExplorerStore } from '../../file-explorer/store'
import { FileIcon, OpenInPanelIcon } from '../icons'
import { referencesFromTimelineItem } from '../references/referenceUtils'
import { useAgentChatStore } from '../store'

type MediaKind = 'image' | 'video'

function mediaKindOf(ref: AttachmentRef): MediaKind | null {
  return classifyMediaKind({ kind: ref.kind, mime: ref.mime, name: ref.name })
}

function isRenderableMedia(ref: AttachmentRef): boolean {
  if (mediaKindOf(ref) == null) return false
  const uri = ref.thumbnailUri ?? ref.uri
  return typeof uri === 'string' && uri.length > 0
}

export function AttachmentCard({ item }: { item: AttachmentItem }) {
  const openPreview = useAgentChatStore((s) => s.openPreview)
  const openReference = useFileExplorerStore((state) => state.openReference)
  const references = referencesFromTimelineItem(item)
  const mediaItems = item.attachments.filter(isRenderableMedia)

  // 把 attachment.id → AgentReference 做成 O(1) 表,
  // 点击略缩图时一并 reveal 到文件展示栏不用再扫一遍 references 数组。
  const referenceByAttachmentId = new Map<string, AgentReference>()
  for (const ref of references) {
    const matchPrefix = ref.id.indexOf(':')
    if (matchPrefix > 0) referenceByAttachmentId.set(ref.id.slice(matchPrefix + 1), ref)
  }

  // 仅当 attachments 全部已能解出 reference(localPath 合法、非 traversal)时,
  // 上方的 references 列表跟 attachment 一一对应。否则差集会留在 references 里,
  // 我们仍把那些"无法 reveal"的 attachment 保留在 UI(让用户至少看得见)。
  const handleClick = (clicked: AttachmentRef): void => {
    const previewable = mediaItems.map((ref) => ({
      ...ref,
      uri: toRenderableUri(ref.uri),
      thumbnailUri: ref.thumbnailUri ? toRenderableUri(ref.thumbnailUri) : undefined,
    }))
    const startIndex = mediaItems.findIndex((m) => m.id === clicked.id)
    if (startIndex >= 0) openPreview(previewable, startIndex)

    const reference = referenceByAttachmentId.get(clicked.id)
    if (reference) void openReference(reference)
  }

  return (
    <div className="my-1">
      <div className="flex flex-wrap gap-2">
        {item.attachments.map((ref) => {
          const kind = mediaKindOf(ref)
          if (kind != null && isRenderableMedia(ref)) {
            return (
              <MediaThumbWithPoster
                key={ref.id}
                src={toRenderableUri(ref.thumbnailUri ?? ref.uri)}
                videoUri={ref.uri}
                thumbnailUri={ref.thumbnailUri}
                kind={kind}
                name={ref.name}
                onClick={() => handleClick(ref)}
              />
            )
          }
          const reference = referenceByAttachmentId.get(ref.id)
          const clickable = reference != null
          // 音频没有缩略图 —— 走文件 chip 分支,但用 🎵 替代通用文件图标。
          const isAudio = ref.kind === 'audio' || (ref.mime ?? '').startsWith('audio/')
          return (
            <button
              key={ref.id}
              type="button"
              onClick={() => {
                if (reference) void openReference(reference)
              }}
              className={
                'group flex h-16 items-center gap-2 rounded border bg-zinc-900/50 px-2.5 text-[11px] text-zinc-200 transition-colors ' +
                (clickable
                  ? 'border-zinc-700/50 hover:border-cyan-400/60 hover:bg-cyan-500/10 hover:text-cyan-100 cursor-pointer'
                  : 'border-zinc-800/50 opacity-60 cursor-not-allowed')
              }
              title={clickable ? `打开 ${ref.name}` : ref.name}
              disabled={!clickable}
              aria-label={clickable ? `Open ${ref.name} in file panel` : ref.name}
            >
              {isAudio ? (
                <span aria-hidden="true" className="text-sm leading-none">🎵</span>
              ) : (
                <FileIcon className={clickable ? 'text-cyan-300/70 group-hover:text-cyan-200' : 'text-zinc-500'} />
              )}
              <span className="max-w-[120px] truncate font-mono">{ref.name}</span>
              {clickable && (
                <OpenInPanelIcon
                  className="ml-1 h-3 w-3 text-cyan-300/50 opacity-0 transition-opacity group-hover:opacity-100"
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
