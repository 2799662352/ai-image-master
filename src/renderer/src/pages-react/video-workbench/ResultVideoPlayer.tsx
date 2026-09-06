// 生成结果视频播放器 —— 「生成视频」工作台 succeeded 卡片的内联播放。
//
// 本地视频走 `toStreamableUri` → `local-file://media/?p=…` 流式协议。
//
// 曾经此处走 IPC 把整份文件读成 base64 再转 blob,因为 `local-file://` 直连
// 加载不出字节。那个失败的真正原因到 2026-08-12 才查清:不是盘符,是**空 host** ——
// 标准 scheme 的空 host 会被 Blink 的 IsSafeToLoadURL 在渲染端直接拒掉
// (MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check),请求根本不发出去,
// 所以主进程一条日志都没有,才会被反复误判成协议或权限问题。地址换成带 host 的
// `local-file://media/?p=…` 之后这条路通了,详见 file-explorer/uri.ts 的 toStreamableUri。
//
// 换过来解决两件事:整份文件不再进渲染进程内存(每张 succeeded 卡片各一份,
// 卡片数没有上限),以及进度条能拖(主进程按 Range 分段发,此前 seekable.end() 恒为 0)。
//
// 播放源优先级(与旧 playbackSrc 一致):本地 mp4(免网络、秒开)>
// COS 永久 URL > 上游临时地址。本地读取失败或 <video> 解码失败时自动
// 降级远程源;两边都没有时显示错误兜底(文件路径 + 「在文件夹中打开」),
// 不留空白播放器。

import { useEffect, useRef, useState } from 'react'
import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { describeUrlHealth } from '../../../../shared/signedUrlExpiry'
import { toStreamableUri } from '../../features/file-explorer/uri'

/**
 * 每个远程源的重试**时限**(不是次数)。
 *
 * 按业界口径:先定「整段重试允许花多久」,再倒推次数与退避,而不是先拍一个次数。
 * 60s 的依据是这类失败的性质 —— 实测是 `net::ERR_CONNECTION_CLOSED`,连接被对端
 * 掐断,**不是过期**(过期回 403)。对端抖动通常几十秒内自愈,而一条片子重生成
 * 要花钱又要几分钟,多等一分钟远比误判划算。
 */
const REMOTE_RETRY_WINDOW_MS = 60_000

/** 退避基数与上限。cap 取 10s:再长用户会以为卡死,而 60s 窗口也放不下几次。 */
const RETRY_BASE_MS = 500
const RETRY_CAP_MS = 10_000

/**
 * 封顶指数退避 + full jitter:`Uniform(0, min(cap, base × 2^n))`。
 *
 * jitter 在这里不是形式主义:一板 17 张卡同时加载失败时,它们会在同一毫秒一起
 * 重试同一个主机 —— 那就是个微型惊群。随机化把这些请求摊开。
 */
function retryDelayMs(attempt: number): number {
  return Math.random() * Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt)
}

/**
 * 这个错误值得重试吗?
 *
 * 「只重试瞬时错误」是退避策略的前提 —— 对 4xx 那类永久错误重试,只是把失败推迟
 * 60 秒,期间用户还以为有救。`<video>` 这边的对应物是 `MediaError.code`:
 * - NETWORK(2):传输中断 —— 正是我们要救的那种,重试。
 * - DECODE(3):字节坏了,同一个源再拉一次还是坏的 —— 换下一个候选。
 * - SRC_NOT_SUPPORTED(4):地址取不到或类型不对,403/404 通常落这里 —— 换候选。
 * - ABORTED(1):用户自己中断的,不是故障。
 *
 * 拿不到 code 时按可重试处理:宁可多等,不可把能救的判死。
 */
function isRetryableMediaError(el: HTMLVideoElement | null): boolean {
  const code = el?.error?.code
  if (code === undefined) return true
  return code === MEDIA_ERR_ABORTED || code === MEDIA_ERR_NETWORK
}

// 写成数值而不是引用 `MediaError.*`:那是个浏览器全局，jsdom 里根本不存在，
// 靠它会让这段逻辑在测试环境直接抛 ReferenceError。数值是 HTML 规范定死的。
const MEDIA_ERR_ABORTED = 1
const MEDIA_ERR_NETWORK = 2

interface ShellBridge {
  showItemInFolder?: (p: string) => Promise<unknown>
  openExternal?: (url: string) => Promise<unknown>
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
  localFailed = false,
}: { candidates: string[]; localPath?: string; localFailed?: boolean }) {
  const [idx, setIdx] = useState(0)
  const [attempt, setAttempt] = useState(0)
  const [exhausted, setExhausted] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** 当前候选开始尝试的时刻 —— 时限是按「这个候选试了多久」算的，不是按次数。 */
  const startedAt = useRef(Date.now())

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  const restart = (): void => {
    if (timer.current) clearTimeout(timer.current)
    setIdx(0)
    setAttempt(0)
    setExhausted(false)
    startedAt.current = Date.now()
  }

  // 地址换了就从头再试一遍。「重新保存」成功后会多出一条 COS 永久地址，而放弃
  // 状态原本是黏住的 —— 明明已经有了能播的源，屏幕上还停在那句失败。
  const key = candidates.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { restart() }, [key])

  // 网络回来了自动再试一次。这条路径最常见的失败就是断网/对端抖动，让用户自己
  // 想起来点一下不合理 —— 尤其错误文案本身还在暗示「链接可能已过期」，很容易
  // 把人引去花钱重生成一条其实好好的片子。只在已放弃时挂监听。
  useEffect(() => {
    if (!exhausted) return undefined
    const onOnline = (): void => restart()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exhausted])

  const nextCandidate = (): void => {
    if (idx + 1 < candidates.length) {
      setIdx((i) => i + 1)
      setAttempt(0)
      startedAt.current = Date.now()
      return
    }
    setExhausted(true)
  }

  const onError = (e: { currentTarget: HTMLVideoElement }): void => {
    if (timer.current) clearTimeout(timer.current)
    // 永久性错误（源不支持 / 字节损坏）重试多少次都一样，直接换候选，
    // 别把 60 秒窗口浪费在一个注定失败的地址上。
    if (!isRetryableMediaError(e.currentTarget)) {
      nextCandidate()
      return
    }
    const delay = retryDelayMs(attempt)
    if (Date.now() - startedAt.current + delay < REMOTE_RETRY_WINDOW_MS) {
      timer.current = setTimeout(() => setAttempt((a) => a + 1), delay)
      return
    }
    nextCandidate()
  }

  if (exhausted) {
    return (
      <PlaybackFallback
        localPath={localPath}
        // 过期与否不用猜:预签名地址的签发时间和有效期就写在 query 里。之前这里
        // 写的是「网络问题或链接已过期」，而实测那条失败的地址签发才 13 分钟、
        // 还有 23 小时 —— 含糊其辞会把人推去花钱重生成一条其实还能下载的片子。
        // 本地那份先失败才落到这里的话要说出来:卡片底部还写着「已保存 + 路径」,
        // 不说明用户会以为文件在、是网络的问题 —— 而实情多半是文件被删或被挪了。
        reason={(localFailed ? '本地副本读不出(文件可能已被删除或移动);' : '')
          + `${candidates.length} 个地址各重试 ${REMOTE_RETRY_WINDOW_MS / 1000} 秒仍加载不出`
          + describeUrlHealth(candidates[candidates.length - 1])}
        onRetry={restart}
        externalUrl={candidates[candidates.length - 1]}
      />
    )
  }

  return (
    <>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        key={`${idx}-${attempt}`}
        data-testid="vw-remote-video"
        controls
        preload="metadata"
        src={candidates[idx]}
        className={VIDEO_CLASS}
        onError={onError}
      />
      {attempt > 0 && (
        // 60 秒静默重试和「卡死了」在屏幕上长得一模一样，必须说话。
        <p data-testid="vw-remote-retrying" className="text-white/40 text-[10px] mt-1">
          加载失败，正在重试（第 {attempt} 次
          {candidates.length > 1 ? `，源 ${idx + 1}/${candidates.length}` : ''}）…
        </p>
      )}
    </>
  )
}

/**
 * 错误兜底:不给空白播放器，给出路径与出口。
 *
 * 「加载失败」不等于「片子没了」。放弃只说明内嵌播放器这一条路没走通，而地址
 * 通常还活着 —— 所以这里必须同时给「再试一次」和「在浏览器中打开」，否则用户
 * 面对一条其实能播的视频，唯一看得见的按钮是花钱重新生成。
 */
function PlaybackFallback({ localPath, reason, onRetry, externalUrl }: {
  localPath?: string
  reason: string
  onRetry?: () => void
  externalUrl?: string
}) {
  return (
    <div
      data-testid="vw-playback-fallback"
      className="border border-orange-500/40 bg-orange-500/5 px-3 py-2.5 space-y-1.5"
    >
      <p className="text-orange-400 text-xs">⚠ 视频加载失败:{reason}</p>
      {(onRetry || externalUrl) && (
        <div className="flex items-center gap-2">
          {onRetry && (
            <button
              type="button"
              data-testid="vw-playback-retry"
              className="text-[10px] border border-[#3F3F46] text-white/70 px-2 py-1 hover:border-[#FCE300] hover:text-[#FCE300] transition-colors"
              onClick={onRetry}
            >
              ↻ 重试播放
            </button>
          )}
          {externalUrl && (
            <button
              type="button"
              data-testid="vw-playback-external"
              title="用系统浏览器打开原始地址：内嵌播放器放不了不代表地址失效"
              className="text-[10px] border border-[#3F3F46] text-white/70 px-2 py-1 hover:border-[#FCE300] hover:text-[#FCE300] transition-colors"
              onClick={() => void getShell()?.openExternal?.(externalUrl)}
            >
              ↗ 在浏览器中打开
            </button>
          )}
        </div>
      )}
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

/**
 * 本地 mp4:走流式协议播放;读取/解码失败自动降级远程源。
 *
 * 此前是 `useFileUrl` —— 整份文件经 IPC 读成 base64 再转 blob。这里是**每张
 * succeeded 卡片各一份**:一板十张成片就是十份视频常驻渲染进程内存,而且 blob 要等
 * 组件卸载才释放。卡片总量上限取消之后这条没有天花板。改走 Range 分段之后,播放器
 * 要哪段读哪段,内存里不再留整片,进度条也真能拖(此前 seekable.end() 恒为 0)。
 *
 * 不再有「加载中」这一档:协议是流式的,`<video>` 自己会边取边放,没有"先把整份读完"
 * 那个阶段可等。
 */
function LocalResultVideo({ localPath, remotes }: { localPath: string; remotes: string[] }) {
  // 文件不存在 / 编码不受支持都由 <video> 的 error 事件报出来,统一走降级。
  const [failed, setFailed] = useState(false)

  if (failed) {
    if (remotes.length > 0) return <RemoteResultVideo candidates={remotes} localPath={localPath} localFailed />
    return <PlaybackFallback localPath={localPath} reason="本地副本读不出(文件可能已被删除或移动),且没有远程地址" />
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video
      controls
      preload="metadata"
      src={toStreamableUri(localPath)}
      className={VIDEO_CLASS}
      onError={() => setFailed(true)}
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
