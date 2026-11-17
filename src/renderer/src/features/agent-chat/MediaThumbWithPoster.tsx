/**
 * MediaThumbWithPoster — `MediaThumbnail` + automatic *persisted* poster
 * resolution for COS videos, so ANY chat surface that shows a video thumbnail
 * (artifact bubbles, attachment chips, evidence cards) paints a few-KB static
 * JPEG still instead of loading the whole `.mp4` to grab a frame.
 *
 * The poster is a static COS object generated once by the main process
 * (`media:ensure-video-poster`), HEAD-guarded so the billable 数据万象 snapshot
 * runs at most once per video, then cached client-side (`videoPosterCache`).
 * This component never points a `<video>` at a live `ci-process=snapshot` URL,
 * so there is no recurring per-render billing.
 */
import { useEffect, useRef, useState } from 'react'
import {
  MediaThumbnail,
  type MediaThumbnailKind,
} from '../../components/shared/media/MediaThumbnail'
import { useNearViewport } from '../../components/shared/media/useNearViewport'
import { toRenderableUri } from '../file-explorer/uri'
import { isCosUrl } from '../../utils/cosThumb'
import { getCachedPoster, setCachedPoster } from './videoPosterCache'

interface EnsureVideoPosterApi {
  ensureVideoPoster?: (
    videoUrl: string,
  ) => Promise<
    { ok: true; posterUrl: string; generated: boolean } | { ok: false; reason: string }
  >
}

function getEnsureVideoPoster(): EnsureVideoPosterApi['ensureVideoPoster'] | undefined {
  const api = (globalThis as unknown as { electronAPI?: { attachments?: EnsureVideoPosterApi } })
    .electronAPI
  return api?.attachments?.ensureVideoPoster
}

/**
 * Resolve a video's **static** poster URL:
 *  - explicit `thumbnailUri` wins (already a persisted still);
 *  - COS video → the persisted poster object, from the client cache if known,
 *    otherwise generated-once via the main process and then cached. Returns
 *    `undefined` only while that first-ever generation is in flight (the browser
 *    shows a metadata frame meanwhile);
 *  - non-COS / local video, and images → `undefined`.
 */
export function useResolvedVideoPoster(
  videoUri: string,
  thumbnailUri: string | undefined,
  kind: MediaThumbnailKind,
): string | undefined {
  const explicit = kind === 'video' && thumbnailUri ? toRenderableUri(thumbnailUri) : undefined
  const cosVideo = kind === 'video' && !thumbnailUri && isCosUrl(videoUri)
  const [resolved, setResolved] = useState<string | undefined>(() =>
    cosVideo ? getCachedPoster(videoUri) : undefined,
  )

  useEffect(() => {
    if (!cosVideo) return
    const cached = getCachedPoster(videoUri)
    if (cached) {
      setResolved(cached)
      return
    }
    const ensure = getEnsureVideoPoster()
    if (!ensure) return
    let cancelled = false
    void ensure(videoUri)
      .then((res) => {
        if (cancelled || !res.ok) return
        setCachedPoster(videoUri, res.posterUrl)
        setResolved(res.posterUrl)
      })
      .catch(() => {
        // Leave the poster unset — the <video> falls back to a metadata frame.
      })
    return () => {
      cancelled = true
    }
  }, [cosVideo, videoUri])

  if (explicit) return explicit
  // 缓存里有的同步给出:门控让 cosVideo 在「滚到附近」那一刻才变 true,等 effect 再补会让
  // `<video>` 先无封面地挂一帧。
  return cosVideo ? (getCachedPoster(videoUri) ?? resolved) : undefined
}

export interface MediaThumbWithPosterProps {
  /** Element src (caller-decided): full video URL for videos, thumbnail for images. */
  src: string
  /** Ordered fallbacks tried when `src` fails to load (see MediaThumbnail). */
  fallbackSrcs?: ReadonlyArray<string | undefined>
  /** The artifact's underlying video URL — drives poster generation/caching. */
  videoUri: string
  /** An already-persisted still, if the artifact carries one. */
  thumbnailUri?: string
  kind: MediaThumbnailKind
  name?: string
  onClick?: () => void
  className?: string
}

/**
 * A component (not a bare hook call) so it can be used inside `.map()` without
 * breaking the rules of hooks. Images pass straight through (poster is always
 * `undefined` for them).
 */
export function MediaThumbWithPoster({
  src,
  fallbackSrcs,
  videoUri,
  thumbnailUri,
  kind,
  name,
  onClick,
  className,
}: MediaThumbWithPosterProps) {
  // 聊天里图 / 视频缩略图可能有几百个:只有「滚到附近」的才去读盘 / 发请求 / 解码 /
  // 生成视频封面,其余先画空底框(量测与出处见 `useNearViewport`)。
  const holderRef = useRef<HTMLDivElement | null>(null)
  const near = useNearViewport(holderRef)
  const posterSrc = useResolvedVideoPoster(near ? videoUri : '', thumbnailUri, kind)
  return (
    <MediaThumbnail
      src={src}
      fallbackSrcs={fallbackSrcs}
      kind={kind}
      name={name}
      posterSrc={posterSrc}
      onClick={onClick}
      className={className}
      active={near}
      containerRef={holderRef}
    />
  )
}
