// COS 上的视频 → 一张静态封面(数据万象截帧,主进程生成一次后存成 COS 对象)。
//
// 与聊天气泡共用同一套:主进程 `media:ensure-video-poster` 先 HEAD 查封面在不在,
// 在就直接回、不再计费;渲染层再用 localStorage 记住「视频 → 封面」,之后连 IPC 都不走。
// 工作台用它给素材库里的视频(平台素材库存的是 COS 永久链)出缩略图。
// 本地视频不走这里 —— 本地截帧免费,见 media:thumb。

import { isCosUrl } from '../../utils/cosThumb'
import { getCachedPoster, setCachedPoster } from '../agent-chat/videoPosterCache'

type EnsureVideoPoster = (
  videoUrl: string,
) => Promise<{ ok: true; posterUrl: string; generated: boolean } | { ok: false; reason: string }>

function ensureApi(): EnsureVideoPoster | undefined {
  return (globalThis as unknown as { electronAPI?: { attachments?: { ensureVideoPoster?: EnsureVideoPoster } } })
    .electronAPI?.attachments?.ensureVideoPoster
}

const inflight = new Map<string, Promise<string | null>>()

export function canResolveVideoPoster(videoUrl: string): boolean {
  return isCosUrl(videoUrl)
}

/** 封面地址;不是 COS 视频、接口不在或生成失败时回 null。同一视频并发只发一次。 */
export function resolveVideoPoster(videoUrl: string): Promise<string | null> {
  if (!isCosUrl(videoUrl)) return Promise.resolve(null)
  const cached = getCachedPoster(videoUrl)
  if (cached) return Promise.resolve(cached)
  const running = inflight.get(videoUrl)
  if (running) return running
  const ensure = ensureApi()
  if (!ensure) return Promise.resolve(null)
  const task = ensure(videoUrl)
    .then((res) => {
      if (!res.ok) return null
      setCachedPoster(videoUrl, res.posterUrl)
      return res.posterUrl
    })
    .catch(() => null)
    .finally(() => inflight.delete(videoUrl))
  inflight.set(videoUrl, task)
  return task
}
