/**
 * 输入框工具栏上的弹层(出图渠道)定位:左边尽量贴着触发按钮,但整块弹层必须落在输入框容器
 * 的左右边界之内。
 *
 * 为什么不用纯 CSS 的 `left-0 + 固定宽度`:触发按钮在工具栏中间偏右,弹层从按钮左边起往右
 * 铺 540 px,面板窄时(或窗口缩小后)右半边会冲出聊天面板,被面板的 overflow 裁掉 ——
 * 右栏的渠道和按钮就看不见了。容器比弹层上限窄时,弹层宽度改跟着容器走。
 *
 * 坐标都是视口坐标(getBoundingClientRect)。返回的 `left` 是相对触发按钮外壳的偏移
 * (弹层 absolute 定位在外壳里),直接当 inline style 用。
 * 容器没有布局(宽度 ≤ 0,jsdom 或被隐藏)时返回 null,调用方退回 CSS 默认尺寸。
 */
export interface PopoverPlacementInput {
  /** 容器(输入框)左边,视口坐标 */
  boundsLeft: number
  /** 容器宽度 */
  boundsWidth: number
  /** 触发按钮外壳左边,视口坐标 */
  anchorLeft: number
  /** 弹层宽度上限,默认 540 */
  maxWidth?: number
}

export interface PopoverPlacement {
  left: number
  width: number
}

export const POPOVER_MAX_WIDTH = 540

export function computePopoverPlacement(input: PopoverPlacementInput): PopoverPlacement | null {
  const { boundsLeft, boundsWidth, anchorLeft, maxWidth = POPOVER_MAX_WIDTH } = input
  if (!(boundsWidth > 0)) return null
  const width = Math.min(maxWidth, boundsWidth)
  // 想贴着按钮左边;右边放不下就往左挪,最远挪到贴齐容器左边。
  const rightMostLeft = boundsLeft + boundsWidth - width
  const left = Math.max(boundsLeft, Math.min(anchorLeft, rightMostLeft))
  return { left: left - anchorLeft, width }
}
