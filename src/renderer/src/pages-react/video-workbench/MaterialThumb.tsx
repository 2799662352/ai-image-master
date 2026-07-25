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
  resolveMediaSrcOnce,
  useResolvedMediaSrc,
} from '../../components/shared/media/useResolvedMediaSrc'
import {
  extractAssetId,
  getCachedAssetPreview,
  resolveAssetPreviews,
  withCachedAssetPreview,
} from '../../features/video-workbench/assetPreview'
import type { MediaTokenKind } from '../../features/video-workbench/promptTokens'

/**
 * 素材 → 需要解析的缩略图目标地址:
 *  - previewUrl(人像库/官方素材的 https 预览)优先,任何 kind 都可用;
 *  - 图片素材用 src 本身(data:/https 直通;本地路径由解析层经 IPC 转 blob:);
 *  - asset:// 没有 previewUrl 时渲染端无法直连 → undefined(调用方给占位);
 *  - 视频/音频素材不出图片缩略(与既有 emoji 占位行为一致)。
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
 * asset:// 且缺 previewUrl 的素材(agent 经 MCP 挂上的旧数据)→ 惰性经
 * seedance.listAssets 解析 previewUrl(assetPreview 会话级缓存,同一
 * assetId 只查一次;多素材共享一轮全量拉取)。命中后返回补了 previewUrl
 * 的素材;未命中/解析中返回原素材(调用方保持文件名占位)。
 */
export function useAssetPreviewMaterial(material: VideoWorkbenchMaterial): VideoWorkbenchMaterial {
  const assetId = material.previewUrl ? null : extractAssetId(material.src)
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
  const target = materialThumbTarget(kind, effective) ?? ''
  // hook 不能有条件地调,所以父层接管时喂空 target —— 空串走不到 IPC。
  const parentOwns = resolvedSrc !== undefined
  const own = useResolvedMediaSrc(parentOwns ? '' : target, 'image')
  const resolved = parentOwns ? resolvedSrc : own
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

  const targets = entries.map((e) => materialThumbTarget(e.kind, withCachedAssetPreview(e.material)))
  const depKey = targets.join('\n')
  // 会话级缓存(target → 可渲染地址):素材增删只补差量,不重解析已有项,
  // 更不 revoke 仍在 DOM 里的 blob: —— 中途 revoke 会让已渲染的 chip 裂图。
  const cacheRef = useRef<Map<string, string>>(new Map())
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const cache = cacheRef.current
    const pending = [...new Set(targets.filter((t): t is string => !!t))].filter(
      (t) => !cache.has(t),
    )
    if (pending.length === 0) return
    let cancelled = false
    void Promise.all(
      pending.map(async (target) => [target, await resolveMediaSrcOnce(target, 'image')] as const),
    ).then((pairs) => {
      let changed = false
      for (const [target, out] of pairs) {
        if (!out) continue
        if (cancelled) {
          if (out.startsWith('blob:')) URL.revokeObjectURL(out)
          continue
        }
        cache.set(target, out)
        changed = true
      }
      if (!cancelled && changed) setVersion((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
    // targets 的内容全部编码进 depKey,数组引用本身每次渲染都会变,不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey])

  // 卸载时统一释放本组件创建过的 blob:(缓存里 data:/https 直通值 revoke 无害但跳过)
  useEffect(() => {
    const cache = cacheRef.current
    return () => {
      for (const url of cache.values()) {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url)
      }
      cache.clear()
    }
  }, [])

  return useMemo(
    () => targets.map((t) => (t ? cacheRef.current.get(t) : undefined)),
    // 同上:targets 内容由 depKey 表达;version 表达缓存内容变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [depKey, version],
  )
}
