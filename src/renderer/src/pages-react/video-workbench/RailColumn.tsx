// 剧栏所在的左列:背景和右边线铺满整页高度,里面的剧栏本身是「一块固定高度」的面板。
//
// 为什么要这一层:剧栏原来是 flex 行里的 stretch 子项,高度 = 右侧内容的高度。右侧一旦
// 堆了几十张任务卡,剧栏就被撑到几千 px —— 列表永远不滚、底部的导入/导出/云备份/回收站
// 被推到整页最底(实机:窗口 861px 高、右侧 6 张卡时入口在 y≈3071)。
// 现在:外层(.vw-rail-col)仍然 stretch,负责深色背景和分隔线;内层(.vw-rail-sticky)
// position:sticky,高度固定,列表在里面自己滚(一屏放不下的剧用滚轮)。
//
// 高度怎么定(演进,三版):
//  1. #447:按「视口底边 − 本列【当前】顶边」算 —— 页面往下滚时顶边上移、剧栏一路变高,
//     用户反馈「随着用户伸缩,晃眼睛」。
//  2. #451:改按「视口底边 − 本列【文档坐标】顶边」算,滚动时恒定。但粘住(sticky)之后,
//     剧栏只有「视口 − 顶栏占的 ~285px」那么高,下面空出一大块(实机 861px 高窗口:剧栏底边
//     在 y=576,下方 285px 空白,占 1/3 屏),用户反馈「这个太短了」。
//  3. 现在:高度 = 整个视口 − 上下各 12px 间隙(保底 360px),**只由窗口高度决定**,
//     与滚动、与本列在页面里的位置都无关 → 纯 CSS(`--vw-rail-h`),不再需要任何 JS 测量
//     (没有 scroll / resize 监听、没有 rAF、没有 ResizeObserver)。窗口改大小时浏览器自己重排。
//
// 两个配套的 CSS 约束(都在 workbench.css,有守卫测试):
//  - 本列 `min-height` 取同一个值:页面顶部有顶栏 + 跑马灯 + 页签(实机 ≈285px),剧栏比
//    「视口 − 285px」更高,右侧内容短时本列会比剧栏矮 → 剧栏溢出本列、被页面根的 overflow-clip
//    裁掉、底部够不着。给本列 min-height 就让页面至少长到装得下剧栏。
//  - 页面在最顶上时,剧栏底边在视口之外(多出的就是那 ~285px);底部入口(`.vw-rail-foot`)
//    自己 `position: sticky; bottom`,在剧栏未粘住之前也贴在视口底边,滚到粘住时刚好回到
//    剧栏底边 —— 「底部入口始终在屏幕里」这条(#447 的初衷)不会因为剧栏变长而丢。
//
// sticky 的前提:祖先里不能有 overflow:hidden/auto(它会成为滚动容器,sticky 就粘在一个
// 永远不滚的盒子里)。页面根用 overflow-clip 而不是 overflow-hidden,理由见 VideoWorkbenchPage。

import type { ReactNode } from 'react'

export function RailColumn({ children }: { children: ReactNode }) {
  return (
    <div className="vw-rail-col">
      <div className="vw-rail-sticky">{children}</div>
    </div>
  )
}
