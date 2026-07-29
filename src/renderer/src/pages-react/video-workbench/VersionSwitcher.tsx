// 卡内版本切换器。只在有两版及以上时出现 —— 一版没什么可切的。
//
// 记法固定为 v1/v2,**绝不与卡片位置号拼接**:美标剧本里 47A 已经表示「第 47 场的
// A 机位」,所以插入的场次要写 A47;同理「11-2」会在「11 号卡第 2 版」和「11 号后
// 插入的第 2 张卡」之间二义。
//
// 切换只是预览,卡片的当前结果永远是最新那一版。

import type { JSX } from 'react'
import type { VideoWorkbenchVersion } from '../../../../types/videoWorkbench'

interface VersionSwitcherProps {
  versions: VideoWorkbenchVersion[]
  index: number
  onChange: (index: number) => void
}

export function VersionSwitcher({
  versions,
  index,
  onChange,
}: VersionSwitcherProps): JSX.Element | null {
  if (versions.length < 2) return null
  const current = versions[index]
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label="上一版"
        disabled={index <= 0}
        className="px-1 text-white/40 hover:text-[#FCE300] disabled:opacity-30 disabled:hover:text-white/40"
        onClick={() => onChange(index - 1)}
      >
        ◀
      </button>
      <span
        className="text-[#FCE300] tabular-nums"
        title={current ? `提示词:${current.spec.prompt}` : undefined}
      >
        v{current?.seq ?? index + 1} / {versions.length}
      </span>
      <button
        type="button"
        aria-label="下一版"
        disabled={index >= versions.length - 1}
        className="px-1 text-white/40 hover:text-[#FCE300] disabled:opacity-30 disabled:hover:text-white/40"
        onClick={() => onChange(index + 1)}
      >
        ▶
      </button>
    </span>
  )
}
