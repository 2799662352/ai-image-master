import { useLayoutEffect, useState, type RefObject } from 'react'
import { computePopoverPlacement, type PopoverPlacement } from './popoverPlacement'

/**
 * 输入框工具条里向上弹出的面板(模型 / 出图渠道)的左右位置。
 *
 * 面板默认 `left-0` 贴着触发按钮左缘,聊天面板被缩窄时会冲出右边界被裁掉。这里在面板打开期间
 * 量一次「输入框(form)边界 + 触发按钮左缘」并随窗口缩放更新,把面板整块夹在输入框内。
 * 没有布局能力(jsdom)时返回 null,调用方回落到各自 CSS 里的默认宽度。
 */
export function usePopoverPlacement(
  rootRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
  maxWidth?: number
): PopoverPlacement | null {
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)

  useLayoutEffect(() => {
    if (!isOpen) return undefined
    const measure = (): void => {
      const root = rootRef.current
      if (!root) return
      const bounds = (root.closest('form') ?? root.parentElement ?? root).getBoundingClientRect()
      setPlacement(
        computePopoverPlacement({
          boundsLeft: bounds.left,
          boundsWidth: bounds.width,
          anchorLeft: root.getBoundingClientRect().left,
          maxWidth
        })
      )
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [isOpen, maxWidth, rootRef])

  return placement
}
