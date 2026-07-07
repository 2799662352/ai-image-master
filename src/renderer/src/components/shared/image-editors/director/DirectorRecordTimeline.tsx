import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CameraKeyframe,
  CameraSlot,
  DirectorStageHandle,
  RecordResult,
} from './DirectorStageScene';
import {
  CAPTURE_RESOLUTIONS,
  RECORD_FPS,
  RECORD_FPS_DEFAULT,
  RECORD_QUALITY,
  RECORD_QUALITY_DEFAULT,
  type CaptureResolution,
  type RecordFps,
  type RecordQualityKey,
} from './directorConstants';
import { AspectSelect, aspectRatioOf } from './directorAspect';
import { useDragPanel } from './useDragPanel';
import {
  CAMERA_PRESETS,
  buildCameraPreset,
  cameraClipToJson,
  cameraKeysToGlb,
  cameraKeysToVmd,
  parseCameraClipJson,
  type CameraPresetId,
} from './directorCameraClip';
import {
  deleteAsset,
  extOf,
  getAsset,
  isCameraExt,
  listAssets,
  putAsset,
  type DirectorAsset,
} from './directorAssetStore';

/** 拖拽 payload 的 dataTransfer 类型(预设 / 我的镜头 / 机位 → 时间轴或机位)。 */
const CLIP_DND_MIME = 'application/x-director-camera-clip';

/** 机位配色(时间轴机位轨道 + 关键帧菱形 + 机位标签圆点),按机位序号循环。 */
const SLOT_COLORS = ['#f59e0b', '#34d399', '#818cf8', '#f472b6', '#22d3ee', '#eab308'];

interface Props {
  stageRef: React.RefObject<DirectorStageHandle | null>;
  onExit: () => void;
  onExported: (r: RecordResult) => void;
}

// 画幅比例与机位全屏页共用 directorAspect(单一数据源:全屏/1:1/4:3/3:4/
// 16:9/9:16/3:2/2:3/21:9),不再各自维护一份短名单。
// 时间轴时长可调(与 K 动画时间轴同款「时长」输入);上限仅作 UI 护栏,
// 实际导出时长永远 = 关键帧首→末跨度,不受此值限制。
const DUR_DEFAULT = 8;
const DUR_MIN = 1;
const DUR_MAX = 3600;

const RES_LABEL: Record<CaptureResolution, string> = { '1080p': 'FHD', '2k': '2K', '4k': '4K' };

/**
 * 录制视频 = 关键帧相机运镜时间轴 — 复刻实站:
 * 左上 Preview 面板 + 中央 16:9 安全框 + 底部 Timeline(F 加关键帧 / 插值 / 导出)。
 */
export default function DirectorRecordTimeline({ stageRef, onExit, onExported }: Props) {
  const [keys, setKeys] = useState<CameraKeyframe[]>([]);
  const [duration, setDuration] = useState(DUR_DEFAULT);
  const [playhead, setPlayhead] = useState(0);
  const [aspect, setAspect] = useState('16:9');
  const [playing, setPlaying] = useState(false);
  // 循环预览(K 动画预览同款):到末尾回起点继续播,直到手动暂停。
  const [loopPreview, setLoopPreview] = useState(true);
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [res, setRes] = useState<CaptureResolution>('1080p');
  const [fps, setFps] = useState<RecordFps>(RECORD_FPS_DEFAULT);
  const [quality, setQuality] = useState<RecordQualityKey>(RECORD_QUALITY_DEFAULT);
  const stopRef = useRef<(() => void) | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const railScrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  // ── 关键帧编辑:多选 / 打组拖动 / 剪切板 / 缩放 / 导出区间 ──────
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const lastSelRef = useRef<string | null>(null);
  const clipboardRef = useRef<CameraKeyframe[]>([]);
  const [zoom, setZoom] = useState(1); // 1 = 全宽;>1 = 放大(横向滚动)
  const [inPoint, setInPoint] = useState<number | null>(null);
  const [outPoint, setOutPoint] = useState<number | null>(null);
  // 导出时长:real = 关键帧/区间 1:1;custom = 拉伸/压缩到指定秒数
  const [durMode, setDurMode] = useState<'real' | 'custom'>('real');
  const [customDur, setCustomDur] = useState(8);
  // 镜头库弹层(预设 / 我的镜头 / 导入导出)
  const [showClips, setShowClips] = useState(false);
  const [myClips, setMyClips] = useState<DirectorAsset[]>([]);
  const [clipMsg, setClipMsg] = useState<string | null>(null);
  // 镜头文件装入时锚定到当前镜头起始位置(Blender「相机约束」同思路)。
  const [anchorClips, setAnchorClips] = useState(true);
  // Preview 多机位:'free' = 跟随实时相机(运镜),否则为某机位 id。
  // 同时也是激活的镜头轨道(Blender:选中哪台相机就编辑哪台的动画)。
  const [previewCam, setPreviewCam] = useState<string>('free');
  const [camSlots, setCamSlots] = useState<CameraSlot[]>([]);
  // 机位切换点(1→2→3→4 依序切活动机位)+ 全轨道时间总长(成片范围)。
  const [cuts, setCutsState] = useState<{ t: number; slotId: string }[]>([]);
  const [extent, setExtent] = useState(0);
  // Preview 等比缩放(0.5×–2.5×):画布分辨率与面板宽度同步缩放,比例不变。
  const [previewScale, setPreviewScale] = useState(1);
  // 多机位监视器(导播台式):同时预览所有机位,点画面 = 进该机位轨。
  const [gridMode, setGridMode] = useState(false);
  const gridRefs = useRef(new Map<string, HTMLCanvasElement>());
  const fileRef = useRef<HTMLInputElement>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 中央安全框:实测可用区域,按比例 contain 适配(纯 CSS aspect-ratio 在
  // 竖版被 maxHeight 截断时会破比例 —— 截图 bug,改 JS 计算)。
  const frameAreaRef = useRef<HTMLDivElement>(null);
  const [frameBox, setFrameBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = frameAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setFrameBox({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Preview 浮窗可拖动(标题栏抓握;选择框/×按钮不触发拖动)
  const previewDrag = useDragPanel(14, 60);

  const refresh = useCallback(() => {
    const ks = stageRef.current?.recordListKeyframes() ?? [];
    setKeys(ks);
    setCutsState(stageRef.current?.recordListCuts() ?? []);
    setExtent(stageRef.current?.recordTimelineExtent() ?? 0);
    // 删除/剪切/装入后清理失效的选中 id。
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(ks.map((k) => k.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [stageRef]);

  // Enter recording layout on mount, exit on unmount.
  useEffect(() => {
    stageRef.current?.recordEnter();
    refresh();
    return () => {
      stopRef.current?.();
      stageRef.current?.recordExit();
    };
  }, [refresh, stageRef]);

  // Live preview thumbnail of the current camera —— 跟随所选画幅比例:
  // 画布按比例适配 240×240 盒(横版贴宽、竖版贴高),内容走「cover+居中
  // 裁剪」口径,与安全框/导出画面一致。
  useEffect(() => {
    const cv = previewRef.current;
    if (cv) {
      const box = Math.round(240 * previewScale); // 等比缩放:分辨率随缩放走,画面不糊
      const r = aspectRatioOf(aspect) ?? 16 / 9; // 全屏时缩略图保持 16:9
      let w = box;
      let h = Math.round(box / r);
      if (h > box) {
        h = box;
        w = Math.max(2, Math.round(box * r));
      }
      cv.width = w;
      cv.height = h;
    }
    const draw = () =>
      stageRef.current?.renderSlotPreview(
        previewCam === 'free' ? null : previewCam,
        previewRef.current!,
      );
    const t = setInterval(() => {
      if (!gridMode && previewRef.current) draw();
    }, 200);
    return () => clearInterval(t);
  }, [aspect, gridMode, previewCam, previewScale, stageRef]);

  // 多机位监视器:所有机位画面同时刷新(2 列网格,比例跟随画幅)。
  useEffect(() => {
    if (!gridMode) return;
    const r = aspectRatioOf(aspect) ?? 16 / 9;
    const cellBox = Math.max(80, Math.round((240 * previewScale - 6) / 2));
    const t = setInterval(() => {
      for (const s of camSlots) {
        const cv = gridRefs.current.get(s.id);
        if (!cv) continue;
        let w = cellBox;
        let h = Math.round(cellBox / r);
        if (h > cellBox) {
          h = cellBox;
          w = Math.max(2, Math.round(cellBox * r));
        }
        if (cv.width !== w || cv.height !== h) {
          cv.width = w;
          cv.height = h;
        }
        stageRef.current?.renderSlotPreview(s.id, cv);
      }
    }, 250);
    return () => clearInterval(t);
  }, [aspect, camSlots, gridMode, previewScale, stageRef]);

  // 多机位:同步机位列表(挂载时 + 轮询,机位可在 3D 里被拖动/增删)。
  useEffect(() => {
    const sync = () => {
      const latest = stageRef.current?.listCameraSlots() ?? [];
      setCamSlots((prev) =>
        prev.length === latest.length &&
        prev.every(
          (p, i) => p.id === latest[i].id && p.name === latest[i].name,
        )
          ? prev
          : latest,
      );
    };
    sync();
    const t = setInterval(sync, 1000);
    return () => clearInterval(t);
  }, [stageRef]);

  // 选中的机位被删除 → 回落自由视角(Stage 侧已自动回落到自由轨)。
  useEffect(() => {
    if (previewCam !== 'free' && !camSlots.some((s) => s.id === previewCam)) {
      setPreviewCam('free');
      refresh();
    }
  }, [camSlots, previewCam, refresh]);

  // 机位轨道:机位 id → 颜色/名称;连续同机位关键帧合并成一段色带。
  const slotColorMap = useMemo(
    () => new Map(camSlots.map((s, i) => [s.id, SLOT_COLORS[i % SLOT_COLORS.length]] as const)),
    [camSlots],
  );
  const slotNameMap = useMemo(
    () => new Map(camSlots.map((s) => [s.id, s.name] as const)),
    [camSlots],
  );
  const slotSegs = useMemo(() => {
    const out: { slotId: string; from: number; to: number }[] = [];
    for (const k of keys) {
      if (!k.slotId) continue;
      const last = out[out.length - 1];
      if (last && last.slotId === k.slotId) last.to = k.t;
      else out.push({ slotId: k.slotId, from: k.t, to: k.t });
    }
    return out;
  }, [keys]);

  const addKeyframe = useCallback(() => {
    stageRef.current?.recordAddKeyframe(playhead);
    refresh();
  }, [playhead, refresh, stageRef]);

  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t));
      setPlayhead(clamped);
      stageRef.current?.recordSeek(clamped);
    },
    [duration, stageRef],
  );

  const onRailClick = (e: React.MouseEvent) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekTo(ratio * duration);
  };

  // 预设/我的镜头/机位可拖到时间尺:落点时刻 = 插入起始时间(关键帧全部可编辑);
  // 机位拖入 = 在落点按机位位姿打一个关键帧(带机位标,显示在机位轨道)。
  const onRailDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(CLIP_DND_MIME)) e.preventDefault();
  };
  const onRailDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData(CLIP_DND_MIME);
    const rail = railRef.current;
    if (!raw || !rail) return;
    e.preventDefault();
    const rect = rail.getBoundingClientRect();
    const t = Math.max(0, Math.min(duration, ((e.clientX - rect.left) / rect.width) * duration));
    try {
      const p = JSON.parse(raw) as { preset?: CameraPresetId; assetId?: string; slotId?: string };
      if (p.preset) applyPreset(p.preset, t);
      else if (p.assetId) void applyAssetClip(p.assetId, t);
      else if (p.slotId) {
        const kf = stageRef.current?.recordAddKeyframeFromSlot(p.slotId, t);
        if (kf) {
          refresh();
          flashClip(`「${slotNameMap.get(p.slotId) ?? '机位'}」已放入时间轴 @ ${t.toFixed(1)}s`);
        }
      }
    } catch {
      // 非本组件的拖拽 payload,忽略。
    }
  };

  /** 时长可调:不小于最后一个关键帧/切换点时间(否则会掉出时间轴)。 */
  const changeDuration = useCallback(
    (v: number) => {
      if (!Number.isFinite(v)) return;
      let lastT = keys.length ? keys[keys.length - 1].t : 0;
      if (cuts.length) lastT = Math.max(lastT, cuts[cuts.length - 1].t);
      const d = Math.max(DUR_MIN, Math.max(Math.ceil(lastT), Math.min(DUR_MAX, v)));
      setDuration(d);
      setPlayhead((p) => Math.min(p, d));
    },
    [cuts, keys],
  );

  /** 底部浮动提示(镜头库/编辑操作共用)。 */
  const flashClip = useCallback((m: string) => {
    setClipMsg(m);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setClipMsg(null), 2600);
  }, []);
  useEffect(() => () => {
    if (msgTimer.current) clearTimeout(msgTimer.current);
  }, []);

  /** 激活某条镜头轨道('free' 或机位 id)——Blender:选中哪台相机就编辑
   *  哪台的 Action。进机位后:时间轴切成该机位的轨道、实时相机跳过去、
   *  拖动视角 = 挪机位(Lock Camera to View)、F/录制 K 到该轨。 */
  const activateTrack = useCallback(
    (id: string) => {
      const st = stageRef.current;
      if (!st) return;
      st.recordSetActiveTrack(id);
      setPreviewCam(id);
      setSelected(new Set());
      if (id !== 'free') {
        st.applyCameraSlot(id);
        const name = camSlots.find((s) => s.id === id)?.name ?? '机位';
        flashClip(`已进入「${name}」镜头轨:拖动视角 = 挪机位;F = K 镜头到该轨`);
      }
      refresh();
    },
    [camSlots, flashClip, refresh, stageRef],
  );

  /** 在游标处打一个「切到当前机位」的切换点(Blender Marker+Ctrl-B 同款)。 */
  const addCutAtPlayhead = useCallback(() => {
    if (previewCam === 'free') return;
    stageRef.current?.recordAddCut(playhead, previewCam);
    refresh();
    flashClip(
      `切换点 @ ${playhead.toFixed(1)}s → ${slotNameMap.get(previewCam) ?? '机位'}(双击旗标删除)`,
    );
  }, [flashClip, playhead, previewCam, refresh, slotNameMap, stageRef]);

  // ── 关键帧编辑:选中 / 打组拖动 / 更新 / 删除 / 剪切复制粘贴 ──────
  /** 点击选中:普通点=单选+跳到该帧;Ctrl/⌘=切换;Shift=连选。 */
  const selectKey = useCallback(
    (k: CameraKeyframe, mods: { ctrl: boolean; shift: boolean }) => {
      if (mods.ctrl) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(k.id)) next.delete(k.id);
          else next.add(k.id);
          return next;
        });
      } else if (mods.shift && lastSelRef.current) {
        const i0 = keys.findIndex((x) => x.id === lastSelRef.current);
        const i1 = keys.findIndex((x) => x.id === k.id);
        if (i0 !== -1 && i1 !== -1) {
          const [a, b] = i0 < i1 ? [i0, i1] : [i1, i0];
          setSelected(new Set(keys.slice(a, b + 1).map((x) => x.id)));
        }
      } else {
        setSelected(new Set([k.id]));
        seekTo(k.t);
      }
      lastSelRef.current = k.id;
    },
    [keys, seekTo],
  );

  /**
   * 关键帧拖动(打组自由移动):按住已选中的帧 = 整组平移;按住未选中的帧 =
   * 先单选再拖。位移 <3px 视为点击(走选中语义)。
   */
  const onKfPointerDown = useCallback(
    (k: CameraKeyframe) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const rail = railRef.current;
      if (!rail) return;
      const mods = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
      // 修饰键点击只做选中切换,不进入拖动。
      if (mods.ctrl || mods.shift) {
        selectKey(k, mods);
        return;
      }
      const railW = rail.getBoundingClientRect().width;
      const ids = selected.has(k.id) ? [...selected] : [k.id];
      if (!selected.has(k.id)) setSelected(new Set([k.id]));
      lastSelRef.current = k.id;
      const startX = e.clientX;
      let applied = 0;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const want = (dx / railW) * duration;
        const step = want - applied;
        if (step !== 0) {
          applied += stageRef.current?.recordMoveKeyframes(ids, step, duration) ?? 0;
          refresh();
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (!moved) selectKey(k, mods);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [duration, refresh, selectKey, selected, stageRef],
  );

  /** 切换点旗标拖动:横向拖 = 改切换时刻(机位不变);<3px 视为点击。 */
  const onCutPointerDown = useCallback(
    (cutT: number) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const rail = railRef.current;
      if (!rail) return;
      const railW = rail.getBoundingClientRect().width;
      const startX = e.clientX;
      let curT = cutT;
      let moved = false;
      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 3) return;
        moved = true;
        const newT = Math.max(0, Math.min(duration, cutT + (dx / railW) * duration));
        if (Math.abs(newT - curT) > 1e-3) {
          stageRef.current?.recordMoveCut(curT, newT);
          curT = newT;
          refresh();
        }
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [duration, refresh, stageRef],
  );

  const deleteSelected = useCallback(() => {
    if (selected.size === 0) return;
    stageRef.current?.recordRemoveKeyframes([...selected]);
    refresh();
  }, [refresh, selected, stageRef]);

  /** 把选中的关键帧位姿更新为当前机位(时间不变)。 */
  const updateSelected = useCallback(() => {
    if (selected.size === 0) return;
    for (const id of selected) stageRef.current?.recordUpdateKeyframe(id);
    refresh();
    flashClip(`已把 ${selected.size} 个关键帧更新为当前机位`);
  }, [flashClip, refresh, selected, stageRef]);

  const copySelected = useCallback(() => {
    const picked = keys.filter((k) => selected.has(k.id));
    if (picked.length === 0) return;
    clipboardRef.current = picked.map((k) => ({ ...k }));
    flashClip(`已复制 ${picked.length} 个关键帧(Ctrl+V 粘贴到游标)`);
  }, [flashClip, keys, selected]);

  const cutSelected = useCallback(() => {
    const picked = keys.filter((k) => selected.has(k.id));
    if (picked.length === 0) return;
    clipboardRef.current = picked.map((k) => ({ ...k }));
    stageRef.current?.recordRemoveKeyframes([...selected]);
    refresh();
    flashClip(`已剪切 ${picked.length} 个关键帧(Ctrl+V 粘贴到游标)`);
  }, [flashClip, keys, refresh, selected, stageRef]);

  const pasteAtPlayhead = useCallback(() => {
    const clip = clipboardRef.current;
    if (clip.length === 0) return;
    const all = stageRef.current?.recordLoadKeyframes(clip, 'append', playhead) ?? [];
    const lastT = all.length ? all[all.length - 1].t : 0;
    if (lastT > duration) setDuration(Math.min(DUR_MAX, Math.ceil(lastT)));
    refresh();
    flashClip(`已在 ${playhead.toFixed(1)}s 粘贴 ${clip.length} 个关键帧`);
  }, [duration, flashClip, playhead, refresh, stageRef]);

  const selectAll = useCallback(() => {
    setSelected(new Set(keys.map((k) => k.id)));
  }, [keys]);

  // ── 时间轴缩放(放大缩小):按钮 / Ctrl+滚轮,>1 时横向滚动 ──────
  const changeZoom = useCallback((next: number, anchorRatio?: number) => {
    const z = Math.max(1, Math.min(10, next));
    setZoom((prev) => {
      if (z === prev) return prev;
      // 以锚点(光标处的时间占比)为中心缩放,保持该时刻在视口位置不跳。
      const sc = railScrollRef.current;
      if (sc && anchorRatio != null) {
        const view = sc.clientWidth;
        const anchorPx = anchorRatio * view * prev + 0;
        requestAnimationFrame(() => {
          sc.scrollLeft = Math.max(0, (anchorPx / prev) * z - view / 2);
        });
      }
      return z;
    });
  }, []);

  useEffect(() => {
    const sc = railScrollRef.current;
    if (!sc) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = sc.getBoundingClientRect();
      const ratio = (e.clientX - rect.left + sc.scrollLeft) / (sc.clientWidth * zoom || 1);
      changeZoom(zoom * (e.deltaY < 0 ? 1.25 : 0.8), ratio);
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    return () => sc.removeEventListener('wheel', onWheel);
  }, [changeZoom, zoom]);

  // ── 选择性导出区间(入点/出点) ──────────────────────────────
  const exportRange: [number, number] | null =
    inPoint != null && outPoint != null && outPoint > inPoint ? [inPoint, outPoint] : null;

  // ── 快捷键:F 加帧 / Del 删除 / Ctrl+A 全选 / Ctrl+C·X·V / I·O 入出点 ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (key === 'f' && !e.repeat && !ctrl) addKeyframe();
      else if ((e.key === 'Delete' || e.key === 'Backspace') && !ctrl) deleteSelected();
      else if (ctrl && key === 'a') {
        e.preventDefault();
        selectAll();
      } else if (ctrl && key === 'c') copySelected();
      else if (ctrl && key === 'x') cutSelected();
      else if (ctrl && key === 'v') pasteAtPlayhead();
      else if (key === 'i' && !ctrl) setInPoint(playhead);
      else if (key === 'o' && !ctrl) setOutPoint(playhead);
      // Blender 式机位热键:1-9 = 进对应机位镜头轨;0/` = 回自由视角。
      else if (!ctrl && key >= '1' && key <= '9') {
        const slot = camSlots[Number(key) - 1];
        if (slot) activateTrack(slot.id);
      } else if (!ctrl && (key === '0' || key === '`')) activateTrack('free');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    activateTrack,
    addKeyframe,
    camSlots,
    copySelected,
    cutSelected,
    deleteSelected,
    pasteAtPlayhead,
    playhead,
    selectAll,
  ]);

  // ── 镜头库:预设 / 我的镜头 / 导入(json/glb/gltf/fbx)/ 导出 ──────
  const loadMyClips = useCallback(() => {
    listAssets('camera')
      .then(setMyClips)
      .catch(() => setMyClips([]));
  }, []);
  useEffect(() => {
    if (showClips) loadMyClips();
  }, [loadMyClips, showClips]);

  /** 把镜头关键帧装入时间轴(覆盖 / 拖入落点),必要时自动加长时间轴。
   *  anchor = 镜头起始位置约束:true 对齐当前相机;{slotId} 对齐某机位(镜头放入机位)。 */
  const loadKeys = useCallback(
    (
      ks: readonly CameraKeyframe[],
      mode: 'replace' | 'append',
      atSec?: number,
      anchor: boolean | { slotId: string } = false,
    ) => {
      const all = stageRef.current?.recordLoadKeyframes(ks, mode, atSec, anchor) ?? [];
      const lastT = all.length ? all[all.length - 1].t : 0;
      if (lastT > duration) setDuration(Math.min(DUR_MAX, Math.ceil(lastT)));
      refresh();
    },
    [duration, refresh, stageRef],
  );

  const applyPreset = useCallback(
    (id: CameraPresetId, atSec?: number, slotId?: string) => {
      const st = stageRef.current;
      if (!st) return;
      // 预设以当前位姿为基准生成;放入机位时再整体锚定到机位位姿。
      const ks = buildCameraPreset(id, st.getCameraPose());
      loadKeys(ks, atSec != null ? 'append' : 'replace', atSec, slotId ? { slotId } : false);
      flashClip(
        slotId
          ? `预设已放入「${slotNameMap.get(slotId) ?? '机位'}」(从机位位姿起播)`
          : atSec != null
            ? '预设已插入时间轴落点'
            : '预设已应用(覆盖原关键帧)',
      );
    },
    [flashClip, loadKeys, slotNameMap, stageRef],
  );

  const applyAssetClip = useCallback(
    async (id: string, atSec?: number, slotId?: string) => {
      try {
        const asset = await getAsset(id);
        if (!asset) return;
        const parsed = parseCameraClipJson(await asset.blob.text());
        const anchor = slotId ? { slotId } : anchorClips;
        loadKeys(parsed.keys, atSec != null ? 'append' : 'replace', atSec, anchor);
        flashClip(
          slotId
            ? `已把「${asset.name}」放入「${slotNameMap.get(slotId) ?? '机位'}」(${parsed.keys.length} 关键帧,从机位位姿起播)`
            : `已装入「${asset.name}」(${parsed.keys.length} 关键帧${anchorClips ? ',已锚定当前镜头起始位置' : ''})`,
        );
      } catch (err) {
        console.error('[director] load camera clip failed', err);
        flashClip('镜头装入失败');
      }
    },
    [anchorClips, flashClip, loadKeys, slotNameMap],
  );

  const importClipFile = useCallback(
    async (file: File) => {
      const ext = extOf(file.name);
      if (!isCameraExt(ext)) {
        flashClip('仅支持 json / glb / gltf / fbx / vmd 镜头文件');
        return;
      }
      const url = URL.createObjectURL(file);
      try {
        const r = await stageRef.current!.importCameraClip(url, ext);
        const clipName = file.name.replace(/\.[^.]+$/, '') || r.name;
        // 统一转存为通用 director-camera@1 JSON:网上找的 glb/fbx 镜头也
        // 标准化落库,二次装入不再依赖 loader。
        await putAsset({
          kind: 'camera',
          name: clipName,
          ext: 'json',
          blob: new Blob([cameraClipToJson(r.keys, clipName)], { type: 'application/json' }),
        });
        loadMyClips();
        loadKeys(r.keys, 'replace', undefined, anchorClips);
        flashClip(
          `已导入「${clipName}」(${r.keys.length} 关键帧${anchorClips ? ',已锚定当前镜头起始位置' : ''})`,
        );
      } catch (err) {
        console.error('[director] import camera clip failed', err);
        flashClip(err instanceof Error ? err.message : '镜头导入失败');
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [anchorClips, flashClip, loadKeys, loadMyClips, stageRef],
  );

  /** 通用下载(json 文本 / vmd·glb 二进制)。 */
  const downloadBlob = useCallback((blob: Blob, filename: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  const exportClip = useCallback(
    async (fmt: 'json' | 'vmd' | 'glb', source: 'track' | 'flat' = 'track') => {
      // flat = 按机位切换点拍扁的多机位成片(硬切相邻帧,MMD 相机标准做法)。
      const ks =
        source === 'flat' ? stageRef.current?.recordFlattenedKeyframes() ?? [] : keys;
      if (ks.length === 0) return;
      const stamp = new Date().toISOString().slice(0, 10);
      const base = source === 'flat' ? `camera-film-${stamp}` : `camera-clip-${stamp}`;
      try {
        if (fmt === 'json') {
          downloadBlob(
            new Blob([cameraClipToJson(ks, 'director-camera')], { type: 'application/json' }),
            `${base}.json`,
          );
        } else if (fmt === 'vmd') {
          downloadBlob(
            new Blob([cameraKeysToVmd(ks)], { type: 'application/octet-stream' }),
            `${base}.vmd`,
          );
        } else {
          downloadBlob(
            new Blob([await cameraKeysToGlb(ks)], { type: 'model/gltf-binary' }),
            `${base}.glb`,
          );
        }
        flashClip(source === 'flat' ? `已导出多机位成片镜头 .${fmt}` : `已导出 .${fmt}`);
      } catch (err) {
        console.error('[director] export camera clip failed', err);
        flashClip('镜头导出失败');
      }
    },
    [downloadBlob, flashClip, keys, stageRef],
  );

  const saveClipToLibrary = useCallback(async () => {
    if (keys.length === 0) return;
    const name = `镜头 ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
    await putAsset({
      kind: 'camera',
      name,
      ext: 'json',
      blob: new Blob([cameraClipToJson(keys, name)], { type: 'application/json' }),
    });
    loadMyClips();
    flashClip('当前运镜已存入我的镜头');
  }, [flashClip, keys, loadMyClips]);

  // 预览/导出只覆盖关键帧首→末区间,不含前后空白段;设了入出点则预览该区间
  // (与选择性导出所见一致)。有机位切换点 = 多机位成片:范围覆盖所有
  // 轨道末帧与最后切换点(extent),播放/导出按切换点依序跳机位。
  const hasCuts = cuts.length > 0;
  const tStart = keys.length ? keys[0].t : 0;
  const tEnd = keys.length ? keys[keys.length - 1].t : 0;
  const pStart = exportRange
    ? exportRange[0]
    : hasCuts
      ? Math.min(keys.length ? tStart : cuts[0].t, cuts[0].t)
      : tStart;
  const pEnd = exportRange ? exportRange[1] : hasCuts ? Math.max(tEnd, extent) : tEnd;

  const togglePlay = useCallback(() => {
    if (playing) {
      stopRef.current?.();
      setPlaying(false);
      return;
    }
    if (keys.length === 0 && !hasCuts) return;
    setPlaying(true);
    stopRef.current = stageRef.current!.recordPlay(
      pStart,
      pEnd,
      (t) => setPlayhead(t),
      () => setPlaying(false),
      loopPreview,
    );
  }, [hasCuts, keys.length, loopPreview, pEnd, pStart, playing, stageRef]);

  /** 切换循环预览;正在播时就地按新模式重启,不用先暂停。 */
  const toggleLoop = useCallback(() => {
    const next = !loopPreview;
    setLoopPreview(next);
    if (playing) {
      stopRef.current?.();
      stopRef.current = stageRef.current!.recordPlay(
        pStart,
        pEnd,
        (t) => setPlayhead(t),
        () => setPlaying(false),
        next,
      );
    }
  }, [loopPreview, pEnd, pStart, playing, stageRef]);

  const doExport = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || (keys.length < 1 && !hasCuts)) return;
    setShowExport(false);
    setExportPct(0);
    try {
      const r = await stage.recordExport({
        // real = 按关键帧/入出点区间 1:1 实时导出;custom = 用户自选时长,
        // 把该区间整体拉伸/压缩到指定秒数。
        durationSec: durMode === 'custom' ? Math.max(0.2, customDur) : 0,
        resolution: res,
        fps,
        quality,
        // 与机位共用的画幅比例;null = 全屏(跟随画布,不裁剪)。
        aspect: aspectRatioOf(aspect),
        // 选择性导出:入点/出点都设置且有效时只导出该区间。
        rangeSec: exportRange,
        onProgress: (p) => setExportPct(p),
      });
      onExported(r);
    } catch (err) {
      console.error('[director] export failed', err);
    } finally {
      setExportPct(null);
    }
  }, [aspect, customDur, durMode, exportRange, fps, hasCuts, keys.length, onExported, quality, res, stageRef]);

  const hasKeys = keys.length > 0;
  const canPlay = hasKeys || hasCuts;
  const clipSec = Math.max(0, tEnd - tStart);
  const aspectRatio = aspectRatioOf(aspect);
  // 安全框 contain 适配:横向最多 58%(沿用旧观感),纵向最多 92%,
  // 二者取先触到的边,比例严格成立(竖版 9:16 贴高、超宽 21:9 贴宽)。
  let frameW = 0;
  let frameH = 0;
  if (aspectRatio != null && frameBox.w > 0 && frameBox.h > 0) {
    const availW = frameBox.w * 0.58;
    const availH = frameBox.h * 0.92;
    if (availW / availH > aspectRatio) {
      frameH = availH;
      frameW = availH * aspectRatio;
    } else {
      frameW = availW;
      frameH = availW / aspectRatio;
    }
  }
  const tickStep = duration <= 12 ? 1 : duration <= 30 ? 2 : duration <= 120 ? 10 : 60;
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= duration; t += tickStep) out.push(t);
    return out;
  }, [duration, tickStep]);

  return (
    <div style={styles.overlay}>
      {/* 中央安全框(全屏 = 不遮幅,无框) */}
      <div ref={frameAreaRef} style={styles.frameArea}>
        {aspectRatio != null && frameW > 0 && (
          <div style={{ ...styles.safeFrame, width: frameW, height: frameH }} />
        )}
      </div>

      {/* 左上 Preview 面板(标题栏可拖动自由移动) */}
      <div
        style={{
          ...styles.preview,
          left: previewDrag.pos.x,
          top: previewDrag.pos.y,
          // 等比缩放:面板宽度跟随画布盒(240×scale)+ 左右边框余量。
          width: Math.round(240 * previewScale) + 16,
        }}
      >
        <div
          title="拖动移动面板"
          style={{ ...styles.previewHead, ...previewDrag.handleProps.style, userSelect: 'none' }}
          onPointerDown={previewDrag.handleProps.onPointerDown}
          onPointerMove={previewDrag.handleProps.onPointerMove}
          onPointerUp={previewDrag.handleProps.onPointerUp}
        >
          <span style={styles.previewTitle}>⠿ Preview</span>
          <button
            style={gridMode ? { ...styles.zoomBtn, color: '#4aa3ff' } : styles.zoomBtn}
            onClick={() => setGridMode((v) => !v)}
            title="全机位监视器(导播台):同时预览所有机位画面,点画面 = 进该机位轨"
          >
            ⊞
          </button>
          <button
            style={styles.zoomBtn}
            onClick={() => setPreviewScale((v) => Math.max(0.5, +(v - 0.25).toFixed(2)))}
            title="预览窗口等比缩小"
          >
            −
          </button>
          <span style={styles.zoomPct}>{Math.round(previewScale * 100)}%</span>
          <button
            style={styles.zoomBtn}
            onClick={() => setPreviewScale((v) => Math.min(2.5, +(v + 0.25).toFixed(2)))}
            title="预览窗口等比放大"
          >
            ＋
          </button>
          <AspectSelect value={aspect} onChange={setAspect} openUp={false} />
          <button style={styles.xBtn} onClick={onExit} title="关闭">
            ×
          </button>
        </div>
        {/* 多机位:自由视角(跟随运镜)+ 各机位。点击 = 切换机位展示(实时相机跳过去);
            机位可拖到时间尺(打机位关键帧);预设/镜头可拖到机位上(镜头放入机位)。 */}
        <div style={styles.camTabs}>
          <button
            style={previewCam === 'free' ? styles.camTabActive : styles.camTab}
            onClick={() => activateTrack('free')}
            title="自由视角(热键 0):全局镜头轨,跟随实时相机"
          >
            自由视角
          </button>
          {camSlots.map((s, i) => (
            <button
              key={s.id}
              style={previewCam === s.id ? styles.camTabActive : styles.camTab}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(CLIP_DND_MIME, JSON.stringify({ slotId: s.id }));
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(CLIP_DND_MIME)) e.preventDefault();
              }}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData(CLIP_DND_MIME);
                if (!raw) return;
                e.preventDefault();
                e.stopPropagation();
                try {
                  const p = JSON.parse(raw) as { preset?: CameraPresetId; assetId?: string };
                  if (!p.preset && !p.assetId) return;
                  // 镜头放入机位:先切到该机位的镜头轨,再从游标处插入,
                  // 整段锚定到机位位姿。
                  activateTrack(s.id);
                  if (p.preset) applyPreset(p.preset, playhead, s.id);
                  else if (p.assetId) void applyAssetClip(p.assetId, playhead, s.id);
                } catch {
                  // 非本组件 payload,忽略。
                }
              }}
              onClick={() => activateTrack(s.id)}
              title={`${s.name}(热键 ${i + 1}):点击 = 进入该机位的镜头轨(拖视角挪机位、F K 镜头);拖到时间尺 = 打机位关键帧;把预设/镜头拖到这里 = 镜头装入该机位轨`}
            >
              <span style={{ color: slotColorMap.get(s.id), marginRight: 4 }}>●</span>
              {s.name}
            </button>
          ))}
        </div>
        <div style={styles.previewBody}>
          {gridMode ? (
            <div style={styles.gridWrap}>
              {camSlots.map((s) => (
                <div
                  key={s.id}
                  style={{
                    ...styles.gridCell,
                    ...(previewCam === s.id
                      ? { outline: `2px solid ${slotColorMap.get(s.id) ?? '#4aa3ff'}` }
                      : null),
                  }}
                  onClick={() => activateTrack(s.id)}
                  title={`${s.name}:点击 = 进入该机位的镜头轨`}
                >
                  <canvas
                    style={styles.gridCanvas}
                    ref={(el) => {
                      if (el) gridRefs.current.set(s.id, el);
                      else gridRefs.current.delete(s.id);
                    }}
                  />
                  <span style={{ ...styles.gridLabel, color: slotColorMap.get(s.id) }}>
                    {s.name}
                  </span>
                </div>
              ))}
              {camSlots.length === 0 && (
                <div style={styles.previewEmpty}>
                  <div style={{ color: '#cbd2dd', fontSize: 13 }}>暂无机位</div>
                  <div style={{ color: '#6b7480', fontSize: 11, marginTop: 4 }}>
                    先在底部工具栏「机位」里添加机位
                  </div>
                </div>
              )}
            </div>
          ) : (
            <>
              <canvas ref={previewRef} style={styles.previewCanvas} />
              {!hasKeys && (
                <div style={styles.previewEmpty}>
                  <div style={{ color: '#cbd2dd', fontSize: 13 }}>
                    {previewCam === 'free' ? '暂无关键帧' : '该机位轨暂无镜头'}
                  </div>
                  <div style={{ color: '#6b7480', fontSize: 11, marginTop: 4 }}>
                    {previewCam === 'free'
                      ? '按 F 在当前位置添加关键帧'
                      : '拖动视角调机位,按 F 把镜头 K 到该轨'}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* 底部 Timeline */}
      <div style={styles.timeline}>
        <div style={styles.tlTop}>
          <span style={styles.tlName} title="当前镜头轨:每个机位有独立时间轴(热键 1-9 切机位,0 回自由)">
            {previewCam === 'free' ? (
              'Timeline · 自由'
            ) : (
              <>
                Timeline ·{' '}
                <span style={{ color: slotColorMap.get(previewCam) }}>
                  {slotNameMap.get(previewCam) ?? '机位'}
                </span>
              </>
            )}
          </span>
          <button style={styles.kfBtn} onClick={addKeyframe}>
            ◆ 在游标处添加关键帧 (F)
          </button>
          <button
            style={previewCam !== 'free' ? styles.tlBtn : styles.tlBtnDisabled}
            disabled={previewCam === 'free'}
            onClick={addCutAtPlayhead}
            title={
              previewCam === 'free'
                ? '先进入一个机位(点标签或按 1-9)再打切换点'
                : '在游标处切换到当前机位:播放/导出按切换点 1→2→3 依序跳机位(Blender Marker 绑定相机同款)'
            }
          >
            ⇄ 切换点
          </button>
          <button
            style={canPlay ? styles.tlBtn : styles.tlBtnDisabled}
            onClick={togglePlay}
            disabled={!canPlay}
            title={
              canPlay
                ? `预览${exportRange ? '入出点' : hasCuts ? '多机位成片' : '关键帧'}区间 ${pStart.toFixed(1)}s → ${pEnd.toFixed(1)}s${loopPreview ? '(循环)' : ''}`
                : undefined
            }
          >
            {playing ? '⏸ 暂停' : '▷ 预览'}
          </button>
          <button
            style={loopPreview ? styles.loopOn : styles.tlBtn}
            onClick={toggleLoop}
            title="循环预览(K 动画同款):开 = 播完自动从头继续;关 = 播完即停"
          >
            🔁 循环
          </button>
          <label style={styles.durLabel}>
            时长
            <input
              style={styles.durInput}
              type="number"
              min={DUR_MIN}
              max={DUR_MAX}
              value={duration}
              onChange={(e) => changeDuration(Number(e.target.value))}
            />
            s
          </label>
          {hasKeys && <span style={styles.clipHint}>片段 {clipSec.toFixed(1)}s</span>}
          <span style={{ flex: 1 }} />
          <div style={{ position: 'relative' }}>
            <button
              style={showClips ? styles.loopOn : styles.tlBtn}
              onClick={() => setShowClips((v) => !v)}
              title="镜头库:预设 / 我的镜头 / 导入导出(通用格式)"
            >
              🎥 镜头
            </button>
            {showClips && (
              <div style={styles.clipMenu}>
                <div style={styles.clipHead}>镜头预设(点击应用 / 拖到时间尺插入)</div>
                <div style={styles.clipGrid}>
                  {CAMERA_PRESETS.map((p) => (
                    <div
                      key={p.id}
                      style={styles.clipItem}
                      draggable
                      title={`${p.desc};点击 = 覆盖时间轴,拖到时间尺 = 插入落点`}
                      onDragStart={(e) =>
                        e.dataTransfer.setData(CLIP_DND_MIME, JSON.stringify({ preset: p.id }))
                      }
                      onClick={() => applyPreset(p.id)}
                    >
                      <span style={styles.clipName}>{p.name}</span>
                      <span style={styles.clipSub}>{p.durationSec}s</span>
                    </div>
                  ))}
                </div>
                <div style={styles.clipHead}>我的镜头</div>
                {myClips.length === 0 ? (
                  <div style={styles.clipEmpty}>暂无 — 导入镜头文件,或把当前运镜存入</div>
                ) : (
                  <div style={styles.clipList}>
                    {myClips.map((c) => (
                      <div
                        key={c.id}
                        style={styles.clipItem}
                        draggable
                        title="点击 = 覆盖时间轴,拖到时间尺 = 插入落点"
                        onDragStart={(e) =>
                          e.dataTransfer.setData(CLIP_DND_MIME, JSON.stringify({ assetId: c.id }))
                        }
                        onClick={() => void applyAssetClip(c.id)}
                      >
                        <span style={styles.clipName}>{c.name}</span>
                        <button
                          style={styles.clipDel}
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            void deleteAsset(c.id).then(loadMyClips);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <label
                  style={styles.anchorRow}
                  title="开:装入的镜头文件首帧对齐到当前相机位姿(先把机位/自由视角摆到想要的起点),后续帧保持相对运动 —— 网上下载的镜头不再飞到文件里的绝对坐标。关:按文件原始世界坐标装入。"
                >
                  <input
                    type="checkbox"
                    checked={anchorClips}
                    onChange={(e) => setAnchorClips(e.target.checked)}
                  />
                  ⚓ 装入时锚定到当前镜头起始位置
                </label>
                <div style={styles.clipBtns}>
                  <button style={styles.tlBtn} onClick={() => fileRef.current?.click()}>
                    ⤒ 导入镜头文件
                  </button>
                  <button
                    style={hasKeys ? styles.tlBtn : styles.tlBtnDisabled}
                    disabled={!hasKeys}
                    onClick={() => void saveClipToLibrary()}
                  >
                    ☆ 存入我的镜头
                  </button>
                  <button
                    style={hasKeys ? styles.tlBtn : styles.tlBtnDisabled}
                    disabled={!hasKeys}
                    onClick={() => void exportClip('json')}
                  >
                    ⤓ .json
                  </button>
                  <button
                    style={hasKeys ? styles.tlBtn : styles.tlBtnDisabled}
                    disabled={!hasKeys}
                    title="MMD / 恋活(Koikatsu)相机文件,可在 MMD 系工具直接使用"
                    onClick={() => void exportClip('vmd')}
                  >
                    ⤓ .vmd
                  </button>
                  <button
                    style={hasKeys ? styles.tlBtn : styles.tlBtnDisabled}
                    disabled={!hasKeys}
                    title="glTF 2.0 相机动画,Blender / Unity / three.js 可导入"
                    onClick={() => void exportClip('glb')}
                  >
                    ⤓ .glb
                  </button>
                </div>
                {hasCuts && (
                  <div style={styles.clipBtns}>
                    <span style={{ color: '#8b94a2', fontSize: 11, alignSelf: 'center' }}>
                      成片(按切换点 1→2→3 拍扁,切点硬切)
                    </span>
                    <button
                      style={styles.tlBtn}
                      title="多机位成片导出为 director-camera JSON"
                      onClick={() => void exportClip('json', 'flat')}
                    >
                      ⤓ .json
                    </button>
                    <button
                      style={styles.tlBtn}
                      title="多机位成片导出为 MMD 相机 .vmd(切点 = 相邻帧硬切)"
                      onClick={() => void exportClip('vmd', 'flat')}
                    >
                      ⤓ .vmd
                    </button>
                    <button
                      style={styles.tlBtn}
                      title="多机位成片导出为 glTF 2.0 相机动画"
                      onClick={() => void exportClip('glb', 'flat')}
                    >
                      ⤓ .glb
                    </button>
                  </div>
                )}
                <div style={styles.clipNote}>
                  导入:director-camera JSON / 裸 AnimationClip JSON / glb / gltf / fbx /
                  <b> MMD 相机 .vmd</b>(BowlRoll、恋活社区流通的运镜文件直接用);Blender
                  「导出 glTF 2.0 + 勾选 Cameras」的相机动画同样可导入
                </div>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.glb,.gltf,.fbx,.vmd"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importClipFile(f);
              e.target.value = '';
            }}
          />
          <button style={styles.tlBtnDisabled} disabled title="增强(暂未启用)">
            ✦ 增强
          </button>
          <div style={{ position: 'relative' }}>
            <button
              style={hasKeys ? styles.exportBtn : styles.tlBtnDisabled}
              onClick={() => setShowExport((v) => !v)}
              disabled={!hasKeys}
            >
              ⤓ 导出
            </button>
            {showExport && (
              <div style={styles.exportMenu}>
                <div style={styles.exportRow}>
                  <span style={styles.exportLabel}>分辨率</span>
                  <div style={styles.segRow}>
                    {CAPTURE_RESOLUTIONS.map((r) => (
                      <button
                        key={r}
                        style={r === res ? styles.segActive : styles.seg}
                        onClick={() => setRes(r)}
                      >
                        {RES_LABEL[r]}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={styles.exportRow}>
                  <span style={styles.exportLabel}>帧率</span>
                  <div style={styles.segRow}>
                    {RECORD_FPS.map((f) => (
                      <button
                        key={f}
                        style={f === fps ? styles.segActive : styles.seg}
                        onClick={() => setFps(f)}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={styles.exportRow}>
                  <span style={styles.exportLabel}>画质</span>
                  <div style={styles.segRow}>
                    {RECORD_QUALITY.map((q) => (
                      <button
                        key={q.key}
                        style={q.key === quality ? styles.segActive : styles.seg}
                        onClick={() => setQuality(q.key)}
                      >
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={styles.exportRow}>
                  <span style={styles.exportLabel}>时长</span>
                  <div style={styles.segRow}>
                    <button
                      style={durMode === 'real' ? styles.segActive : styles.seg}
                      title="按时间轴 1:1 导出(关键帧/入出点区间实际时长)"
                      onClick={() => setDurMode('real')}
                    >
                      1:1
                    </button>
                    <button
                      style={durMode === 'custom' ? styles.segActive : styles.seg}
                      title="自定义导出时长:把运镜区间整体拉伸/压缩到指定秒数"
                      onClick={() => setDurMode('custom')}
                    >
                      自定义
                    </button>
                    {durMode === 'custom' && (
                      <input
                        style={{ ...styles.durInput, width: 44 }}
                        type="number"
                        min={0.2}
                        max={DUR_MAX}
                        step={0.5}
                        value={customDur}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setCustomDur(Math.max(0.2, Math.min(DUR_MAX, v)));
                        }}
                      />
                    )}
                  </div>
                </div>
                <div style={{ color: '#8b94a2', fontSize: 11 }}>
                  {exportRange
                    ? `导出区间 ${exportRange[0].toFixed(1)}s → ${exportRange[1].toFixed(1)}s`
                    : `导出区间 = 关键帧全程 ${clipSec.toFixed(1)}s`}
                  {durMode === 'custom' ? `,拉伸到 ${customDur}s` : '(1:1)'}
                </div>
                <button style={styles.exportGo} onClick={doExport}>
                  开始导出
                </button>
              </div>
            )}
          </div>
          <button style={styles.exitBtn} onClick={onExit}>
            × 退出录制
          </button>
        </div>

        {/* 编辑工具栏:选中关键帧的更新/删除/剪切复制粘贴 + 入出点 + 缩放 */}
        <div style={styles.editBar}>
          <span style={styles.editInfo}>
            {selected.size > 0
              ? `已选 ${selected.size} 帧(拖动 = 整组移动)`
              : '点击关键帧选中;Ctrl 多选,Shift 连选;1-9 进机位轨,0 回自由'}
          </span>
          <button
            style={selected.size ? styles.editBtn : styles.editBtnDisabled}
            disabled={!selected.size}
            title="把选中关键帧的相机位姿更新为当前机位(时间不变)"
            onClick={updateSelected}
          >
            ⟳ 更新为当前机位
          </button>
          <button
            style={selected.size ? styles.editBtn : styles.editBtnDisabled}
            disabled={!selected.size}
            title="删除选中关键帧(Delete)"
            onClick={deleteSelected}
          >
            🗑 删除
          </button>
          <button
            style={selected.size ? styles.editBtn : styles.editBtnDisabled}
            disabled={!selected.size}
            title="剪切选中关键帧(Ctrl+X),之后 Ctrl+V 粘贴到游标"
            onClick={cutSelected}
          >
            ✂ 剪切
          </button>
          <button
            style={selected.size ? styles.editBtn : styles.editBtnDisabled}
            disabled={!selected.size}
            title="复制选中关键帧(Ctrl+C)"
            onClick={copySelected}
          >
            ⧉ 复制
          </button>
          <button
            style={styles.editBtn}
            title="把剪切板的关键帧粘贴到游标位置(Ctrl+V)"
            onClick={pasteAtPlayhead}
          >
            ⎀ 粘贴
          </button>
          <span style={styles.editSep} />
          <button
            style={styles.editBtn}
            title="在游标处设入点(I)—— 与出点组成选择性导出区间"
            onClick={() => setInPoint(playhead)}
          >
            ⇥ 入点{inPoint != null ? ` ${inPoint.toFixed(1)}s` : ''}
          </button>
          <button
            style={styles.editBtn}
            title="在游标处设出点(O)"
            onClick={() => setOutPoint(playhead)}
          >
            ⇤ 出点{outPoint != null ? ` ${outPoint.toFixed(1)}s` : ''}
          </button>
          {(inPoint != null || outPoint != null) && (
            <button
              style={styles.editBtn}
              title="清除入出点,恢复导出关键帧全程"
              onClick={() => {
                setInPoint(null);
                setOutPoint(null);
              }}
            >
              × 清除区间
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button style={styles.editBtn} title="缩小时间轴" onClick={() => changeZoom(zoom / 1.25)}>
            🔍−
          </button>
          <span style={styles.zoomLabel}>{Math.round(zoom * 100)}%</span>
          <button
            style={styles.editBtn}
            title="放大时间轴(也可 Ctrl+滚轮)"
            onClick={() => changeZoom(zoom * 1.25)}
          >
            🔍+
          </button>
        </div>

        {/* 时间尺(可缩放横向滚动)+ 关键帧区间高亮 + 入出点区间 + 关键帧 + 游标 */}
        <div ref={railScrollRef} style={styles.railScroll}>
          <div
            style={{ ...styles.rail, width: `${zoom * 100}%` }}
            ref={railRef}
            onMouseDown={(e) => {
              // 点击空白 = 移动游标并清空选中(关键帧自己 stopPropagation)。
              if (selected.size) setSelected(new Set());
              onRailClick(e);
            }}
            onDragOver={onRailDragOver}
            onDrop={onRailDrop}
          >
            {hasKeys && clipSec > 0 && (
              <span
                style={{
                  ...styles.clipSpan,
                  left: `${(tStart / duration) * 100}%`,
                  width: `${(clipSec / duration) * 100}%`,
                }}
              />
            )}
            {exportRange && (
              <span
                style={{
                  ...styles.rangeSpan,
                  left: `${(exportRange[0] / duration) * 100}%`,
                  width: `${((exportRange[1] - exportRange[0]) / duration) * 100}%`,
                }}
                title={`选择性导出区间 ${exportRange[0].toFixed(1)}s → ${exportRange[1].toFixed(1)}s`}
              />
            )}
            {inPoint != null && (
              <span style={{ ...styles.rangeMark, left: `${(inPoint / duration) * 100}%` }} />
            )}
            {outPoint != null && (
              <span style={{ ...styles.rangeMark, left: `${(outPoint / duration) * 100}%` }} />
            )}
            {ticks.map((t) => (
              <span key={t} style={{ ...styles.tick, left: `${(t / duration) * 100}%` }}>
                {t}s
              </span>
            ))}
            {/* 机位轨道:连续同机位关键帧合并成色带,展示各机位占据的时间段。 */}
            {slotSegs.map((seg, i) => (
              <span
                key={`${seg.slotId}-${i}`}
                style={{
                  ...styles.slotSeg,
                  left: `${(seg.from / duration) * 100}%`,
                  width: `${(Math.max(seg.to - seg.from, 0) / duration) * 100}%`,
                  background: slotColorMap.get(seg.slotId) ?? '#8b94a2',
                }}
                title={`机位轨道:${slotNameMap.get(seg.slotId) ?? '已删除机位'} ${seg.from.toFixed(1)}s → ${seg.to.toFixed(1)}s`}
              />
            ))}
            {/* 机位切换点旗标:编号 = 成片里的镜头顺序(1→2→3);双击删除。 */}
            {cuts.map((c, i) => (
              <span
                key={`cut-${c.slotId}-${i}`}
                style={{
                  ...styles.cutFlag,
                  left: `${(c.t / duration) * 100}%`,
                  background: slotColorMap.get(c.slotId) ?? '#8b94a2',
                }}
                title={`切换点 ${i + 1}:${c.t.toFixed(1)}s 起用「${slotNameMap.get(c.slotId) ?? '已删除机位'}」— 拖动改时刻,双击删除`}
                onMouseDown={(e) => e.stopPropagation()}
                onPointerDown={onCutPointerDown(c.t)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  stageRef.current?.recordRemoveCut(c.t);
                  refresh();
                }}
              >
                {i + 1}
              </span>
            ))}
            {keys.map((k) => (
              <span
                key={k.id}
                style={{
                  ...(selected.has(k.id) ? styles.kfSelected : styles.kf),
                  left: `${(k.t / duration) * 100}%`,
                  ...(k.slotId && !selected.has(k.id)
                    ? { color: slotColorMap.get(k.slotId) ?? '#e6c84a' }
                    : null),
                }}
                title={`关键帧 @ ${k.t.toFixed(1)}s${k.slotId ? `(${slotNameMap.get(k.slotId) ?? '机位'})` : ''} — 点击选中,拖动移动,双击删除`}
                onPointerDown={onKfPointerDown(k)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  stageRef.current?.recordRemoveKeyframe(k.id);
                  refresh();
                }}
              >
                ◆
              </span>
            ))}
            <span style={{ ...styles.playhead, left: `${(playhead / duration) * 100}%` }}>
              <span style={styles.playheadLabel}>{playhead.toFixed(1)}s</span>
            </span>
          </div>
        </div>
      </div>

      {clipMsg && <div style={styles.clipToast}>{clipMsg}</div>}

      {exportPct !== null && (
        <div style={styles.exportOverlay}>
          <div style={styles.exportCard}>
            <div style={{ color: '#e5e9f0', fontSize: 14, marginBottom: 10 }}>
              正在导出运镜视频… {exportPct}%
            </div>
            <div style={styles.progressTrack}>
              <div style={{ ...styles.progressFill, width: `${exportPct}%` }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // zIndex 10:高于左右面板(5/6),低于底栏弹出面板(19/20/30)与快捷键
  // 弹层(40)—— 录制时打开「假人/镜头/机位」等 popup 不再被时间轴盖住。
  overlay: { position: 'absolute', inset: 0, zIndex: 10, pointerEvents: 'none' },
  frameArea: {
    position: 'absolute',
    inset: '56px 0 130px 0',
    display: 'grid',
    placeItems: 'center',
  },
  // 宽高由组件按比例实测计算(contain 适配),这里只留外观。
  safeFrame: {
    border: '1.5px solid #d9c64a',
    borderRadius: 2,
    boxShadow: '0 0 0 9999px rgba(8,9,12,0.28)',
  },
  preview: {
    position: 'absolute',
    left: 14,
    top: 60,
    width: 256,
    background: '#16181e',
    border: '1px solid #2c313b',
    borderRadius: 8,
    // 不能 overflow:hidden:画幅比例下拉(AspectSelect)从标题栏向下弹出,
    // 会被面板裁掉后半截(截图 bug)。圆角裁剪改由 previewBody 自己负责。
    overflow: 'visible',
    pointerEvents: 'auto',
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
  },
  previewHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 8px',
    borderBottom: '1px solid #2c313b',
  },
  previewTitle: { color: '#cbd2dd', fontSize: 12, flex: 1 },
  xBtn: { background: 'none', border: 'none', color: '#8b94a2', cursor: 'pointer', fontSize: 14 },
  // 预览等比缩放(−/＋,50%–250%)
  zoomBtn: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#aab2bf',
    borderRadius: 4,
    width: 20,
    height: 18,
    lineHeight: '14px',
    padding: 0,
    cursor: 'pointer',
    fontSize: 12,
    flexShrink: 0,
  },
  zoomPct: { color: '#8b94a2', fontSize: 10, minWidth: 30, textAlign: 'center', flexShrink: 0 },
  // 多机位标签行(自由视角 + 各机位)
  camTabs: {
    display: 'flex',
    gap: 4,
    padding: '4px 6px',
    overflowX: 'auto',
    borderBottom: '1px solid #2c313b',
  },
  camTab: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#aab2bf',
    borderRadius: 6,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  camTabActive: {
    background: '#2d3340',
    border: '1px solid #4a505a',
    color: '#fff',
    borderRadius: 6,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  previewBody: {
    position: 'relative',
    lineHeight: 0,
    background: '#0c0e12',
    // 面板 overflow 已放开(给下拉让路),底部圆角在这里裁。
    overflow: 'hidden',
    borderRadius: '0 0 8px 8px',
  },
  // 不再强拉 width:100%:竖版比例(9:16 等)按画布自身宽高居中显示,
  // 两侧自然留黑边,避免被拉宽变形。
  previewCanvas: {
    display: 'block',
    margin: '0 auto',
    maxWidth: '100%',
    height: 'auto',
    background: '#0c0e12',
  },
  previewEmpty: {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0c0e12cc',
  },
  timeline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    background: '#16181eF7',
    borderTop: '1px solid #2c313b',
    padding: '8px 14px 14px',
    pointerEvents: 'auto',
  },
  tlTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  tlName: { color: '#cbd2dd', fontSize: 12, fontWeight: 600 },
  kfBtn: {
    background: '#2d3340',
    border: '1px solid #3b4250',
    color: '#e5e9f0',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  tlBtn: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  loopOn: {
    background: '#274264',
    border: '1px solid #2f5fb0',
    color: '#9ec3f5',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  tlBtnDisabled: {
    background: '#1c1f26',
    border: '1px solid #2a2f38',
    color: '#5a626d',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'not-allowed',
    fontSize: 12,
  },
  exportBtn: {
    background: '#2f5fb0',
    border: 'none',
    color: '#fff',
    borderRadius: 6,
    padding: '5px 12px',
    cursor: 'pointer',
    fontSize: 12,
  },
  exportMenu: {
    position: 'absolute',
    right: 0,
    bottom: 36,
    width: 230,
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 8,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    boxShadow: '0 8px 28px rgba(0,0,0,0.6)',
  },
  exportRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  exportLabel: { color: '#8b94a2', fontSize: 11 },
  segRow: { display: 'flex', gap: 4 },
  seg: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#aab2bf',
    borderRadius: 5,
    padding: '2px 7px',
    cursor: 'pointer',
    fontSize: 11,
  },
  segActive: {
    background: '#2f5fb0',
    border: '1px solid #2f5fb0',
    color: '#fff',
    borderRadius: 5,
    padding: '2px 7px',
    cursor: 'pointer',
    fontSize: 11,
  },
  exportGo: {
    background: '#2f5fb0',
    border: 'none',
    color: '#fff',
    borderRadius: 6,
    padding: '7px 0',
    cursor: 'pointer',
    fontSize: 12,
    marginTop: 2,
  },
  exitBtn: {
    background: 'none',
    border: '1px solid #3b4250',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  durLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    color: '#8b94a2',
    fontSize: 11,
  },
  durInput: {
    width: 52,
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#e5e9f0',
    borderRadius: 5,
    fontSize: 11,
    padding: '2px 5px',
  },
  clipHint: { color: '#d9c64a', fontSize: 11 },
  // ── 镜头库弹层 ──────────────────────────────────────────────
  clipMenu: {
    position: 'absolute',
    right: 0,
    bottom: 36,
    width: 320,
    maxHeight: 420,
    overflowY: 'auto',
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 8,
    padding: 10,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    boxShadow: '0 8px 28px rgba(0,0,0,0.6)',
  },
  clipHead: { color: '#8b94a2', fontSize: 11, fontWeight: 600 },
  clipGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 6,
  },
  clipList: { display: 'flex', flexDirection: 'column', gap: 4 },
  clipItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    background: '#23262e',
    border: '1px solid #333a46',
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'grab',
    userSelect: 'none',
  },
  clipName: {
    color: '#cbd2dd',
    fontSize: 12,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  clipSub: { color: '#6b7480', fontSize: 10 },
  clipDel: {
    background: 'none',
    border: 'none',
    color: '#8b94a2',
    cursor: 'pointer',
    fontSize: 13,
    lineHeight: 1,
    padding: '0 2px',
  },
  clipEmpty: { color: '#6b7480', fontSize: 11, padding: '2px 0' },
  clipBtns: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  anchorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    color: '#cbd2dd',
    fontSize: 11,
    cursor: 'pointer',
    userSelect: 'none',
  },
  clipNote: { color: '#5a626d', fontSize: 10, lineHeight: 1.5 },
  clipToast: {
    position: 'absolute',
    left: '50%',
    bottom: 150,
    transform: 'translateX(-50%)',
    background: '#1a1c22F0',
    border: '1px solid #333a46',
    borderRadius: 8,
    color: '#cbd2dd',
    fontSize: 12,
    padding: '8px 14px',
    pointerEvents: 'none',
    boxShadow: '0 8px 28px rgba(0,0,0,0.5)',
  },
  editBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
    flexWrap: 'wrap',
  },
  editInfo: { color: '#6b7480', fontSize: 10, marginRight: 4 },
  editBtn: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 5,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
  },
  editBtnDisabled: {
    background: '#1c1f26',
    border: '1px solid #2a2f38',
    color: '#5a626d',
    borderRadius: 5,
    padding: '3px 8px',
    cursor: 'not-allowed',
    fontSize: 11,
  },
  editSep: { width: 1, height: 16, background: '#2c313b' },
  zoomLabel: { color: '#8b94a2', fontSize: 10, minWidth: 34, textAlign: 'center' },
  railScroll: { overflowX: 'auto', overflowY: 'hidden' },
  rail: {
    position: 'relative',
    height: 34,
    minWidth: '100%',
    background: '#0f1116',
    border: '1px solid #262b34',
    borderRadius: 6,
    cursor: 'pointer',
  },
  clipSpan: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    background: 'rgba(217,198,74,0.10)',
    borderLeft: '1px solid rgba(217,198,74,0.4)',
    borderRight: '1px solid rgba(217,198,74,0.4)',
    pointerEvents: 'none',
  },
  tick: {
    position: 'absolute',
    top: 0,
    transform: 'translateX(-50%)',
    color: '#5a626d',
    fontSize: 9,
    paddingTop: 2,
    borderLeft: '1px solid #2a2f38',
    height: '100%',
  },
  // 机位轨道色带(时间尺顶部一条,颜色 = 机位配色)
  slotSeg: {
    position: 'absolute',
    top: 1,
    height: 5,
    minWidth: 6,
    borderRadius: 3,
    opacity: 0.85,
    pointerEvents: 'auto',
  },
  // 多机位监视器(导播台):2 列网格,每格一个机位画面
  gridWrap: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 3,
    padding: 3,
    justifyContent: 'center',
  },
  gridCell: {
    position: 'relative',
    cursor: 'pointer',
    lineHeight: 0,
    borderRadius: 3,
  },
  gridCanvas: {
    display: 'block',
    borderRadius: 3,
    background: '#0b0d12',
  },
  gridLabel: {
    position: 'absolute',
    left: 4,
    bottom: 3,
    fontSize: 9,
    fontWeight: 600,
    lineHeight: 1,
    textShadow: '0 0 3px #000',
    pointerEvents: 'none',
  },
  // 机位切换点旗标(Blender Marker 同款):编号 = 成片镜头顺序,双击删除
  cutFlag: {
    position: 'absolute',
    top: 0,
    transform: 'translateX(-50%)',
    minWidth: 14,
    height: 13,
    lineHeight: '13px',
    padding: '0 3px',
    borderRadius: '0 0 4px 4px',
    color: '#0b0d12',
    fontSize: 10,
    fontWeight: 700,
    textAlign: 'center',
    cursor: 'grab',
    zIndex: 4,
    userSelect: 'none',
    touchAction: 'none',
  },
  kf: {
    position: 'absolute',
    bottom: 2,
    transform: 'translateX(-50%)',
    color: '#e6c84a',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1,
    touchAction: 'none',
  },
  kfSelected: {
    position: 'absolute',
    bottom: 2,
    transform: 'translateX(-50%)',
    color: '#4aa3ff',
    fontSize: 15,
    cursor: 'grab',
    lineHeight: 1,
    touchAction: 'none',
    textShadow: '0 0 6px rgba(74,163,255,0.8)',
  },
  rangeSpan: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    background: 'rgba(74,163,255,0.12)',
    borderLeft: '1px solid rgba(74,163,255,0.6)',
    borderRight: '1px solid rgba(74,163,255,0.6)',
    pointerEvents: 'none',
  },
  rangeMark: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    background: 'rgba(74,163,255,0.55)',
    transform: 'translateX(-1px)',
    pointerEvents: 'none',
  },
  playhead: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    background: '#4aa3ff',
    transform: 'translateX(-1px)',
    pointerEvents: 'none',
  },
  playheadLabel: {
    position: 'absolute',
    top: -2,
    left: 4,
    color: '#4aa3ff',
    fontSize: 9,
    whiteSpace: 'nowrap',
    background: '#0f1116',
    padding: '0 3px',
  },
  exportOverlay: {
    position: 'absolute',
    inset: 0,
    display: 'grid',
    placeItems: 'center',
    background: 'rgba(8,9,12,0.6)',
    pointerEvents: 'auto',
  },
  exportCard: {
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 10,
    padding: 24,
    width: 320,
  },
  progressTrack: { height: 8, background: '#23262e', borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: '100%', background: '#2f5fb0', transition: 'width 0.2s' },
};
