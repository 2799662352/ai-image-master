/**
 * 画幅比例(aspect ratio) — 复刻实站机位全屏页底部的「画幅比例」选择,
 * 同时被 录制时间轴 与 机位全屏页 复用(单一数据源,避免两处漂移)。
 *
 * 「全屏」= 不加遮幅,铺满;其余为带黑色遮幅(letterbox)的取景框预览。
 */
import React, { useEffect, useRef, useState } from 'react';

export interface AspectOption {
  key: string;
  label: string;
  /** null = 全屏(不遮幅);否则为 宽/高 比值。 */
  ratio: number | null;
}

export const ASPECT_OPTIONS: AspectOption[] = [
  { key: 'full', label: '全屏', ratio: null },
  { key: '1:1', label: '1:1', ratio: 1 },
  { key: '4:3', label: '4:3', ratio: 4 / 3 },
  { key: '3:4', label: '3:4', ratio: 3 / 4 },
  { key: '16:9', label: '16:9', ratio: 16 / 9 },
  { key: '9:16', label: '9:16', ratio: 9 / 16 },
  { key: '3:2', label: '3:2', ratio: 3 / 2 },
  { key: '2:3', label: '2:3', ratio: 2 / 3 },
  { key: '21:9', label: '21:9', ratio: 21 / 9 },
];

export function aspectRatioOf(key: string): number | null {
  return ASPECT_OPTIONS.find((o) => o.key === key)?.ratio ?? null;
}

/** 向后兼容别名(早期会话使用的命名)。 */
export type DirectorAspect = AspectOption;
export const DIRECTOR_ASPECTS: readonly AspectOption[] = ASPECT_OPTIONS;
/** 仅含固定比例(不含「全屏」)的映射。 */
export const ASPECT_RATIO: Record<string, number> = Object.fromEntries(
  ASPECT_OPTIONS.filter((a) => a.ratio != null).map((a) => [a.key, a.ratio as number]),
);

/**
 * 取景遮幅 overlay —— 在一个 position:relative 的容器内,按所选比例画出居中
 * 取景框,框外用半透明黑遮挡(letterbox),用于预览最终成片画幅。
 * 不拦截鼠标(pointerEvents:none),不影响轨道控制。
 */
export function AspectMask({ ratioKey }: { ratioKey: string }) {
  const ratio = aspectRatioOf(ratioKey);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // “contain” fit: 取景框在容器内按比例最大化(宽或高其一贴边)。
  let fw = 0;
  let fh = 0;
  if (ratio != null && box.w > 0 && box.h > 0) {
    if (box.w / box.h > ratio) {
      fh = box.h;
      fw = box.h * ratio;
    } else {
      fw = box.w;
      fh = box.w / ratio;
    }
  }

  return (
    <div ref={wrapRef} style={maskStyles.wrap} aria-hidden>
      {ratio != null && fw > 0 && (
        <div style={{ ...maskStyles.frame, width: fw, height: fh }} />
      )}
    </div>
  );
}

/**
 * 「画幅比例」向上弹出下拉(复刻图五):点击展开,选中项带 ✓。
 * 不依赖具体页面的样式,自带极简暗色样式。
 */
export function AspectSelect({
  value,
  onChange,
  openUp = true,
}: {
  value: string;
  onChange: (key: string) => void;
  openUp?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = ASPECT_OPTIONS.find((o) => o.key === value) ?? ASPECT_OPTIONS[0];
  return (
    <div style={selStyles.root}>
      {open && (
        <>
          <div style={selStyles.backdrop} onClick={() => setOpen(false)} />
          <div style={{ ...selStyles.menu, ...(openUp ? selStyles.menuUp : selStyles.menuDown) }}>
            <div style={selStyles.menuTitle}>画幅比例</div>
            {ASPECT_OPTIONS.map((o) => (
              <button
                key={o.key}
                style={o.key === value ? selStyles.itemActive : selStyles.item}
                onClick={() => {
                  onChange(o.key);
                  setOpen(false);
                }}
              >
                <span style={selStyles.itemIcon}>{o.ratio == null ? '▭' : '▱'}</span>
                <span style={{ flex: 1, textAlign: 'left' }}>{o.label}</span>
                {o.key === value && <span style={selStyles.check}>✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
      <button style={selStyles.trigger} onClick={() => setOpen((v) => !v)} title="画幅比例">
        ▭ {current.label}
      </button>
    </div>
  );
}

const maskStyles: Record<string, React.CSSProperties> = {
  wrap: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    pointerEvents: 'none',
    zIndex: 5,
  },
  frame: {
    boxShadow: '0 0 0 100vmax rgba(0,0,0,0.55)',
    outline: '1px solid rgba(255,255,255,0.25)',
  },
};

const selStyles: Record<string, React.CSSProperties> = {
  root: { position: 'relative', display: 'inline-block' },
  trigger: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 12,
  },
  backdrop: { position: 'fixed', inset: 0, zIndex: 1 },
  menu: {
    position: 'absolute',
    left: 0,
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 8,
    padding: 4,
    minWidth: 130,
    zIndex: 2,
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
    maxHeight: 320,
    overflowY: 'auto',
  },
  menuUp: { bottom: 'calc(100% + 6px)' },
  menuDown: { top: 'calc(100% + 6px)' },
  menuTitle: { color: '#8b94a2', fontSize: 11, padding: '4px 8px' },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    background: 'none',
    border: 'none',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'pointer',
    fontSize: 12,
  },
  itemActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    background: '#2d3340',
    border: 'none',
    color: '#fff',
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'pointer',
    fontSize: 12,
  },
  itemIcon: { width: 16, textAlign: 'center', opacity: 0.7 },
  check: { color: '#22d3ee' },
};
