// 两张卡之间的插入缝隙。悬停才显形,点击在下方那张卡之前插入一张默认卡。
//
// 高度为 0 且绝对定位进 space-y-4 的间距里 —— 卡片流的行距不能因为多了这一层而变化。
//
// 拖拽进行中整条隐身:同一道缝已被 WorkbenchCard 的 .vw-drop-above/.vw-drop-below
// 插入指示线占用,两种视觉反馈叠在一起会互相干扰。这也是页面里那个一直传 noop 的
// onDragStateChange 终于有消费者的原因。
//
// 深度靠发丝线而非投影(DESIGN.md「Don't add drop shadows」),配色沿用工作台既有的
// zinc + #FCE300 赛博朋克体系。

import type { JSX } from 'react'
import { useVideoWorkbenchStore } from '../../features/video-workbench/store'

interface CardGapProps {
  /** 点这道缝 = 在这张卡之前插入。 */
  beforeCardId: string
  /** 拖拽进行中隐身。 */
  hidden: boolean
}

export function CardGap({ beforeCardId, hidden }: CardGapProps): JSX.Element | null {
  if (hidden) return null
  return (
    <div className="relative h-0">
      <button
        type="button"
        aria-label="在此插入卡片"
        title="在此插入卡片"
        className="absolute inset-x-0 -top-4 h-4 flex items-center justify-center opacity-0 hover:opacity-100 focus-visible:opacity-100 transition-opacity"
        onClick={() => useVideoWorkbenchStore.getState().addCards([{}], { beforeCardId })}
      >
        <span className="w-full border-t border-dashed border-[#FCE300]" />
        <span className="absolute px-2 text-[10px] leading-none font-bold text-black bg-[#FCE300]">
          ＋
        </span>
      </button>
    </div>
  )
}
