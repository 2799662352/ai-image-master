import { useEffect, useRef, useState } from 'react'

/**
 * useVanillaPageRefImages
 * ───────────────────────
 * 桥接 vanilla 旧页 (GeneratePage / ComparePage) 的参考图状态到 React 组件。
 *
 * 之前用 800ms 轮询，缺点：浪费 CPU，且 800ms 抖动用户感知得到。
 * 现在用「事件驱动 + 一次性 attach 重试」：
 *   1. 启动后 pull 一次当前快照
 *   2. 在 vanilla 渲染参考图缩略图的容器上挂 MutationObserver
 *   3. 容器子节点变化 → 重新 pull 一次 page.getReferenceImages()
 *   4. 容器尚未存在时(页面 lazy 渲染)用 1s 慢轮询找到为止，找到后停掉轮询
 *
 * 99% 时间是 0 轮询，只在 DOM 真变化时做一次 pull。
 *
 * @param options.getPage 返回 vanilla 页实例的 getter (例如 `() => window.generatePageTS`)
 * @param options.previewElementId 容器元素 id (vanilla 页用来挂缩略图的节点)
 * @param options.same 自定义"相同图片"判定，默认按数组长度 + 引用判等。
 */
export function useVanillaPageRefImages<T>(options: {
  getPage: () => { getReferenceImages?: () => T[] } | null
  previewElementId: string
  same?: (a: T | undefined, b: T | undefined) => boolean
}): T[] {
  const { getPage, previewElementId } = options
  const [refImages, setRefImages] = useState<T[]>([])
  const sameRef = useRef(options.same)
  sameRef.current = options.same

  useEffect(() => {
    let observer: MutationObserver | null = null
    let fallbackPoll: ReturnType<typeof setInterval> | null = null
    let cancelled = false

    const pullState = () => {
      if (cancelled) return
      const page = getPage()
      if (!page) return
      const imgs: T[] = page.getReferenceImages?.() ?? []
      setRefImages((prev) => {
        if (prev.length !== imgs.length) return imgs.slice()
        const same = sameRef.current ?? ((a, b) => a === b)
        const changed = imgs.some((img, i) => !same(img, prev[i]))
        return changed ? imgs.slice() : prev
      })
    }

    const tryAttach = (): boolean => {
      const el = document.getElementById(previewElementId)
      if (!el) return false
      pullState()
      observer = new MutationObserver(() => pullState())
      observer.observe(el, { childList: true, subtree: true })
      return true
    }

    if (!tryAttach()) {
      // 容器尚未渲染，1s 慢轮询直到找到为止。
      fallbackPoll = setInterval(() => {
        if (tryAttach()) {
          if (fallbackPoll) {
            clearInterval(fallbackPoll)
            fallbackPoll = null
          }
        }
      }, 1000)
    }

    return () => {
      cancelled = true
      observer?.disconnect()
      if (fallbackPoll) clearInterval(fallbackPoll)
    }
  }, [getPage, previewElementId])

  return refImages
}
