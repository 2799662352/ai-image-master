// 工作台通用右键菜单:剧栏行 / 分段卡 / 分段页签共用。
//
// 渲染到 document.body(portal):剧栏 `.vw-rail-list` 是 overflow:auto、分段卡有
// transform(hover 上浮),菜单若留在它们里面会被裁掉或定位错位。
// 关闭条件:Esc / 菜单外按下鼠标(含再次右键别处)/ 窗口失焦 / 缩放 / 任何滚动。
// 只监听 mousedown 而不监听 contextmenu —— 在另一行上右键时,旧菜单靠那次 mousedown
// 关掉、新菜单再由 onContextMenu 打开;若监听 contextmenu,冒泡到 window 的那次会把
// 刚打开的新菜单立刻关掉。

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  id: string
  label: string
  onSelect: () => void
  /** 右侧的小字说明(如「移入回收站」)。 */
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** 禁用时鼠标悬停给出原因。 */
  disabledReason?: string
  /** 在这一项之前画一条分隔线。 */
  separatorBefore?: boolean
}

interface OpenState {
  x: number
  y: number
  items: ContextMenuItem[]
}

const EDGE = 8

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  // 贴着视口边缘右键时把菜单挪回视口内(先按点击位置渲染一帧,再量尺寸修正)。
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const left = Math.max(EDGE, Math.min(x, window.innerWidth - rect.width - EDGE))
    const top = Math.max(EDGE, Math.min(y, window.innerHeight - rect.height - EDGE))
    setPos((cur) => (cur.left === left && cur.top === top ? cur : { left, top }))
  }, [x, y, items.length])

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    const buttons = (): HTMLButtonElement[] =>
      Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const onArrow = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const list = buttons()
      if (list.length === 0) return
      e.preventDefault()
      const at = list.indexOf(document.activeElement as HTMLButtonElement)
      const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length
      list[next]?.focus()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', onArrow)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', onArrow)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('scroll', onClose, true)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className="vw-ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      data-testid="vw-ctx-menu"
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id} role="none">
          {item.separatorBefore && <div className="vw-ctx-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={`vw-ctx-item ${item.danger ? 'vw-ctx-danger' : ''}`}
            disabled={item.disabled}
            title={item.disabled ? item.disabledReason : undefined}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="vw-ctx-hint">{item.hint}</span>}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  )
}

/**
 * 页面里只需要一份菜单状态:`open(e, items)` 接在行/卡的 onContextMenu 上,
 * `node` 渲染在组件树任意位置(内部是 portal)。
 */
export function useContextMenu(): {
  open: (e: ReactMouseEvent, items: ContextMenuItem[]) => void
  close: () => void
  node: ReactElement | null
} {
  const [state, setState] = useState<OpenState | null>(null)
  const close = useCallback(() => setState(null), [])
  const open = useCallback((e: ReactMouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    if (items.length === 0) return
    setState({ x: e.clientX, y: e.clientY, items })
  }, [])
  const node = state ? <ContextMenu x={state.x} y={state.y} items={state.items} onClose={close} /> : null
  return { open, close, node }
}
