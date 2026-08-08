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

import { useEffect, useRef, useState } from 'react'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { useFileUrl } from '../../features/file-explorer/useFileUrl'

/**
 * 每个远程源重试几次。
 *
 * 实测的失败长这样:`net::ERR_CONNECTION_CLOSED` —— 连接被对端掐断,**不是过期**
 * (过期会回 403)。这类抖动重试一次通常就过,而此前一次 onError 就永久判死,
 * 用户看到的是「地址已失效,可重新生成」,被引去花钱重跑一条已经生成好的片子。
 */
const REMOTE_RETRY_LIMIT = 3

/** 重试间隔:1s / 2s / 4s。够躲开瞬断,又不至于让人以为卡住了。 */
const retryDelayMs = (attempt: number): number => 1000 * 2 ** attempt

interface ShellBridge {
  showItemInFolder?: (p: string) => Promise<unknown>
}

function getShell(): ShellBridge | undefined {
  return (window as unknown as { electronAPI?: { shell?: ShellBridge } }).electronAPI?.shell
}

const VIDEO_CLASS = 'w-full max-h-[420px] bg-black border border-[#27272A]'

/**
 * 远程候选,按可靠性排序:COS 永久 URL > 上游临时地址。
 *
 * 返回**列表**而不是单个 —— 此前二选一，COS 那条断了就直接判死，明明还有上游
 * 地址可试。两条都留着，逐个降级。
 */
export function remoteVideoCandidates(
  card: Pick<VideoWorkbenchCard, 'remoteUrl' | 'videoUrl'>,
): string[] {
  return [card.remoteUrl, card.videoUrl].filter((u): u is string => !!u)
}

/** 首选远程源。保留给只关心「有没有」的调用方。 */
export function remoteVideoSrc(card: Pick<VideoWorkbenchCard, 'remoteUrl' | 'videoUrl'>): string | null {
  return remoteVideoCandidates(card)[0] ?? null
}

/**
 * 远程播放:每个候选重试若干次，用尽再降到下一个候选。
 *
 * `<video>` 没有「重新加载」的公开接口，换 key 强制重挂是最干净的做法 ——
 * 也顺带绕开某些实现会缓存失败结果的行为。
 */
function RemoteResultVideo({
  candidates,
  localPath,
}: { candidates: string[]; localPath?: string }) {
  const [idx, setIdx] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const onError = (): void => {
    if (timer.current) clearTimeout(timer.current)
    if (attempt + 1 < REMOTE_RETRY_LIMIT) {
      timer.current = setTimeout(() => setAttempt((a) => a + 1), retryDelayMs(attempt))
      return
    }
    // 这个候选用尽了，换下一个（COS → 上游临时地址）。
    if (idx + 1 < candidates.length) {
      setIdx((i) => i + 1)
      setAttempt(0)
      return
    }
    setExhausted(true)
  }

  if (exhausted) {
    return (
      <PlaybackFallback
        localPath={localPath}
        // 不再断言「已过期」：实际最常见的是连接被掐断，过期会回 403。
        // 说清「试了几次」比给一个可能错误的原因有用，也免得把人引去花钱重生成。
        reason={`远程地址连续 ${REMOTE_RETRY_LIMIT * candidates.length} 次加载失败（网络问题或链接已过期）`}
      />
    )
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      key={`${idx}-${attempt}`}
      data-testid="vw-remote-video"
      controls
      preload="metadata"
      src={candidates[idx]}
      className={VIDEO_CLASS}
      onError={onError}
    />
  )
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
function LocalResultVideo({ localPath, remotes }: { localPath: string; remotes: string[] }) {
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
    // 本地读不出 / 解码失败 → 走远程那条，同样带重试与逐候选降级。
    if (remotes.length > 0) return <RemoteResultVideo candidates={remotes} localPath={localPath} />

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
  const remotes = remoteVideoCandidates(source)
  if (source.localPath) {
    return <LocalResultVideo localPath={source.localPath} remotes={remotes} />
  }
  if (remotes.length > 0) return <RemoteResultVideo candidates={remotes} />
  return null
}

/** 卡片是否有任何可尝试的播放源(外层决定要不要渲染结果区)。 */
export function hasPlaybackSource(
  card: Pick<VideoWorkbenchCard, 'localPath' | 'remoteUrl' | 'videoUrl'>,
): boolean {
  return !!(card.localPath || card.remoteUrl || card.videoUrl)
}
