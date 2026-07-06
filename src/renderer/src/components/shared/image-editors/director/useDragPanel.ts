import { useCallback, useRef, useState } from 'react';

/**
 * 浮动面板自由拖动 hook(对象与机位 / 录制 Preview 等)。
 *
 * 用法:把 `handleProps` 铺到"标题栏"元素上,面板容器用 `pos` 定位
 * (position:absolute + left/top)。设计要点:
 * - 拖动阈值 4px:标题栏原有的点击行为(如折叠开关)不受影响,
 *   点击前先看 `didDrag()` 是否为真来决定要不要忽略这次 click;
 * - `setPointerCapture` 保证快速拖动不丢事件;
 * - 落点限制在视口内(至少留 48px 可抓握,拖丢了也能拽回来);
 * - 指针落在 button/select/input 上时不启动拖动(控件自身优先)。
 */
export function useDragPanel(initialX: number, initialY: number) {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
    moved: boolean;
  } | null>(null);
  /** 最近一次 pointerup 是否发生过实际拖动(供 click 处理器判断忽略). */
  const draggedRef = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      if (t.closest('button, select, input, textarea, a')) return;
      draggedRef.current = false;
      drag.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        baseX: pos.x,
        baseY: pos.y,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [pos.x, pos.y],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    d.moved = true;
    draggedRef.current = true;
    setPos({
      x: Math.min(Math.max(d.baseX + dx, 0), Math.max(0, window.innerWidth - 48)),
      y: Math.min(Math.max(d.baseY + dy, 0), Math.max(0, window.innerHeight - 48)),
    });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== e.pointerId) return;
    drag.current = null;
  }, []);

  const didDrag = useCallback(() => draggedRef.current, []);

  return {
    pos,
    setPos,
    didDrag,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      style: { cursor: 'move', touchAction: 'none' } as React.CSSProperties,
    },
  };
}
