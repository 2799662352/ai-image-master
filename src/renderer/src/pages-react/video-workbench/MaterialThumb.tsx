// 素材缩略图共用件 —— 「生成视频」工作台各表面(素材堆叠 / 提示词 chip /
// @ 建议弹层)的缩略图解析与失败兜底。
//
// 为什么不能把 `toRenderableUri(本地路径)` 直接塞进 <img src>:`local-file://`
// 自定义协议在 Electron 38 渲染端存在盘符解析缺陷(electron/electron#49073,
// 详见 useResolvedMediaSrc 模块注释),`<img>` 直连必裂图。聊天附件卡/证据卡
// 等所有能正常显示本地图的表面,都是先经 useResolvedMediaSrc 把字节走 IPC
// 读回来转 blob: 再渲染 —— 这里与它们对齐,并统一「加载失败显示文件名/图标
// 而非裂图」的占位兜底。

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import {
  acquireMediaSrc,
  releaseMediaSrc,
  useResolvedMediaSrc,
} from '../../components/shared/media/useResolvedMediaSrc'
import {
  cachedAssetSourceUrl,
  extractAssetId,
  getCachedAssetPreview,
  resolveAssetPreviews,
  withCachedAssetPreview,
} from '../../features/video-workbench/assetPreview'
import type { MediaTokenKind } from '../../features/video-workbench/promptTokens'
import { canResolveVideoPoster, resolveVideoPoster } from '../../features/video-workbench/videoPoster'

/**
 * 素材 → 需要解析的缩略图目标地址:
 *  - previewUrl(人像库/官方素材的 https 预览)优先,任何 kind 都可用;
 *  - 图片素材用 src 本身(data:/https 直通;本地路径由解析层经 IPC 转 blob:);
 *  - asset:// 没有 previewUrl 时渲染端无法直连 → undefined(调用方给占位);
 *  - 视频/音频不在这里出图 —— 视频缩略图见 `materialThumbSpec`。
 */
export function materialThumbTarget(
  kind: MediaTokenKind,
  m: VideoWorkbenchMaterial,
): string | undefined {
  if (m.previewUrl) return m.previewUrl
  if (kind !== 'image') return undefined
  if (m.src.startsWith('asset://')) return undefined
  return m.src
}

/**
 * 缩略图怎么来:
 *  - `image`:图片地址(见 materialThumbTarget);
 *  - `video-frame`:本地视频 → 主进程截一帧(系统缩略图 / 自带 ffmpeg,不花钱);
 *  - `video-poster`:COS 上的视频(含平台素材库里的视频)→ 数据万象封面,生成一次后复用。
 *
 * 以前视频一律没有缩略图,从挂上去那一刻起就只显示 🎬。
 */
export type MaterialThumbSpec =
  | { key: string; kind: 'image'; src: string }
  | { key: string; kind: 'video-frame'; src: string }
  | { key: string; kind: 'video-poster'; src: string }

/** 视频截帧失败时不许退回读整个文件(见 useResolvedMediaSrc 的 thumbOnly)。 */
const VIDEO_FRAME_OPTS = { thumbOnly: true } as const

export function materialThumbSpec(
  kind: MediaTokenKind,
  m: VideoWorkbenchMaterial,
): MaterialThumbSpec | undefined {
  const image = materialThumbTarget(kind, m)
  if (image) return { key: image, kind: 'image', src: image }
  if (kind !== 'video') return undefined
  const remote = cachedAssetSourceUrl(m) ?? (/^https?:/i.test(m.src) ? m.src : undefined)
  if (remote) {
    return canResolveVideoPoster(remote)
      ? { key: `video-poster:${remote}`, kind: 'video-poster', src: remote }
      : undefined
  }
  if (/^(asset:|data:|blob:)/i.test(m.src)) return undefined
  return { key: `video-frame:${m.src}`, kind: 'video-frame', src: m.src }
}

function acquireThumb(spec: MaterialThumbSpec): Promise<string | null> {
  switch (spec.kind) {
    case 'image':
      return acquireMediaSrc(spec.src, 'image')
    case 'video-frame':
      return acquireMediaSrc(spec.src, 'video', VIDEO_FRAME_OPTS)
    case 'video-poster':
      return resolveVideoPoster(spec.src)
    default: {
      const unreachable: never = spec
      return unreachable
    }
  }
}

function releaseThumb(spec: MaterialThumbSpec): void {
  switch (spec.kind) {
    case 'image':
      releaseMediaSrc(spec.src, 'image')
      return
    case 'video-frame':
      releaseMediaSrc(spec.src, 'video', VIDEO_FRAME_OPTS)
      return
    case 'video-poster':
      // 封面是 https 静态对象,没有 blob 要回收。
      return
    default: {
      const unreachable: never = spec
      return unreachable
    }
  }
}

function useVideoPoster(videoUrl: string): string | null {
  const [state, setState] = useState<{ url: string; poster: string | null }>({ url: '', poster: null })
  useEffect(() => {
    if (!videoUrl) return
    let cancelled = false
    void resolveVideoPoster(videoUrl).then((poster) => {
      if (!cancelled) setState({ url: videoUrl, poster })
    })
    return () => {
      cancelled = true
    }
  }, [videoUrl])
  return state.url === videoUrl ? state.poster : null
}

/**
 * asset:// 的素材(agent 经 MCP 挂上的)→ 惰性去素材所在的库里查预览地址
 * (assetPreview 会话级缓存,同一 assetId 只查一次;多素材共享一轮拉取)。命中后
 * 返回补了 previewUrl 的素材;未命中/解析中返回原素材(调用方保持文件名占位)。
 */
export function useAssetPreviewMaterial(
  material: VideoWorkbenchMaterial,
  /** 预览弹窗要原始地址:即便素材已带缩略图 previewUrl 也去库里查一次。 */
  wantSource = false,
): VideoWorkbenchMaterial {
  const assetId = material.previewUrl && !wantSource ? null : extractAssetId(material.src)
  const needsResolve = assetId !== null && getCachedAssetPreview(assetId) === undefined
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (!assetId || !needsResolve) return
    let cancelled = false
    void resolveAssetPreviews([assetId]).then(() => {
      if (!cancelled) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
  }, [assetId, needsResolve])
  return withCachedAssetPreview(material)
}

export interface MaterialThumbProps {
  kind: MediaTokenKind
  material: VideoWorkbenchMaterial
  /** 无缩略图 / 解析失败 / 图片加载失败时的占位内容(文件名或图标)。 */
  fallback: ReactNode
  imgClassName?: string
  /**
   * 父层已经解析过同一个 target 时把结果传进来,三态:
   * - `undefined` = 父层不负责,本组件自己解析(独立使用时的默认)
   * - `null` = 父层负责但还没解析出来 / 解析失败 → 出 fallback
   * - `string` = 直接用
   *
   * 存在这个入口是因为工作台卡片必须在**卡片层**解析一遍(提示词 chip 是 HTML
   * 字符串渲染,跑不了 hook),不传进来的话同一张图每张卡要走两趟 IPC、造两个
   * blob —— 200 张满素材的看板峰值就是 3600 个。
   */
  resolvedSrc?: string | null
}

/**
 * 单素材缩略图:本地路径经 useResolvedMediaSrc(IPC → blob:)解析;
 * data:/https 直通;asset:// 缺 previewUrl 时惰性查人像库列表补图;
 * 解析失败或 <img> onError 时渲染 fallback。
 */
export function MaterialThumb({
  kind,
  material,
  fallback,
  imgClassName,
  resolvedSrc,
}: MaterialThumbProps) {
  const effective = useAssetPreviewMaterial(material)
  const spec = materialThumbSpec(kind, effective)
  // hook 不能有条件地调,所以父层接管 / 不是这条路时喂空串 —— 空串走不到 IPC。
  const parentOwns = resolvedSrc !== undefined
  const fileSrc = !parentOwns && spec && spec.kind !== 'video-poster' ? spec.src : ''
  const isFrame = spec?.kind === 'video-frame'
  const ownFile = useResolvedMediaSrc(fileSrc, isFrame ? 'video' : 'image', isFrame ? VIDEO_FRAME_OPTS : {})
  const ownPoster = useVideoPoster(!parentOwns && spec?.kind === 'video-poster' ? spec.src : '')
  const resolved = parentOwns ? resolvedSrc : spec?.kind === 'video-poster' ? ownPoster : ownFile
  const [erroredSrc, setErroredSrc] = useState<string | null>(null)
  if (!resolved || erroredSrc === resolved) return <>{fallback}</>
  return (
    <img
      src={resolved}
      alt={material.name}
      draggable={false}
      {...(imgClassName ? { className: imgClassName } : {})}
      onError={() => setErroredSrc(resolved)}
    />
  )
}

export interface MaterialThumbEntry {
  kind: MediaTokenKind
  material: VideoWorkbenchMaterial
}

/**
 * 批量解析素材缩略图地址(提示词 chip / @ 建议数据源用,那里是 HTML 字符串
 * 渲染,跑不了 hook,只能吃解析完成的字符串):返回与入参等长的 thumbSrc
 * 数组;data:/https 直通,本地路径异步经 IPC 转 blob:,解析完成前 / 解析
 * 失败该项为 undefined(消费方回落 emoji 占位)。
 *
 * 返回数组做了 memo:targets 与解析结果都没变时保持引用稳定,避免
 * RichPromptInput 把 mediaRefs 引用变化误判为「素材变了」而重写 innerHTML
 * (会打断正在输入的光标)。
 */
export function useMaterialThumbSrcs(entries: MaterialThumbEntry[]): Array<string | undefined> {
  // asset:// 缺 previewUrl 的条目:批量收集 assetId 一次性解析(共享一轮
  // 全量拉取,绝不按素材各发一次 list),命中后经缓存补进 previewUrl →
  // targets 变化触发下面的常规解析。
  const pendingAssetIds = [
    ...new Set(
      entries
        .map((e) => (e.material.previewUrl ? null : extractAssetId(e.material.src)))
        .filter((id): id is string => id !== null && getCachedAssetPreview(id) === undefined),
    ),
  ]
  const assetKey = pendingAssetIds.join('\n')
  const [, setAssetVersion] = useState(0)
  useEffect(() => {
    if (pendingAssetIds.length === 0) return
    let cancelled = false
    void resolveAssetPreviews(pendingAssetIds).then(() => {
      if (!cancelled) setAssetVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
    // pendingAssetIds 内容全部编码进 assetKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetKey])

  const specs = entries.map((e) => materialThumbSpec(e.kind, withCachedAssetPreview(e.material)))
  const depKey = specs.map((s) => s?.key ?? '').join('\n')
  // 本地视图(key → 可渲染地址)。字节与 blob 的所有权在 acquireMediaSrc 的
  // 共享缓存里,这里只记「本 hook 实例看到的结果」并持有对应的引用 —— 所以两张
  // 卡引用同一个文件只读一次盘、只造一个 blob,而任一张卡卸载都不会 revoke 掉
  // 另一张仍在渲染的那个地址。
  const viewRef = useRef<Map<string, string>>(new Map())
  /** 本实例已取过引用的缩略图,卸载/换素材时按它归还。 */
  const heldRef = useRef<Map<string, MaterialThumbSpec>>(new Map())
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const view = viewRef.current
    const held = heldRef.current
    const wanted = new Map<string, MaterialThumbSpec>()
    for (const s of specs) if (s) wanted.set(s.key, s)

    // 先归还已经用不到的 —— 素材被删掉后不该继续占着那份字节。
    for (const [key, spec] of [...held]) {
      if (wanted.has(key)) continue
      releaseThumb(spec)
      held.delete(key)
      view.delete(key)
    }

    const pending = [...wanted.values()].filter((s) => !held.has(s.key))
    if (pending.length === 0) return
    let cancelled = false
    // 取引用要同步做:等到 then 里再取,期间别处 release 到 0 就会白读一遍。
    const acquired = pending.map((spec) => {
      held.set(spec.key, spec)
      return [spec.key, acquireThumb(spec)] as const
    })
    void Promise.all(
      acquired.map(async ([key, p]) => [key, await p] as const),
    ).then((pairs) => {
      if (cancelled) return
      let changed = false
      for (const [key, out] of pairs) {
        if (!out) continue
        view.set(key, out)
        changed = true
      }
      if (changed) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
    // specs 的内容全部编码进 depKey,数组引用本身每次渲染都会变,不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])

  // 卸载时归还本实例持有的全部引用(共享缓存据此决定要不要真 revoke)。
  useEffect(() => {
    const view = viewRef.current
    const held = heldRef.current
    return () => {
      for (const spec of held.values()) releaseThumb(spec)
      held.clear()
      view.clear()
    }
  }, [])

  return useMemo(
    () => specs.map((s) => (s ? viewRef.current.get(s.key) : undefined)),
    // 同上:targets 内容由 depKey 表达;version 表达解析结果变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depKey, version],
  )
}
