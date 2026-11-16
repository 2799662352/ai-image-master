// 剧栏所在的左列:背景和右边线铺满整页高度,里面的剧栏本身固定成「一屏高」。
//
// 为什么要这一层:剧栏原来是 flex 行里的 stretch 子项,高度 = 右侧内容的高度。右侧一旦
// 堆了几十张任务卡,剧栏就被撑到几千 px —— 列表永远不滚、底部的导入/导出/云备份/回收站
// 被推到整页最底(实机:窗口 861px 高、右侧 6 张卡时入口在 y≈3071)。
// 现在:外层(.vw-rail-col)仍然 stretch,负责深色背景和分隔线;内层(.vw-rail-sticky)
// position:sticky,高度 = 视口底边 − 本列当前顶边,于是剧栏恰好占满「看得见的那一段」,
// 列表在里面自己滚,底部入口始终在剧栏底边。
//
// 高度不能写死(`calc(100vh - 180px)` 是别的面板的做法):实机里剧栏顶边在 y≈284(顶栏 +
// 跑马灯 + 页签),而且顶栏会随窗口宽度换行,这个数不是常量。所以按真实位置算,滚动时
// 随顶边上移而变高,直到粘在 TOP_GAP 处。
//
// sticky 的前提:祖先里不能有 overflow:hidden/auto(它会成为滚动容器,sticky 就粘在一个
// 永远不滚的盒子里)。页面根用 overflow-clip 而不是 overflow-hidden,理由见 VideoWorkbenchPage。

import { useLayoutEffect, useRef, type ReactNode } from 'react'

/** 粘住时剧栏离视口顶边的距离。 */
export const RAIL_TOP_GAP = 12
/** 剧栏底边离视口底边的距离。 */
export const RAIL_BOTTOM_GAP = 12
/** 窗口很矮时的保底高度:再矮就让页面滚,不要把剧栏压成看不清的一条。 */
export const RAIL_MIN_HEIGHT = 360

/**
 * 剧栏该有多高。
 * @param columnTop 本列(.vw-rail-col)当前的 getBoundingClientRect().top;页面还没滚走时是真实顶边,
 *                  滚过之后是负数,此时剧栏已粘在 RAIL_TOP_GAP。
 * @param viewportHeight window.innerHeight
 */
export function railFitHeight(columnTop: number, viewportHeight: number): number {
  const top = Math.max(columnTop, RAIL_TOP_GAP)
  return Math.max(RAIL_MIN_HEIGHT, Math.floor(viewportHeight - top - RAIL_BOTTOM_GAP))
}

export function RailColumn({ children }: { children: ReactNode }) {
  const columnRef = useRef<HTMLDivElement | null>(null)
  const stickyRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const column = columnRef.current
    const sticky = stickyRef.current
    if (!column || !sticky) return
    let frame = 0
    let applied = -1
    const fit = () => {
      frame = 0
      const next = railFitHeight(column.getBoundingClientRect().top, window.innerHeight)
      // 只在数值真变了才写样式:剧栏粘住之后高度恒定,滚动期间不该再触发任何布局。
      if (next !== applied) {
        applied = next
        sticky.style.height = `${next}px`
      }
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(fit)
    }
    fit()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    // 切到别的 tab 再切回来(display:none → 显示)时没有 scroll / resize,靠本列尺寸变化补一次。
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(column)
    return () => {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer?.disconnect()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div ref={columnRef} className="vw-rail-col">
      <div ref={stickyRef} className="vw-rail-sticky">
        {children}
      </div>
    </div>
  )
}
