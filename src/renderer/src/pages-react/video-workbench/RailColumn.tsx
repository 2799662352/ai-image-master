// 剧栏所在的左列:背景和右边线铺满整页高度,里面的剧栏本身是「一块固定高度」的面板。
//
// 为什么要这一层:剧栏原来是 flex 行里的 stretch 子项,高度 = 右侧内容的高度。右侧一旦
// 堆了几十张任务卡,剧栏就被撑到几千 px —— 列表永远不滚、底部的导入/导出/云备份/回收站
// 被推到整页最底(实机:窗口 861px 高、右侧 6 张卡时入口在 y≈3071)。
// 现在:外层(.vw-rail-col)仍然 stretch,负责深色背景和分隔线;内层(.vw-rail-sticky)
// position:sticky,高度固定,列表在里面自己滚,底部入口始终在剧栏底边。
//
// 「固定」的意思:高度只取决于【窗口高度】和【本列在页面里的位置】,**跟滚动无关**。
// 第一版(#447)是按「视口底边 − 本列当前顶边」算的,页面往下滚时顶边上移、剧栏就一路变高
// (高度还要等下一个 rAF 才写)—— 用户反馈「随着用户伸缩,晃眼睛」,所以改成滚动时恒定。
// 现在用本列的【文档坐标】顶边(= 视口顶边 + 滚动量,滚动时恒定)算一次:页面在最顶上时,
// 剧栏恰好占满「顶边 → 视口底边」,底部入口看得见;往下滚时它整块随页面上移,粘到 TOP_GAP
// 之后停住,**大小始终不变**。不监听 scroll,滚动期间零计算。
//
// 高度不能写死(`calc(100vh - 180px)` 是别的面板的做法):实机里剧栏顶边在 y≈284(顶栏 +
// 跑马灯 + 页签),而且顶栏会随窗口宽度换行,这个数不是常量。所以按真实位置算,只在窗口
// 改大小 / 本列或页面尺寸变化时重算。
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
 * 剧栏的固定高度。
 * @param columnDocTop 本列(.vw-rail-col)顶边的【文档坐标】= getBoundingClientRect().top + 滚动量。
 *                     滚动时它恒定,所以结果不会随滚动变。
 * @param viewportHeight window.innerHeight
 */
export function railHeight(columnDocTop: number, viewportHeight: number): number {
  const top = Math.max(columnDocTop, RAIL_TOP_GAP)
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
      const docTop = column.getBoundingClientRect().top + window.scrollY
      const next = railHeight(docTop, window.innerHeight)
      // 数值没变就不写样式:拖窗口边缘时每帧都会来,多数帧高度其实不变。
      if (next !== applied) {
        applied = next
        sticky.style.height = `${next}px`
      }
    }
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(fit)
    }
    fit()
    // 故意不监听 scroll:高度与滚动无关。
    window.addEventListener('resize', schedule)
    // 没有 resize 事件的几种变化,靠尺寸观察补一次:
    //  - 切到别的 tab 再切回来(display:none → 显示):本列尺寸从 0 变回来;
    //  - 右侧内容增减 / 页面顶部(顶栏、跑马灯)长高变矮:本列或整个页面变了尺寸,顶边随之移动。
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(column)
    observer?.observe(document.body)
    return () => {
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
