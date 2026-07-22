// 素材点击预览弹窗 —— 「生成视频」工作台素材堆叠(MaterialStack)的
// 图片大图 / 视频播放 / 音频播放统一入口。
//
// 解析链路与 ResultVideoPlayer / MaterialThumb 同款纪律:
//   - https / data: / blob: 直通(渲染端原生可加载);
//   - 本地路径**不能**直塞 <img>/<video>/<audio>(local-file:// 协议在
//     Electron 渲染端有盘符解析缺陷,见 useResolvedMediaSrc 模块注释),
//     统一走 useFileUrl(IPC 读字节 → blob:);
//   - asset://(人像库)没有可播放源:图片用 previewUrl 大图兜底,
//     视频/音频显示「无法本地预览」提示(previewUrl 仅是缩略图)。
//
// 关闭:Esc / 点遮罩 / 右上角 ✕;内容区 stopPropagation。

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { useFileUrl } from '../../features/file-explorer/useFileUrl'
import { extractAssetId } from '../../features/video-workbench/assetPreview'
import type { MediaTokenKind } from '../../features/video-workbench/promptTokens'
import { useAssetPreviewMaterial } from './MaterialThumb'

/** https / data: / blob: —— 渲染端可直接加载,无需 IPC。 */
function isDirectSrc(src: string): boolean {
  return /^(https?:|data:|blob:)/i.test(src)
}

function Spinner() {
  return (
    <div className="flex items-center justify-center h-40" data-testid="vw-preview-loading">
      <div className="w-6 h-6 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function PreviewError({ reason }: { reason: string }) {
  return (
    <p data-testid="vw-preview-error" className="text-orange-400 text-xs px-4 py-8 text-center">
      ⚠ {reason}
    </p>
  )
}

/**
 * 图片大图:previewUrl(https)优先,其余源经 useResolvedMediaSrc 全保真
 * 解析;asset:// 缺 previewUrl 时先惰性查人像库列表(会话缓存)。
 */
function ImagePreviewBody({ material: raw }: { material: VideoWorkbenchMaterial }) {
  const material = useAssetPreviewMaterial(raw)
  const target = material.previewUrl ?? (extractAssetId(material.src) ? '' : material.src)
  const resolved = useResolvedMediaSrc(target, 'image', { fullFidelity: true })
  if (!target) return <PreviewError reason="素材库素材没有可预览地址" />
  if (!resolved) return <Spinner />
  return (
    <img
      src={resolved}
      alt={material.name}
      className="block max-w-[88vw] max-h-[76vh] object-contain mx-auto"
    />
  )
}

/** 本地文件 → blob: 后交给 <video>/<audio>(与 ResultVideoPlayer 同链)。 */
function LocalMediaBody({ path, kind }: { path: string; kind: 'video' | 'audio' }) {
  const file = useFileUrl(path)
  if (file.status === 'loading') return <Spinner />
  if (file.status === 'error') return <PreviewError reason={`本地文件读取失败:${file.reason}`} />
  return <MediaElement kind={kind} src={file.url} />
}

function MediaElement({ kind, src }: { kind: 'video' | 'audio'; src: string }) {
  if (kind === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        controls
        autoPlay
        preload="metadata"
        src={src}
        className="block max-w-[88vw] max-h-[76vh] bg-black mx-auto"
      />
    )
  }
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio controls autoPlay src={src} className="block w-[420px] max-w-[88vw] mx-auto my-8" />
  )
}

/** 视频/音频:https/data 直通;本地路径走 IPC;asset:// 提示不可本地播放。 */
function AvPreviewBody({ kind, material }: { kind: 'video' | 'audio'; material: VideoWorkbenchMaterial }) {
  if (isDirectSrc(material.src)) return <MediaElement kind={kind} src={material.src} />
  if (extractAssetId(material.src)) {
    return (
      <div className="px-4 py-6 space-y-3 text-center">
        {material.previewUrl && (
          <img
            src={material.previewUrl}
            alt={material.name}
            className="block max-w-[60vw] max-h-[50vh] object-contain mx-auto"
          />
        )}
        <PreviewError reason="人像库素材仅存于云端,无法本地播放(生成时上游直接引用)" />
      </div>
    )
  }
  return <LocalMediaBody path={material.src} kind={kind} />
}

export interface MaterialPreviewModalProps {
  kind: MediaTokenKind
  material: VideoWorkbenchMaterial
  onClose: () => void
}

export function MaterialPreviewModal({ kind, material, onClose }: MaterialPreviewModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  let body: ReactNode
  if (kind === 'image') body = <ImagePreviewBody material={material} />
  else body = <AvPreviewBody kind={kind} material={material} />

  return createPortal(
    <div
      data-testid="vw-material-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${material.name}`}
      className="fixed inset-0 z-[80] bg-black/85 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="max-w-[92vw] max-h-[86vh] min-w-[280px] bg-[#111113] border border-[#3F3F46] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-3 py-2 border-b border-[#27272A]">
          <span className="text-white/80 text-xs truncate flex-1" title={material.name}>
            {kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '🖼'} {material.name}
          </span>
          <button
            type="button"
            aria-label="关闭预览"
            className="text-white/40 hover:text-white px-1 shrink-0"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div className="overflow-auto p-2">{body}</div>
      </div>
    </div>,
    document.body,
  )
}
