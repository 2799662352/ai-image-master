// 剧栏 / 分段卡的封面:pickCover 给的是参考图的 previewUrl 或 src,后者常是一条
// 本地路径(用户从 Downloads 拖进来的图)。裸路径塞进 <img> 在渲染端必裂 ——
// dev 下是 http origin 不许读 file://,打包下则撞 local-file:// 的盘符缺陷
// (见 MaterialThumb 头注)。所以和素材缩略图一样,经 useResolvedMediaSrc 解析:
// data:/https 直通,本地路径经 IPC 读字节转 blob:。解析不出或加载失败时交回占位。

import { useState, type ReactNode } from 'react'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'

export function CoverImage({ src, fallback = null }: { src: string | null; fallback?: ReactNode }) {
  const resolved = useResolvedMediaSrc(src ?? '', 'image')
  const [errored, setErrored] = useState<string | null>(null)
  if (!resolved || errored === resolved) return <>{fallback}</>
  return <img src={resolved} alt="" draggable={false} onError={() => setErrored(resolved)} />
}
