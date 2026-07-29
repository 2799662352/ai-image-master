// 生成结果视频播放器 —— 「生成视频」工作台 succeeded 卡片的内联播放。
//
// 为什么不能把 `toRenderableUri(本地路径)` 直塞 <video src>:`local-file://`
// 自定义协议在 Electron 渲染端有盘符解析缺陷(electron/electron#49073,
// 详见 useResolvedMediaSrc 模块注释),<video> 直连加载不出字节——播放器
// 渲染出来但时长 0:00、画面空白。项目里所有能正常播本地视频的表面
// (文件浏览器 VideoViewer、聊天 Lightbox)都是把字节经 IPC 读回转 blob:
// 再喂给 <video>。这里复用同一条链(useFileUrl → attachments:read-thumb,
// >100MB 自动落 fs:read-binary,uploads 目录在其 allowed roots 内)。
//
// 播放源优先级(与旧 playbackSrc 一致):本地 mp4(免网络、秒开)>
// COS 永久 URL > 上游临时地址。本地读取失败或 <video> 解码失败时自动
// 降级远程源;两边都没有时显示错误兜底(文件路径 + 「在文件夹中打开」),
// 不留空白播放器。

import { useState } from 'react'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { useFileUrl } from '../../features/file-explorer/useFileUrl'

interface ShellBridge {
  showItemInFolder?: (p: string) => Promise<unknown>
}

function getShell(): ShellBridge | undefined {
  return (window as unknown as { electronAPI?: { shell?: ShellBridge } }).electronAPI?.shell
}

const VIDEO_CLASS = 'w-full max-h-[420px] bg-black border border-[#27272A]'

/** 远程候选(COS 永久 URL 优先于上游临时地址)。 */
export function remoteVideoSrc(card: Pick<VideoWorkbenchCard, 'remoteUrl' | 'videoUrl'>): string | null {
  return card.remoteUrl || card.videoUrl || null
}

/** 错误兜底:不给空白播放器,给出路径与「在文件夹中打开」。 */
function PlaybackFallback({ localPath, reason }: { localPath?: string; reason: string }) {
  return (
    <div
      data-testid="vw-playback-fallback"
      className="border border-orange-500/40 bg-orange-500/5 px-3 py-2.5 space-y-1.5"
    >
      <p className="text-orange-400 text-xs">⚠ 视频加载失败:{reason}</p>
      {localPath && (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white/40 text-[10px] truncate" title={localPath}>
            {localPath}
          </span>
          <button
            type="button"
            className="shrink-0 text-[10px] border border-[#3F3F46] text-white/70 px-2 py-1 hover:border-[#FCE300] hover:text-[#FCE300] transition-colors"
            onClick={() => void getShell()?.showItemInFolder?.(localPath)}
          >
            📂 在文件夹中打开
          </button>
        </div>
      )}
    </div>
  )
}

/** 本地 mp4:字节经 IPC 转 blob: 播放;读取/解码失败自动降级远程源。 */
function LocalResultVideo({ localPath, remoteSrc }: { localPath: string; remoteSrc: string | null }) {
  const file = useFileUrl(localPath)
  // blob: 喂进 <video> 后解码失败(极少见,文件损坏)也走降级
  const [decodeFailed, setDecodeFailed] = useState(false)

  if (file.status === 'loading') {
    return (
      <div
        data-testid="vw-playback-loading"
        className="flex items-center justify-center h-40 bg-black border border-[#27272A]"
      >
        <div className="w-6 h-6 border-2 border-[#FCE300] border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  if (file.status === 'error' || decodeFailed) {
    if (remoteSrc) {
      // eslint-disable-next-line jsx-a11y/media-has-caption
      return <video controls preload="metadata" src={remoteSrc} className={VIDEO_CLASS} />
    }
    return (
      <PlaybackFallback
        localPath={localPath}
        reason={file.status === 'error' ? file.reason : '视频解码失败'}
      />
    )
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      controls
      preload="metadata"
      src={file.url}
      className={VIDEO_CLASS}
      onError={() => setDecodeFailed(true)}
    />
  )
}

/** 可播放源:卡片当前结果或某一历史版本,两者都有这三个字段。 */
export type PlaybackSource = Pick<VideoWorkbenchCard, 'localPath' | 'remoteUrl' | 'videoUrl'>

/**
 * 结果视频播放器入口。localPath / remoteUrl / videoUrl 全缺时返回 null
 * (与旧 playbackSrc 返回 null 的分支等价,外层不渲染结果区)。
 */
export function ResultVideoPlayer({ source }: { source: PlaybackSource }) {
  const remote = remoteVideoSrc(source)
  const [remoteFailed, setRemoteFailed] = useState(false)
  if (source.localPath) {
    return <LocalResultVideo localPath={source.localPath} remoteSrc={remote} />
  }
  if (remote) {
    if (remoteFailed) return <PlaybackFallback reason="远程地址加载失败(可能已过期,可重新生成)" />
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        controls
        preload="metadata"
        src={remote}
        className={VIDEO_CLASS}
        onError={() => setRemoteFailed(true)}
      />
    )
  }
  return null
}

/** 卡片是否有任何可尝试的播放源(外层决定要不要渲染结果区)。 */
export function hasPlaybackSource(
  card: Pick<VideoWorkbenchCard, 'localPath' | 'remoteUrl' | 'videoUrl'>,
): boolean {
  return !!(card.localPath || card.remoteUrl || card.videoUrl)
}
