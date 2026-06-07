import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraSlot, DirectorStageHandle } from './DirectorStageScene';
import { FOV_RANGE, FOV_STEP } from './directorConstants';
import { AspectMask, AspectSelect, aspectRatioOf } from './directorAspect';
import { FloatingPanel } from './directorFloatingPanel';

interface Props {
  stageRef: React.RefObject<DirectorStageHandle | null>;
  /** Free-view FOV readout (kept in sync by the parent). */
  freeFov: number;
  onClose: () => void;
  /** Enter真实机位全屏 — parent expands the live stage to fullscreen for this tab. */
  onFullscreen: (tab: string) => void;
}

const THUMB_W = 232;
const THUMB_H = 130; // ~16:9

/**
 * 机位预览浮窗 + 属性面板 — 复刻实站导演台:
 * 右下角浮窗带「自由视角 | 机位N | +机位」标签与实时缩略图(FOV 叠加),
 * 选中某机位时右侧弹出「属性」面板(名称/位置/LookAt/相机射线/FOV/复制/删除)。
 */
export default function DirectorCameraPanel({ stageRef, freeFov, onClose, onFullscreen }: Props) {
  const [slots, setSlots] = useState<CameraSlot[]>([]);
  /** 'free' = 自由视角, otherwise a slot id. */
  const [active, setActive] = useState<string>('free');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const refresh = useCallback(() => {
    setSlots(stageRef.current?.listCameraSlots() ?? []);
  }, [stageRef]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Throttled live thumbnail of the active tab's camera.
  useEffect(() => {
    const w = THUMB_W;
    const h = THUMB_H;
    const cv = canvasRef.current;
    if (cv) {
      cv.width = w;
      cv.height = h;
    }
    let raf = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const draw = () => {
      const stage = stageRef.current;
      const cvNow = canvasRef.current;
      if (stage && cvNow) {
        stage.renderSlotPreview(active === 'free' ? null : active, cvNow);
      }
    };
    raf = requestAnimationFrame(draw);
    timer = setInterval(draw, 220);
    return () => {
      cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
    };
  }, [active, stageRef, slots.length]);

  const activeSlot = active === 'free' ? null : slots.find((s) => s.id === active) ?? null;
  const fovLabel = activeSlot ? Math.round(activeSlot.fov) : Math.round(freeFov);

  const selectTab = useCallback(
    (id: string) => {
      setActive(id);
      if (id !== 'free') stageRef.current?.applyCameraSlot(id);
    },
    [stageRef],
  );

  const addSlot = useCallback(() => {
    const slot = stageRef.current?.addCameraSlot();
    refresh();
    if (slot?.id) setActive(slot.id);
  }, [refresh, stageRef]);

  const patchSlot = useCallback(
    (id: string, patch: Parameters<DirectorStageHandle['updateCameraSlot']>[1]) => {
      stageRef.current?.updateCameraSlot(id, patch);
      refresh();
    },
    [refresh, stageRef],
  );

  const dupSlot = useCallback(
    (id: string) => {
      const c = stageRef.current?.duplicateCameraSlot(id);
      refresh();
      if (c?.id) setActive(c.id);
    },
    [refresh, stageRef],
  );

  const delSlot = useCallback(
    (id: string) => {
      stageRef.current?.removeCameraSlot(id);
      refresh();
      setActive('free');
    },
    [refresh, stageRef],
  );

  return (
    <>
      {/* 右下角预览浮窗(可拖动 / 可收起) */}
      <FloatingPanel
        id="cam-preview"
        title="机位预览"
        anchor={{ right: 12, bottom: 64 }}
        width={THUMB_W + 16}
        zIndex={30}
        headerExtra={
          <>
            <button
              style={styles.iconBtn}
              data-no-drag
              onClick={() => onFullscreen(active)}
              title="全屏 — 进入真实机位全屏"
            >
              ⛶
            </button>
            <button style={styles.iconBtn} data-no-drag onClick={onClose} title="关闭">
              ×
            </button>
          </>
        }
      >
        <div style={styles.tabScroll}>
          <button
            style={active === 'free' ? styles.tabActive : styles.tab}
            onClick={() => selectTab('free')}
          >
            自由视角
          </button>
          {slots.map((s) => (
            <button
              key={s.id}
              style={active === s.id ? styles.tabActive : styles.tab}
              onClick={() => selectTab(s.id)}
              title={s.name}
            >
              {s.name}
            </button>
          ))}
          <button style={styles.tabAdd} onClick={addSlot} title="新增机位">
            + 机位
          </button>
        </div>
        <div style={{ ...styles.thumbWrap, marginTop: 6 }}>
          <canvas ref={canvasRef} style={styles.thumb} />
          <span style={styles.fovBadge}>FOV {fovLabel}°</span>
          {active !== 'free' && slots.length === 0 && (
            <span style={styles.thumbHint}>暂无机位</span>
          )}
        </div>
      </FloatingPanel>

      {/* 右上属性面板(选中机位时,可拖动 / 可收起) */}
      {activeSlot && (
        <FloatingPanel
          id="cam-props"
          title={`属性 · ${activeSlot.name}`}
          anchor={{ right: 12, top: 12 }}
          width={220}
          zIndex={31}
        >
          <SlotProperties
            slot={activeSlot}
            onPatch={(p) => patchSlot(activeSlot.id, p)}
            onDuplicate={() => dupSlot(activeSlot.id)}
            onDelete={() => delSlot(activeSlot.id)}
          />
        </FloatingPanel>
      )}
    </>
  );
}

// ── 真实机位全屏(图四)────────────────────────────────────────
// 复刻实站「点击全屏 → 进入真实机位全屏」:实时主画面铺满,顶部左侧机位
// 标签 + FOV,右上角退出,底部中央 全屏 / 截屏。chrome 不拦截轨道控制。

export function DirectorFullscreenCam({
  stageRef,
  initialTab,
  freeFov,
  containerRef,
  onExit,
  onCapture,
}: {
  stageRef: React.RefObject<DirectorStageHandle | null>;
  initialTab: string;
  freeFov: number;
  containerRef: React.RefObject<HTMLElement | null>;
  onExit: () => void;
  /** 截屏:传入当前画幅比例(width/height),null = 全屏不裁剪。 */
  onCapture: (ratio: number | null) => void;
}) {
  const [slots, setSlots] = useState<CameraSlot[]>(
    () => stageRef.current?.listCameraSlots() ?? [],
  );
  const [active, setActive] = useState<string>(initialTab);
  const [osFull, setOsFull] = useState(false);
  /** 画幅比例(取景遮幅);'full' = 不遮幅。复用 directorAspect。 */
  const [aspect, setAspect] = useState<string>('full');

  useEffect(() => {
    setSlots(stageRef.current?.listCameraSlots() ?? []);
  }, [stageRef]);

  useEffect(() => {
    const h = () => setOsFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  const activeSlot = active === 'free' ? null : slots.find((s) => s.id === active) ?? null;
  const fovLabel = activeSlot ? Math.round(activeSlot.fov) : Math.round(freeFov);

  const select = (id: string) => {
    setActive(id);
    if (id !== 'free') stageRef.current?.applyCameraSlot(id);
  };

  const toggleOs = () => {
    const el = containerRef.current;
    if (!document.fullscreenElement) void el?.requestFullscreen?.();
    else void document.exitFullscreen?.();
  };

  return (
    <div style={styles.fsChrome}>
      {/* 画幅比例取景遮幅(全屏=无遮幅) */}
      <AspectMask ratioKey={aspect} />

      <div style={styles.fsTopLeft}>
        <div style={styles.fsTabs}>
          <button
            style={active === 'free' ? styles.tabActive : styles.tab}
            onClick={() => select('free')}
          >
            自由视角
          </button>
          {slots.map((s) => (
            <button
              key={s.id}
              style={active === s.id ? styles.tabActive : styles.tab}
              onClick={() => select(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
        <span style={styles.fsFov}>FOV {fovLabel}°</span>
      </div>

      <button style={styles.fsExit} onClick={onExit} title="退出全屏">
        ⤡
      </button>

      <div style={styles.fsBar}>
        <AspectSelect value={aspect} onChange={setAspect} openUp />
        <button style={styles.fsBarBtn} onClick={toggleOs} title="全屏">
          ⬜ {osFull ? '退出全屏' : '全屏'}
        </button>
        <button
          style={styles.fsBarBtn}
          onClick={() => onCapture(aspectRatioOf(aspect))}
          title="截屏"
        >
          📷 截屏
        </button>
      </div>
    </div>
  );
}

// ── 属性面板 ─────────────────────────────────────────────────────

function SlotProperties({
  slot,
  onPatch,
  onDuplicate,
  onDelete,
}: {
  slot: CameraSlot;
  onPatch: (p: Parameters<DirectorStageHandle['updateCameraSlot']>[1]) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  return (
    <div style={styles.propsInner}>
      <label style={styles.fieldLabel}>名称</label>
      <input
        style={styles.nameInput}
        value={slot.name}
        onChange={(e) => onPatch({ name: e.target.value })}
      />

      <label style={styles.fieldLabel}>位置</label>
      <Vec3
        value={slot.position}
        onChange={(v) => onPatch({ position: v })}
        colors={['#c0564f', '#5f9e57', '#4a78c0']}
      />

      <label style={styles.fieldLabel}>LookAt 目标</label>
      <div style={styles.selectFake}>手动坐标</div>

      <label style={styles.fieldLabel}>LookAt 坐标</label>
      <Vec3
        value={slot.target}
        onChange={(v) => onPatch({ target: v })}
        colors={['#c0564f', '#5f9e57', '#4a78c0']}
      />

      <label style={styles.rowToggle}>
        <span>相机射线</span>
        <input
          type="checkbox"
          checked={slot.showRay}
          onChange={(e) => onPatch({ showRay: e.target.checked })}
        />
      </label>

      <label style={styles.fieldLabel}>FOV</label>
      <div style={styles.fovRow}>
        <input
          type="range"
          min={FOV_RANGE[0]}
          max={FOV_RANGE[1]}
          step={FOV_STEP}
          value={slot.fov}
          onChange={(e) => onPatch({ fov: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span style={styles.fovNum}>{Math.round(slot.fov)}°</span>
      </div>

      <div style={styles.propBtns}>
        <button style={styles.dupBtn} onClick={onDuplicate}>
          复制
        </button>
        <button style={styles.delBtn} onClick={onDelete}>
          删除
        </button>
      </div>
    </div>
  );
}

// ── XYZ 数值行(±1 步进 + 拖动 + 滚轮微调) ─────────────────────

function Vec3({
  value,
  onChange,
  colors,
}: {
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
  colors: [string, string, string];
}) {
  const set = (axis: 0 | 1 | 2, n: number) => {
    const next: [number, number, number] = [...value];
    next[axis] = Math.round(n * 100) / 100;
    onChange(next);
  };
  return (
    <div style={styles.vec3}>
      {(['X', 'Y', 'Z'] as const).map((ax, i) => (
        <NumStepper
          key={ax}
          label={ax}
          color={colors[i]}
          value={value[i as 0 | 1 | 2]}
          onChange={(n) => set(i as 0 | 1 | 2, n)}
        />
      ))}
    </div>
  );
}

function NumStepper({
  label,
  color,
  value,
  onChange,
}: {
  label: string;
  color: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const dragRef = useRef<{ y: number; v: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { y: e.clientY, v: value };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    onChange(d.v + (d.y - e.clientY) * 0.05);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };
  return (
    <div style={styles.stepper}>
      <span style={{ ...styles.axisTag, background: color }}>{label}</span>
      <input
        style={styles.numInput}
        type="number"
        step={0.1}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        onWheel={(e) => onChange(value + (e.deltaY < 0 ? 0.1 : -0.1))}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="按住上下拖动可快速调整;滚轮可微调"
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  win: {
    position: 'absolute',
    right: 12,
    bottom: 64,
    background: '#1a1c22ee',
    border: '1px solid #333a46',
    borderRadius: 10,
    padding: 8,
    zIndex: 30,
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
  },
  tabs: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
  tabScroll: { display: 'flex', gap: 4, overflowX: 'auto', flex: 1 },
  tab: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#aab2bf',
    borderRadius: 6,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
  },
  tabActive: {
    background: '#2d3340',
    border: '1px solid #4a505a',
    color: '#fff',
    borderRadius: 6,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
  },
  tabAdd: {
    background: 'none',
    border: '1px dashed #4a505a',
    color: '#8b94a2',
    borderRadius: 6,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
  },
  winIcons: { display: 'flex', gap: 2 },
  iconBtn: {
    background: 'none',
    border: 'none',
    color: '#8b94a2',
    cursor: 'pointer',
    fontSize: 14,
    padding: '0 4px',
  },
  thumbWrap: { position: 'relative', lineHeight: 0 },
  thumb: { width: '100%', borderRadius: 6, display: 'block', background: '#0c0e12' },
  fovBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    background: '#000a',
    color: '#e5e9f0',
    fontSize: 11,
    padding: '1px 6px',
    borderRadius: 4,
  },
  thumbHint: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    color: '#6b7480',
    fontSize: 12,
  },
  // properties panel
  props: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 220,
    background: '#1a1c22f2',
    border: '1px solid #333a46',
    borderRadius: 10,
    padding: 12,
    zIndex: 31,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
  },
  propsInner: { display: 'flex', flexDirection: 'column', gap: 6 },
  propTitle: { color: '#e5e9f0', fontSize: 13, fontWeight: 600, marginBottom: 2 },
  fieldLabel: { color: '#8b94a2', fontSize: 11, marginTop: 4 },
  nameInput: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#e5e9f0',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 12,
  },
  selectFake: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '5px 8px',
    fontSize: 12,
  },
  vec3: { display: 'flex', flexDirection: 'column', gap: 4 },
  stepper: { display: 'flex', alignItems: 'center', gap: 6 },
  axisTag: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 700,
    width: 16,
    height: 18,
    borderRadius: 4,
    display: 'grid',
    placeItems: 'center',
    flexShrink: 0,
  },
  numInput: {
    flex: 1,
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#e5e9f0',
    borderRadius: 6,
    padding: '4px 6px',
    fontSize: 12,
    width: '100%',
  },
  rowToggle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: '#cbd2dd',
    fontSize: 12,
    marginTop: 6,
    cursor: 'pointer',
  },
  fovRow: { display: 'flex', alignItems: 'center', gap: 8 },
  fovNum: { color: '#cbd2dd', fontSize: 11, width: 32, textAlign: 'right' },
  propBtns: { display: 'flex', gap: 8, marginTop: 8 },
  dupBtn: {
    flex: 1,
    background: '#2f5fb0',
    border: 'none',
    color: '#fff',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
  },
  delBtn: {
    flex: 1,
    background: '#b5403a',
    border: 'none',
    color: '#fff',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
  },
  // 真实机位全屏 chrome —— 不拦截轨道控制(pointerEvents:none),按钮单独开启
  fsChrome: { position: 'absolute', inset: 0, zIndex: 40, pointerEvents: 'none' },
  fsTopLeft: {
    position: 'absolute',
    top: 12,
    left: 12,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    pointerEvents: 'auto',
  },
  fsTabs: { display: 'flex', gap: 4 },
  fsFov: {
    alignSelf: 'flex-start',
    background: '#000a',
    color: '#e5e9f0',
    fontSize: 12,
    padding: '2px 8px',
    borderRadius: 4,
  },
  fsExit: {
    position: 'absolute',
    top: 12,
    right: 12,
    background: '#1a1c22cc',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    width: 30,
    height: 30,
    cursor: 'pointer',
    fontSize: 16,
    pointerEvents: 'auto',
  },
  fsBar: {
    position: 'absolute',
    bottom: 24,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: '#15171ccc',
    border: '1px solid #333a46',
    borderRadius: 10,
    padding: '6px 10px',
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
    pointerEvents: 'auto',
  },
  fsBarBtn: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 14px',
    cursor: 'pointer',
    fontSize: 12,
  },
};
