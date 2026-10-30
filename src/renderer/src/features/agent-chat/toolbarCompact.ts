import { useLayoutEffect, useState, type RefObject } from 'react'

/**
 * 输入框工具条的「分级收纳」。
 *
 * 设计取向(对齐 Codex 官方 composer 的做法):药丸的形状与高度从不改变,宽度不够时按固定顺序
 * 先省文字、再收成纯图标,按钮一个都不丢:
 *   1. 模型 / 出图渠道的名称在药丸内部用省略号截断(纯 CSS,靠 flex 收缩 + truncate,不在这里处理);
 *   2. `c1`:出图渠道的徽标(如「官转」)、待机时的「语音」字样先收起;
 *   3. `c2`:协作模式(Default / Plan)的文字收起,只留图标 + 箭头;
 *   4. `wrap`:连图标态都放不下时(窗口极窄),药丸整颗换行,而不是被挤变形。
 *
 * 为什么用 JS 量宽度而不是 CSS 容器查询:`container-type` 会给祖先加上布局隔离,
 * 把里面的弹层(z-[40001])困进一个新的层叠上下文,弹层可能被别的元素盖住;
 * 这里只量一次行宽、在行上打 data 标记,弹层的层叠关系不受影响。
 */
export interface ToolbarCompactFlags {
  c1: boolean
  c2: boolean
  wrap: boolean
}

/** 工具条可用宽度(px)的分级阈值:小于等于该宽度就进入对应级别。 */
export const TOOLBAR_COMPACT_THRESHOLDS = {
  c1: 600,
  c2: 520,
  wrap: 450
} as const

const NONE: ToolbarCompactFlags = { c1: false, c2: false, wrap: false }

/** 纯函数:由工具条可用宽度得出各级收纳标记。宽度未知(0 / NaN / 负数)一律不收纳。 */
export function toolbarCompactFlags(width: number): ToolbarCompactFlags {
  if (!Number.isFinite(width) || width <= 0) return NONE
  return {
    c1: width <= TOOLBAR_COMPACT_THRESHOLDS.c1,
    c2: width <= TOOLBAR_COMPACT_THRESHOLDS.c2,
    wrap: width <= TOOLBAR_COMPACT_THRESHOLDS.wrap
  }
}

function sameFlags(a: ToolbarCompactFlags, b: ToolbarCompactFlags): boolean {
  return a.c1 === b.c1 && a.c2 === b.c2 && a.wrap === b.wrap
}

/**
 * 监听工具条行的宽度,返回当前的收纳级别。
 * 没有布局能力的环境(jsdom、缺少 ResizeObserver)宽度恒为 0 → 不收纳,行为与旧版一致。
 */
export function useToolbarCompact<T extends HTMLElement>(
  ref: RefObject<T | null>
): ToolbarCompactFlags {
  const [flags, setFlags] = useState<ToolbarCompactFlags>(NONE)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const next = toolbarCompactFlags(el.getBoundingClientRect().width)
      setFlags((prev) => (sameFlags(prev, next) ? prev : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])

  return flags
}
