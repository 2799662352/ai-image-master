/**
 * CosResultThumb —— 结果卡正方形图区的缩略图,生成页 / 批量页共用。铺满图区
 * (object-cover);点击放大的 lightbox 由父组件用原始 URL 打开,永远是无损原图。
 *
 * 候选链(见 `components/shared/media/mediaFallback.ts`):
 *   ① 桶里已存的持久化缩略图(上传时万象顺手落的普通对象;老图没有 → 404 秒让位)
 *   ② COS 源经数据万象实时缩成 `size` px WebP
 *   ③ 裸 URL —— 数据万象处理失败 / 代理下 CI 不可达时,原对象 GET 往往还通
 *   ④ 本地副本 `localPath` —— 主进程上传前已落盘,不经网络、永不过期
 * 过期的预签名直出链接在整理候选时直接丢掉(必 403)。blob:/data: 原样透传;
 * data: 再经 useDisplaySrc 换成 blob: 以免主线程解码大 base64。
 */
import { useMemo, useState } from 'react'
import { useDisplaySrc } from '../../../hooks/useDisplaySrc'
import { toRenderableUri } from '../../../features/file-explorer/uri'
import { appendCosThumb, persistedCosThumbUrl } from '../../../utils/cosThumb'
import { buildMediaCandidates } from '../media/mediaFallback'
import { useMediaCandidates } from '../media/useMediaCandidates'

export interface CosResultThumbProps {
  url: string
  alt: string
  /** 主进程落盘的本地副本(生成页有,批量页没有)。 */
  localPath?: string
  /** 缩略边长:生成页三列 1024,批量页多列 512。 */
  size?: 512 | 1024
}

export function CosResultThumb({ url, alt, localPath, size = 1024 }: CosResultThumbProps) {
  const candidates = useMemo(
    () =>
      buildMediaCandidates(persistedCosThumbUrl(url, size) ?? appendCosThumb(url, size), [
        appendCosThumb(url, size),
        url,
        localPath ? toRenderableUri(localPath) : undefined,
      ]),
    [url, localPath, size],
  )
  const { src, reloadKey, onError, exhausted, retry } = useMediaCandidates(candidates, 'image', { thumbSize: size })
  const imgSrc = useDisplaySrc(src ?? undefined)
  // 退避重试的十几秒里 <img> 会先画成浏览器的裂图 + alt 文字;在 onLoad 之前把它压成
  // 透明,底下用骨架脉冲顶着 —— 用户看到的是「在加载」,不是「坏了」。
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const loaded = loadedKey === `${reloadKey}|${imgSrc ?? ''}`

  if (exhausted) {
    return (
      <div
        role="img"
        aria-label={`${alt}（加载失败）`}
        title="链接已过期或网络不可达(开着代理时 COS 可能连不上);本地副本也没读到。"
        className="st-hatch absolute inset-0 flex flex-col items-center justify-center gap-2 text-[11px] text-zinc-500"
      >
        <span>图片加载失败</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            retry()
          }}
          className="border border-zinc-700 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-300 hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow"
        >
          重载
        </button>
      </div>
    )
  }

  if (!imgSrc) return <div aria-hidden className="absolute inset-0 animate-pulse bg-zinc-900" />

  return (
    <>
      {!loaded && <div aria-hidden className="absolute inset-0 animate-pulse bg-zinc-900" />}
      <img
        key={reloadKey}
        src={imgSrc}
        alt={alt}
        onError={onError}
        onLoad={() => setLoadedKey(`${reloadKey}|${imgSrc}`)}
        loading="lazy"
        decoding="async"
        className={`absolute inset-0 block h-full w-full object-cover ${loaded ? '' : 'opacity-0'}`}
      />
    </>
  )
}

/** 异步转存到 COS 的三种状态角标 —— 生成页 / 批量页同一份。 */
export const UPLOAD_BADGE: Record<'uploading' | 'uploaded' | 'failed', { cls: string; label: string; title: string }> = {
  uploading: {
    cls: 'bg-zinc-950/85 border border-cyberpunk-yellow/70 text-cyberpunk-yellow',
    label: 'up…',
    title: '正在异步上传到腾讯云 COS…',
  },
  uploaded: {
    cls: 'bg-emerald-950/85 border border-emerald-600/70 text-emerald-300',
    label: 'cos',
    title: '当前显示的是 COS 持久化 URL',
  },
  failed: {
    cls: 'bg-red-950/85 border border-red-600/70 text-red-300',
    label: '!cos',
    title: 'COS 转存失败,当前展示的是模型直出 URL(可能短期内会过期)',
  },
}

export function UploadBadge({ status, error }: { status?: keyof typeof UPLOAD_BADGE; error?: string }) {
  if (!status) return null
  const badge = UPLOAD_BADGE[status]
  return (
    <span
      aria-label={badge.title}
      title={error ? `${badge.title}: ${error}` : badge.title}
      className={`absolute bottom-1 left-1 px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wider ${badge.cls}`}
    >
      {badge.label}
    </span>
  )
}

/** 右下角「done」 + 覆在图上的极淡扫描线。 */
export function DoneMarks() {
  return (
    <>
      <span aria-hidden className="st-scan pointer-events-none absolute inset-0" />
      <span aria-hidden className="absolute bottom-1 right-1 bg-green-900/80 px-1 py-px font-mono text-[9px] font-bold uppercase tracking-wider text-green-200">
        done
      </span>
    </>
  )
}
