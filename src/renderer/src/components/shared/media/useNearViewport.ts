import { useEffect, useState } from 'react'
import type { RefObject } from 'react'

/** 离可视区还有这么远就开始读盘:够把读盘 + 解码的几百毫秒藏在滚动里,又不会一次读完整段对话。 */
export const NEAR_VIEWPORT_MARGIN_PX = 800

/** 最近的纵向滚动祖先(聊天的消息列表);找不到就返回 null(= 用浏览器视口)。 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if (oy === 'auto' || oy === 'scroll') return p
  }
  return null
}

/**
 * 「靠近可视区」才开始加载。
 *
 * 一次对话里可能有几十到几百张图。如果每张挂载就立刻去读盘 / 解码,
 *  - 本地图是几百个 IPC 同时打到主进程(真窗口量测:240 张,主进程事件循环停 3.3 s、
 *    渲染进程一个 2.9 s 的长任务,期间滚轮和收起线程侧栏都是整个窗口冻住);
 *  - 远端图则是几百张原图同时解码(滚轮 80 格丢掉 2.7 s 的帧)。
 * 而用户其实只看得见其中几张。官方 Codex App 在「图很多的对话」里卡死 / 无响应的同类报告
 * (openai/codex#21232、#24695、#28916)的共同点也是「历史里的图一次性全拿出来渲染」,
 * 社区的缓解思路就是延迟 / 引用化。
 *
 * 没有 IntersectionObserver(jsdom、极老内核)时直接当作「已靠近」,行为同改动前。
 * 进入范围后就不再回收:blob 的释放仍由共享缓存的引用计数负责(组件卸载时释放)。
 */
export function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (near) return undefined
    const el = ref.current
    if (!el) return undefined
    const io = new IntersectionObserver(
      (entries) => {
        // near 一变,下面 effect 的清理函数就会 disconnect,这里不必重复。
        if (entries.some((e) => e.isIntersecting)) setNear(true)
      },
      // root 必须是真正的滚动容器:root=null 时 rootMargin 不会撑开中间祖先的裁剪区,
      // 「快滚到了」的图还是不会被判为相交。
      { root: findScrollParent(el), rootMargin: `${NEAR_VIEWPORT_MARGIN_PX}px 0px` },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [near, ref])
  return near
}
