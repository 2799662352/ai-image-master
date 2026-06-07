import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 可拖动 + 可收起的浮动面板 — 复刻实站导演台右侧浮窗。
 * 复用于「机位预览浮窗」与「属性面板」,解决面板互相遮挡的问题:
 *   • 标题栏按住可拖动(指针捕获,限制在父容器内)。
 *   • 右上角 「—/▢」 收起/展开,收起后只保留标题栏。
 *   • 位置与收起状态按 `id` 持久化到 localStorage(版本化 key)。
 *
 * 面板用 position:absolute 定位,父容器须为定位上下文(viewport 已 position:relative)。
 */

interface Pos {
  left: number;
  top: number;
}

const KEY_PREFIX = 'director.floatpanel.v1.';

function loadState(id: string): { pos: Pos | null; collapsed: boolean } {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + id);
    if (raw) {
      const o = JSON.parse(raw) as { pos?: Pos | null; collapsed?: boolean };
      return { pos: o.pos ?? null, collapsed: !!o.collapsed };
    }
  } catch {
    /* ignore */
  }
  return { pos: null, collapsed: false };
}

export function FloatingPanel({
  id,
  title,
  anchor,
  width,
  zIndex = 30,
  headerExtra,
  defaultCollapsed = false,
  variant = 'dark',
  children,
}: {
  /** 持久化键 + 实例标识。 */
  id: string;
  title: React.ReactNode;
  /** 初始锚点(未拖动前),如 { right: 12, bottom: 64 }。 */
  anchor: React.CSSProperties;
  width?: number;
  zIndex?: number;
  /** 标题栏右侧附加按钮(如 全屏 / 关闭),不触发拖动。 */
  headerExtra?: React.ReactNode;
  defaultCollapsed?: boolean;
  /** 视觉变体:dark = 导演台默认深色;glass = 全景/光感编辑器的玻璃拟态。 */
  variant?: 'dark' | 'glass';
  children: React.ReactNode;
}) {
  const skin = variant === 'glass' ? glassStyles : styles;
  const ref = useRef<HTMLDivElement>(null);
  const init = useRef(loadState(id));
  const [pos, setPos] = useState<Pos | null>(init.current.pos);
  const [collapsed, setCollapsed] = useState<boolean>(
    init.current.pos === null ? defaultCollapsed : init.current.collapsed,
  );
  const drag = useRef<{ px: number; py: number; left: number; top: number } | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(KEY_PREFIX + id, JSON.stringify({ pos, collapsed }));
    } catch {
      /* ignore */
    }
  }, [id, pos, collapsed]);

  const onHeaderDown = useCallback((e: React.PointerEvent) => {
    // 收起/全屏/关闭等按钮不应触发拖动。
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    const el = ref.current;
    if (!el) return;
    const parent = el.offsetParent as HTMLElement | null;
    const pr = parent?.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const left = pr ? r.left - pr.left : r.left;
    const top = pr ? r.top - pr.top : r.top;
    drag.current = { px: e.clientX, py: e.clientY, left, top };
    setPos({ left, top });
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    e.preventDefault();
  }, []);

  const onHeaderMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const el = ref.current;
    const parent = el?.offsetParent as HTMLElement | null;
    let nl = d.left + (e.clientX - d.px);
    let nt = d.top + (e.clientY - d.py);
    if (parent && el) {
      const maxL = Math.max(0, parent.clientWidth - el.offsetWidth);
      const maxT = Math.max(0, parent.clientHeight - 34);
      nl = Math.max(0, Math.min(nl, maxL));
      nt = Math.max(0, Math.min(nt, maxT));
    }
    setPos({ left: nl, top: nt });
  }, []);

  const onHeaderUp = useCallback((e: React.PointerEvent) => {
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  const posStyle: React.CSSProperties = pos
    ? { left: pos.left, top: pos.top, right: 'auto', bottom: 'auto' }
    : anchor;

  return (
    <div ref={ref} style={{ ...skin.panel, width, zIndex, ...posStyle }}>
      <div
        style={skin.header}
        onPointerDown={onHeaderDown}
        onPointerMove={onHeaderMove}
        onPointerUp={onHeaderUp}
        title="按住拖动"
      >
        <span style={skin.grip}>⠿</span>
        <span style={skin.title}>{title}</span>
        <div style={skin.headerRight}>
          {headerExtra}
          <button
            style={skin.iconBtn}
            data-no-drag
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? '展开' : '收起'}
          >
            {collapsed ? '▢' : '—'}
          </button>
        </div>
      </div>
      {!collapsed && <div style={skin.body}>{children}</div>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    background: '#1a1c22ee',
    border: '1px solid #333a46',
    borderRadius: 10,
    zIndex: 30,
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 6px 5px 8px',
    cursor: 'move',
    userSelect: 'none',
    background: '#21242c',
    borderBottom: '1px solid #2c323c',
    touchAction: 'none',
  },
  grip: { color: '#5c6675', fontSize: 12, lineHeight: 1 },
  title: {
    flex: 1,
    color: '#cdd4df',
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  headerRight: { display: 'flex', alignItems: 'center', gap: 2 },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#8b94a2',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: '2px 5px',
    borderRadius: 5,
  },
  body: { padding: 8 },
};

/** 玻璃拟态皮肤(全景/光感编辑器),对齐 DESIGN.md:深色玻璃 + Cursor Orange 强调。 */
const glassStyles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    background: 'rgba(16,16,18,0.62)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 12,
    zIndex: 30,
    boxShadow: '0 10px 32px rgba(0,0,0,0.5)',
    WebkitBackdropFilter: 'blur(14px) saturate(1.2)',
    backdropFilter: 'blur(14px) saturate(1.2)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    cursor: 'move',
    userSelect: 'none',
    background: 'rgba(255,255,255,0.04)',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    touchAction: 'none',
  },
  grip: { color: '#7a766c', fontSize: 12, lineHeight: 1 },
  title: {
    flex: 1,
    color: '#e7e7ea',
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.6px',
    textTransform: 'uppercase',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  headerRight: { display: 'flex', alignItems: 'center', gap: 2 },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#c7c4bb',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: '2px 6px',
    borderRadius: 6,
  },
  body: { padding: '12px 14px' },
};
