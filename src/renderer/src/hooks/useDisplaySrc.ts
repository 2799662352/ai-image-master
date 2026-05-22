import { useEffect, useState } from 'react'

/**
 * useDisplaySrc — 把模型直出的 b64 dataURL 转成 Blob URL, 避免 `<img src=dataURL>`
 * 在主线程同步解码巨大 base64 字符串造成卡顿（数 MB base64 解码 → bitmap 是主线程同步活儿）。
 *
 * 走 Blob URL 这条路:
 *   fetch(dataURL).blob() → URL.createObjectURL(blob) → `<img src=blobURL>`
 * 浏览器对 blob: 的 PNG/WebP 解码是异步线程跑的, 主线程不卡。
 *
 * 行为:
 * - data:image/* → 异步换成 blob:; 卸载或 src 变化时 revoke
 * - http(s):// / blob: / file:// / 其他 → 原样透传, 不走 fetch
 * - undefined → undefined
 * - 转换失败 → 兜底回退到原 dataURL (慢但不黑图)
 *
 * StrictMode safety: 用 local closure 持有本次 effect 创建的 blob URL, 不要走
 * shared ref —— 否则双调用 effect 在挂载/卸载交叉时会把别的 effect 创建的 URL revoke
 * 掉。同款模式参见 features/file-explorer/useFileUrl.ts。
 *
 * 同步 reset: src 变化时立刻把 state 置成「非 dataURL 的安全值」, 避免 React 用旧 blob
 * URL 多画一帧 → 旧 URL 已被 cleanup revoke → `net::ERR_FILE_NOT_FOUND`。
 */
export function useDisplaySrc(src: string | undefined): string | undefined {
  const initial = isDataUrl(src) ? undefined : src
  const [displaySrc, setDisplaySrc] = useState<string | undefined>(initial)

  const [trackedSrc, setTrackedSrc] = useState(src)
  if (src !== trackedSrc) {
    setTrackedSrc(src)
    setDisplaySrc(isDataUrl(src) ? undefined : src)
  }

  useEffect(() => {
    if (!isDataUrl(src)) {
      setDisplaySrc(src)
      return
    }

    let cancelled = false
    let createdBlobUrl: string | null = null

    fetch(src)
      .then((res) => res.blob())
      .then((blob) => {
        if (cancelled) return
        createdBlobUrl = URL.createObjectURL(blob)
        setDisplaySrc(createdBlobUrl)
      })
      .catch(() => {
        if (cancelled) return
        setDisplaySrc(src)
      })

    return () => {
      cancelled = true
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl)
    }
  }, [src])

  return displaySrc
}

function isDataUrl(src: string | undefined): src is string {
  return typeof src === 'string' && src.startsWith('data:')
}
