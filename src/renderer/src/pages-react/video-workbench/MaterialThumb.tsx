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

export interface MaterialThumbProps {
  kind: MediaTokenKind
  material: VideoWorkbenchMaterial
  /** 无缩略图 / 解析失败 / 图片加载失败时的占位内容(文件名或图标)。 */
  fallback: ReactNode
  imgClassName?: string
}

/**
 * 单素材缩略图:本地路径经 useResolvedMediaSrc(IPC → blob:)解析;
 * data:/https 直通;解析失败或 <img> onError 时渲染 fallback。
 */
export function MaterialThumb({ kind, material, fallback, imgClassName }: MaterialThumbProps) {
  const target = materialThumbTarget(kind, material) ?? ''
  const resolved = useResolvedMediaSrc(target, 'image')
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
  const targets = entries.map((e) => materialThumbTarget(e.kind, e.material))
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
