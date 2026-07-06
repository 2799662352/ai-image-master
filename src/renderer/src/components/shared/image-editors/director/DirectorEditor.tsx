import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DirectorStageScene, {
  LIGHTFX_DEFAULTS,
  type AnimTick,
  type BoneInfo,
  type DirectorLightFxState,
  type DirectorSceneData,
  type DirectorStageHandle,
  type RecordResult,
  type SceneObjectInfo,
  type SelectionInfo,
} from './DirectorStageScene';
import DirectorCameraPanel, { DirectorFullscreenCam } from './DirectorCameraPanel';
import LightFxPanel from '../postfx/LightFxPanel';
import { usePersistentState } from '../usePersistentState';
import {
  DEFAULT_KEYMAP,
  SHORTCUT_DEFS,
  eventToToken,
  normalizeKeymap,
  tokenLabel,
  type Keymap,
  type ShortcutAction,
} from './directorShortcuts';
import DirectorRecordTimeline from './DirectorRecordTimeline';
import { getCatalog, type DirectorModel } from './directorCatalog';
import {
  type DirectorAsset,
  MODEL_EXTS,
  MODEL_SIZE_HINT,
  PANORAMA_EXTS,
  deleteAsset,
  extOf,
  formatBytes,
  isModelExt,
  isPanoramaExt,
  listAssets,
  makeImageThumb,
  openAssetUrl,
  putAsset,
} from './directorAssetStore';
import { CROWD_DEFAULTS, type CrowdLayout } from './directorMannequin';
import {
  ADVANCED_MANNEQUIN,
  CAPTURE_RESOLUTIONS,
  CAPTURE_RES_HEIGHT,
  DISTANCE_RANGE,
  DISTANCE_STEP,
  ENTRY_DEFAULTS,
  FOV_RANGE,
  FOV_STEP,
  LENS_FOCAL,
  LENS_PRESETS,
  LENS_PRESET_KEYS,
  LIGHT_DEFAULTS,
  TRANSFORM_RANGE,
  rigUrl,
  type CaptureResolution,
  type DirectorEntry,
  type LensPresetKey,
  type MannequinColor,
  type TransformMode,
} from './directorConstants';
import { BONES_BY_GROUP, POSE_KEYS, getPose } from './directorPoses';
import {
  animUrl,
  filterAnimations,
  loadAnimCatalog,
  type AnimCatalog,
  type DirectorAnimation,
} from './directorAnimations';

export interface DirectorCaptureShot {
  dataUrl: string;
  view: string;
}

interface Props {
  /** 'native' = 空网格;'panorama' = 用 imageUrl 作全景背景. */
  entry?: DirectorEntry;
  /** 全景入口的背景图(从画布「导入导演台」传入). */
  imageUrl?: string;
  theme?: 'punk' | 'default';
  /** 截图回调;不传则默认下载 PNG. */
  onCapture?: (shots: DirectorCaptureShot[]) => void;
  onClose: () => void;
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function DirectorEditor({
  entry = 'native',
  imageUrl,
  theme = 'default',
  onCapture,
  onClose,
}: Props) {
  const stageRef = useRef<DirectorStageHandle>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  /** 隐藏的 <input type=file> 用于「打开工程」选择 .json. */
  const projectInputRef = useRef<HTMLInputElement>(null);
  const [size, setSize] = useState({ w: 960, h: 600 });
  /** 导演台主页面全屏(整面板进入浏览器/系统全屏). */
  const [mainFull, setMainFull] = useState(false);
  /** 全景图导入 popover. */
  const [showPano, setShowPano] = useState(false);

  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [mode, setMode] = useState<TransformMode>('translate');
  /** 框选工具开关 + 撤销/重做可用状态(由 3D 场景回传同步). */
  const [boxSelect, setBoxSelect] = useState(false);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const handleHistoryChange = useCallback((canUndo: boolean, canRedo: boolean) => {
    setHistory({ canUndo, canRedo });
  }, []);
  const [lens, setLens] = useState<LensPresetKey>(
    entry === 'panorama' ? '广角' : '标准',
  );
  const [fov, setFov] = useState<number>(ENTRY_DEFAULTS[entry].fov);
  const [distance, setDistance] = useState<number>(ENTRY_DEFAULTS[entry].distance);
  const [keyLight, setKeyLight] = useState<{
    intensity: number
    az: number
    el: number
    color: string
  }>({
    intensity: LIGHT_DEFAULTS.key.intensity,
    az: LIGHT_DEFAULTS.key.azimuthDeg,
    el: LIGHT_DEFAULTS.key.elevationDeg,
    color: LIGHT_DEFAULTS.key.color,
  });
  const [ambient, setAmbient] = useState<{ intensity: number; color: string }>({
    intensity: LIGHT_DEFAULTS.ambient.intensity,
    color: LIGHT_DEFAULTS.ambient.color,
  });
  // 光感/调色后处理(复用全景 createLightFx)。默认中性 = 不改变现状。
  const [fx, setFx] = useState<DirectorLightFxState>({ ...LIGHTFX_DEFAULTS });
  const patchFx = useCallback((p: Partial<DirectorLightFxState>) => {
    setFx((s) => ({ ...s, ...p }));
    stageRef.current?.setLightFx(p);
  }, []);
  const [gridVisible, setGridVisible] = useState(entry === 'native');
  const [showLights, setShowLights] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [showLensMenu, setShowLensMenu] = useState(false);
  const [tab, setTab] = useState<'props' | 'pose' | 'anim'>('props');

  // ── 骨骼摆姿 ──
  const [bones, setBones] = useState<BoneInfo[]>([]);
  const [activeBone, setActiveBone] = useState<string | null>(null);
  const [skeletonOn, setSkeletonOn] = useState(false);
  /** identity of the last *distinct* selection, so per-drag readbacks don't reset posing */
  const prevSelUuid = useRef<string | null>(null);

  // ── 对象与机位 / 截图分辨率 / 快捷键 ──
  const [objects, setObjects] = useState<SceneObjectInfo[]>([]);
  const [objPanelOpen, setObjPanelOpen] = useState(true);
  const [resolution, setResolution] = useState<CaptureResolution>('1080p');
  const [showRes, setShowRes] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  // ── 可重映射快捷键(持久化;由用户在面板里改键)──
  const [storedKeymap, setStoredKeymap] = usePersistentState<Keymap>(
    'director.keymap',
    DEFAULT_KEYMAP,
  );
  const keymap = useMemo(() => normalizeKeymap(storedKeymap), [storedKeymap]);
  /** 正在改键的动作(null = 不在捕获中). */
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);
  // 捕获阶段监听:在场景的 window keydown 之前拦截,读取新按键并写入绑定。
  useEffect(() => {
    if (!capturing) return;
    const onCapture = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const token = eventToToken(e);
      if (!token) return; // 纯修饰键,继续等待主键
      setStoredKeymap((prev) => {
        const next = normalizeKeymap(prev);
        // 同一按键只能绑一个动作:先解绑占用者,避免冲突。
        for (const a of Object.keys(next) as ShortcutAction[]) {
          if (next[a] === token) next[a] = '';
        }
        next[capturing] = token;
        return next;
      });
      setCapturing(null);
    };
    window.addEventListener('keydown', onCapture, true);
    return () => window.removeEventListener('keydown', onCapture, true);
  }, [capturing, setStoredKeymap]);
  const resetKeymap = useCallback(() => {
    setStoredKeymap({ ...DEFAULT_KEYMAP });
    setCapturing(null);
  }, [setStoredKeymap]);

  // ── 机位预览浮窗 + 录制视频(关键帧时间轴)──
  const [showCamPanel, setShowCamPanel] = useState(false);
  const [freeFov, setFreeFov] = useState<number>(ENTRY_DEFAULTS[entry].fov);
  /** 录制模式:进入后渲染关键帧时间轴覆盖层. */
  const [recordMode, setRecordMode] = useState(false);
  /** 真实机位全屏:非空时把实时主画面铺满窗口,值为当前机位标签('free'/slotId). */
  const [camFull, setCamFull] = useState<string | null>(null);

  // ── 普通假人(路人)阵列 ──
  const [showCrowd, setShowCrowd] = useState(false);
  const [crowdMode, setCrowdMode] = useState<CrowdLayout>('array');
  const [crowdCount, setCrowdCount] = useState<number>(CROWD_DEFAULTS.array.count);
  const [crowdCols, setCrowdCols] = useState<number>(CROWD_DEFAULTS.array.columns);
  const [crowdGapX, setCrowdGapX] = useState<number>(CROWD_DEFAULTS.array.spacingX);
  const [crowdGapZ, setCrowdGapZ] = useState<number>(CROWD_DEFAULTS.array.spacingZ);
  const [crowdRadius, setCrowdRadius] = useState<number>(CROWD_DEFAULTS.random.radius);

  // ── 高级假人(红/蓝)+ 姿态预设 + 姿势调节 ──
  const [showMann, setShowMann] = useState(false);
  const [mannColor, setMannColor] = useState<MannequinColor>('red');
  const [activePose, setActivePose] = useState<string>('默认');
  /** 每根骨骼相对预设基准的欧拉增量(度);切换预设时清空. */
  const [boneDeltas, setBoneDeltas] = useState<Record<string, [number, number, number]>>({});
  const [openGroup, setOpenGroup] = useState<string | null>(BONES_BY_GROUP[0]?.group ?? null);
  const isAdvanced = !!selection && bones.length > 0;

  // ── 动画 Tab(高级假人 Mixamo 剪辑;瞬态预览,目录懒加载)──
  const [animCatalog, setAnimCatalog] = useState<AnimCatalog | null>(null);
  const [animLoadErr, setAnimLoadErr] = useState(false);
  const [animCat, setAnimCat] = useState('');
  const [animKw, setAnimKw] = useState('');
  /** 前端分页:当前展示条数(每次「加载更多」+30). */
  const [animShown, setAnimShown] = useState(30);
  /** 播放进度(场景 ~10Hz 回传;null = 无活动动画,播放条隐藏). */
  const [animTick, setAnimTick] = useState<AnimTick | null>(null);
  /** 正在加载的动画 url(点击后 FBX 下载期间禁点其它卡片). */
  const [animBusy, setAnimBusy] = useState<string | null>(null);
  const animList = useMemo(
    () =>
      animCatalog
        ? filterAnimations(animCatalog.animations, { category: animCat, keyword: animKw })
        : [],
    [animCatalog, animCat, animKw],
  );
  // 过滤条件变化时回到第一页。
  useEffect(() => {
    setAnimShown(30);
  }, [animCat, animKw]);
  const playAnim = useCallback(async (a: DirectorAnimation) => {
    const st = stageRef.current;
    if (!st) return;
    const url = animUrl(a);
    setAnimBusy(url);
    try {
      await st.playAnimation(url, a.name);
    } catch {
      alert(`动画加载失败:${a.name}(网络或资源不可用)`);
    } finally {
      setAnimBusy(null);
    }
  }, []);

  const catalog = useMemo(() => getCatalog(), []);

  // size viewport to container
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.max(320, Math.floor(r.width)), h: Math.max(240, Math.floor(r.height)) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const applyLens = useCallback((key: LensPresetKey) => {
    const f = LENS_PRESETS[key];
    setLens(key);
    setFov(f);
    setFreeFov(f);
    stageRef.current?.setLensFov(f);
    setShowLensMenu(false);
  }, []);

  /** 统一模型加载入口:目录模型直接用 CDN/桶 URL;本地导入的用 objectURL 并在加载后回收. */
  const loadModel = useCallback(
    async (url: string, opts: { isFbx?: boolean; modelId?: string; revoke?: boolean }) => {
      try {
        await stageRef.current?.addModel(url, { isFbx: opts.isFbx, modelId: opts.modelId });
      } finally {
        if (opts.revoke) URL.revokeObjectURL(url);
      }
      setShowLibrary(false);
    },
    [],
  );

  const addModel = useCallback(
    (m: DirectorModel) => loadModel(m.url, { modelId: m.id }),
    [loadModel],
  );

  // ── 导演台主页面全屏(整面板) ──
  const toggleMainFull = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    if (!document.fullscreenElement) void el.requestFullscreen?.();
    else void document.exitFullscreen?.();
  }, []);
  useEffect(() => {
    const h = () => setMainFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  // ── 全景图:本地上传 / 使用画布图 / 我的全景 / 清除 ──
  const [panoAssets, setPanoAssets] = useState<DirectorAsset[]>([]);
  /** 当前全景图来源描述(供「保存工程」记录、「打开工程」恢复). */
  const panoRefState = useRef<
    { kind: 'asset'; id: string } | { kind: 'canvas' } | { kind: 'url'; url: string } | null
  >(null);
  const refreshPanoAssets = useCallback(() => {
    listAssets('panorama').then(setPanoAssets).catch(() => setPanoAssets([]));
  }, []);
  useEffect(() => {
    if (showPano) refreshPanoAssets();
  }, [showPano, refreshPanoAssets]);

  const applyPanoAsset = useCallback(async (id: string) => {
    const r = await openAssetUrl(id);
    if (!r) return;
    stageRef.current?.setPanorama(r.url);
    panoRefState.current = { kind: 'asset', id };
    // 纹理 load 完即可回收 objectURL(异步,留足时间)。
    setTimeout(() => URL.revokeObjectURL(r.url), 15000);
    setShowPano(false);
  }, []);

  const importPanoFile = useCallback(
    async (file: File) => {
      const ext = extOf(file.name);
      if (!isPanoramaExt(ext)) {
        alert(`不支持的全景图格式:.${ext}\n支持:${PANORAMA_EXTS.map((e) => '.' + e).join(' / ')}`);
        return;
      }
      const thumb = await makeImageThumb(file);
      const asset = await putAsset({ kind: 'panorama', name: file.name, ext, blob: file, thumb });
      refreshPanoAssets();
      await applyPanoAsset(asset.id);
    },
    [applyPanoAsset, refreshPanoAssets],
  );

  const useCanvasPano = useCallback(() => {
    if (imageUrl) {
      stageRef.current?.setPanorama(imageUrl);
      panoRefState.current = { kind: 'canvas' };
    }
    setShowPano(false);
  }, [imageUrl]);

  /** 普通假人(路人)= 程序化关节小人,支持 直接添加/阵列/随机分布 + 颜色循环. */
  const addCrowd = useCallback(
    (layout: CrowdLayout) => {
      stageRef.current?.addCrowd({
        layout,
        count: crowdCount,
        columns: crowdCols,
        spacingX: crowdGapX,
        spacingZ: crowdGapZ,
        radius: crowdRadius,
      });
      if (layout === 'single') setShowCrowd(false);
    },
    [crowdCount, crowdCols, crowdGapX, crowdGapZ, crowdRadius],
  );

  /** 添加红/蓝高级假人(Mixamo X/Y Bot 绑定),与实站红=X、蓝=Y 对齐. */
  const addAdvancedMannequin = useCallback((color: MannequinColor) => {
    stageRef.current?.addModel(rigUrl(color), {
      isFbx: true,
      modelId: `adv-${color}`,
    });
    setShowMann(false);
  }, []);

  /** 套用姿态预设(35 个 + 默认/rest);清空滑杆增量. */
  const applyPosePreset = useCallback((key: string) => {
    setActivePose(key);
    setBoneDeltas({});
    stageRef.current?.applyPose(getPose(key));
  }, []);

  /** 单骨骼增量滑杆 → 在预设基准上叠加旋转. */
  const setBoneAxis = useCallback(
    (boneName: string, axis: 0 | 1 | 2, deg: number) => {
      setBoneDeltas((prev) => {
        const cur = prev[boneName] ?? [0, 0, 0];
        const next: [number, number, number] = [cur[0], cur[1], cur[2]];
        next[axis] = deg;
        stageRef.current?.setBoneDelta(boneName, next);
        return { ...prev, [boneName]: next };
      });
    },
    [],
  );

  const resetBone = useCallback((boneName: string) => {
    setBoneDeltas((prev) => {
      const next = { ...prev };
      delete next[boneName];
      stageRef.current?.setBoneDelta(boneName, [0, 0, 0]);
      return next;
    });
  }, []);

  const setTfMode = useCallback((m: TransformMode) => {
    setMode(m);
    stageRef.current?.setTransformMode(m);
  }, []);

  const capture = useCallback(
    (kind: 'single' | 4 | 12) => {
      const stage = stageRef.current;
      if (!stage) return;
      const h = CAPTURE_RES_HEIGHT[resolution];
      const shots: DirectorCaptureShot[] =
        kind === 'single'
          ? [{ dataUrl: stage.capture(h), view: 'front' }]
          : stage.captureMultiView(kind, h).map((dataUrl, i) => ({ dataUrl, view: `view-${i}` }));
      if (onCapture) onCapture(shots);
      else
        shots.forEach((s, i) =>
          downloadDataUrl(s.dataUrl, `director-${kind}-${resolution}-${i}-${Date.now()}.png`),
        );
    },
    [onCapture, resolution],
  );

  /** 机位全屏「截屏」:按所选画幅比例裁剪输出(ratio=null → 全屏). */
  const captureAspect = useCallback(
    (ratio: number | null) => {
      const stage = stageRef.current;
      if (!stage) return;
      const h = CAPTURE_RES_HEIGHT[resolution];
      const dataUrl = stage.captureAspect(ratio, h);
      if (!dataUrl) return;
      const shots: DirectorCaptureShot[] = [{ dataUrl, view: 'front' }];
      if (onCapture) onCapture(shots);
      else downloadDataUrl(dataUrl, `director-single-${resolution}-${Date.now()}.png`);
    },
    [onCapture, resolution],
  );

  // ── 保存工程 / 打开工程(JSON,非截图)────────────────────────
  /**
   * 「保存工程」= 序列化整个可编辑场景(模型/位姿/机位/相机/灯光/全景来源)为
   * .json 下载,区别于「保存截图」(导出 PNG)。逆向自实站 serialize() 架构。
   */
  const saveProject = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const scene = stage.serializeScene();
    const project = {
      app: 'director',
      kind: 'project',
      savedAt: new Date().toISOString(),
      entry,
      lens,
      resolution,
      panorama: panoRefState.current,
      scene,
    };
    const json = JSON.stringify(project, null, 2);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    downloadDataUrl(url, `director-project-${Date.now()}.json`);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, [entry, lens, resolution]);

  const restorePanorama = useCallback(
    async (pano: typeof panoRefState.current) => {
      const stage = stageRef.current;
      if (!stage) return;
      if (!pano) {
        stage.setPanorama(null);
        panoRefState.current = null;
        return;
      }
      if (pano.kind === 'asset') {
        await applyPanoAsset(pano.id);
      } else if (pano.kind === 'canvas' && imageUrl) {
        stage.setPanorama(imageUrl);
        panoRefState.current = { kind: 'canvas' };
      } else if (pano.kind === 'url') {
        stage.setPanorama(pano.url);
        panoRefState.current = pano;
      }
    },
    [applyPanoAsset, imageUrl],
  );

  const openProjectFile = useCallback(
    async (file: File) => {
      const stage = stageRef.current;
      if (!stage) return;
      let project: { scene?: DirectorSceneData; panorama?: typeof panoRefState.current; lens?: LensPresetKey; resolution?: CaptureResolution };
      try {
        project = JSON.parse(await file.text());
      } catch {
        alert('无法解析工程文件:不是有效的 JSON。');
        return;
      }
      if (!project?.scene || project.scene.version !== 1) {
        alert('工程文件格式不支持(需要 director project version 1)。');
        return;
      }
      // 导入模型用 IndexedDB 资产 id 还原成可加载 URL。
      await stage.restoreScene(project.scene, async (modelId) => {
        const r = await openAssetUrl(modelId);
        if (!r) return null;
        setTimeout(() => URL.revokeObjectURL(r.url), 20000);
        return r.url;
      });
      // 同步 React 镜像状态(灯光/相机/镜头/分辨率)。
      const sc = project.scene;
      setKeyLight({
        intensity: sc.light.keyIntensity,
        az: sc.light.keyAzimuthDeg,
        el: sc.light.keyElevationDeg,
        color: sc.light.keyColor,
      });
      setAmbient({ intensity: sc.light.ambientIntensity, color: sc.light.ambientColor });
      setFx({ ...LIGHTFX_DEFAULTS, ...(sc.fx ?? {}) });
      setFov(sc.camera.fov);
      setFreeFov(sc.camera.fov);
      if (project.lens) setLens(project.lens);
      if (project.resolution) setResolution(project.resolution);
      await restorePanorama(project.panorama ?? null);
    },
    [restorePanorama],
  );

  // ── 录制导出:把关键帧运镜结果下载为视频 ──
  const onExported = useCallback((res: RecordResult) => {
    const url = URL.createObjectURL(res.blob);
    downloadDataUrl(url, `director-${res.width}x${res.height}-${Date.now()}.${res.ext}`);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, []);

  // bind selection transform edits
  const editTransform = useCallback(
    (patch: Partial<{ position: [number, number, number]; rotationDeg: [number, number, number]; scale: [number, number, number] }>) => {
      stageRef.current?.setSelectedTransform(patch);
      setSelection((prev) => (prev ? { ...prev, ...patch } : prev));
    },
    [],
  );

  // Selection callback also fires on every gizmo drag (transform readback);
  // only refresh the bone list when the *identity* of the selection changes.
  const handleSelection = useCallback((sel: SelectionInfo | null) => {
    setSelection(sel);
    const uuid = sel?.uuid ?? null;
    if (uuid === prevSelUuid.current) return;
    prevSelUuid.current = uuid;
    const st = stageRef.current;
    setBones(uuid && st ? st.getBones() : []);
    setActiveBone(null);
    setSkeletonOn(false); // stage auto-clears the helper when selection changes
    setActivePose('默认');
    setBoneDeltas({});
  }, []);

  const toggleSkeleton = useCallback(() => {
    setSkeletonOn((v) => {
      const next = !v;
      stageRef.current?.showSkeleton(next);
      return next;
    });
  }, []);

  const poseBone = useCallback((uuid: string | null) => {
    stageRef.current?.poseBone(uuid);
    setActiveBone(uuid);
    setMode(uuid ? 'rotate' : 'translate'); // posing a bone forces rotate
  }, []);

  const resetPose = useCallback(() => {
    stageRef.current?.resetPose();
    setActivePose('默认');
    setBoneDeltas({});
  }, []);

  // Leaving the pose tab returns the gizmo to the whole model.
  const switchTab = useCallback(
    (t: 'props' | 'pose' | 'anim') => {
      if (t !== 'pose' && activeBone) {
        stageRef.current?.poseBone(null);
        setActiveBone(null);
        setMode('translate');
      }
      if (t === 'pose') {
        // 姿势编辑与动画 mixer 冲突:仅当选中对象正是动画目标时先停
        // (恢复播放前姿势);别的假人在播则不打扰,场景层姿势入口另有兜底。
        if (animTick && animTick.targetUuid === selection?.uuid) {
          stageRef.current?.stopAnimation();
        }
        const st = stageRef.current;
        setBones(selection && st ? st.getBones() : []);
      }
      if (t === 'anim' && !animCatalog && !animLoadErr) {
        loadAnimCatalog()
          .then(setAnimCatalog)
          .catch(() => setAnimLoadErr(true));
      }
      setTab(t);
    },
    [activeBone, selection, animTick, animCatalog, animLoadErr],
  );

  const isPunk = theme === 'punk';
  const panelBg = isPunk ? 'var(--punk-bg, #1c1c1c)' : '#1a1c22';

  return (
    <div ref={shellRef} style={styles.shell}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.brand}>
          <strong style={{ color: '#22d3ee', letterSpacing: 1 }}>Director</strong>
          <span style={{ opacity: 0.7 }}>导演台</span>
          <button style={styles.ghostBtn} onClick={saveProject} title="保存整个场景(模型/位姿/机位/相机/灯光)为 .json 工程文件">
            💾 保存工程
          </button>
          <button
            style={styles.ghostBtn}
            onClick={() => projectInputRef.current?.click()}
            title="从 .json 工程文件恢复场景"
          >
            📂 打开工程
          </button>
          <input
            ref={projectInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openProjectFile(f);
              e.target.value = '';
            }}
          />

          {/* 全景图导入:本地上传 / 使用画布图 / 我的全景 / 清除 */}
          <div style={{ position: 'relative' }}>
            <button style={styles.ghostBtn} onClick={() => setShowPano((v) => !v)}>
              🌐 全景图 ▾
            </button>
            {showPano && (
              <PanoramaImport
                imageUrl={imageUrl}
                assets={panoAssets}
                onUploadFile={importPanoFile}
                onUseCanvas={useCanvasPano}
                onPick={applyPanoAsset}
                onDelete={async (id) => {
                  await deleteAsset(id);
                  refreshPanoAssets();
                }}
                onClear={() => {
                  stageRef.current?.setPanorama(null);
                  panoRefState.current = null;
                  setShowPano(false);
                }}
                onClose={() => setShowPano(false)}
              />
            )}
          </div>

          <button style={styles.ghostBtn} onClick={() => stageRef.current?.mirror()}>
            镜像
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button style={styles.ghostBtn} onClick={toggleMainFull} title="主页面全屏">
            {mainFull ? '🗗 退出全屏' : '⛶ 全屏'}
          </button>
          <button style={styles.closeBtn} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>
      </div>

      <div style={styles.body}>
        {/* 左侧浮层:对象与机位 + 灯光 垂直堆叠 */}
        <div style={styles.leftStack}>
        {/* 对象与机位 — 左上场景对象列表(对照原站) */}
        <div style={{ ...styles.objPanel, background: panelBg }}>
          <button style={styles.objHeader} onClick={() => setObjPanelOpen((v) => !v)}>
            <span>对象与机位</span>
            <span style={styles.objCount}>{objects.length}</span>
            <span style={{ marginLeft: 'auto', opacity: 0.6 }}>{objPanelOpen ? '▾' : '▸'}</span>
          </button>
          {objPanelOpen && (
            <div style={styles.objList}>
              {objects.length === 0 ? (
                <div style={styles.objEmpty}>暂无对象 — 用底栏「添加模型 / 假人」</div>
              ) : (
                objects.map((o, i) => (
                  <div
                    key={o.uuid}
                    style={o.selected ? styles.objRowActive : styles.objRow}
                    onClick={() => stageRef.current?.selectByUuid(o.uuid)}
                  >
                    <span style={styles.objIcon}>◉</span>
                    <span style={styles.objName} title={o.name}>
                      {o.name || `对象 ${i + 1}`}
                    </span>
                    {o.selected && (
                      <button
                        style={styles.objDel}
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          stageRef.current?.removeSelected();
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* Lighting panel (left, toggle) */}
        {showLights && (
          <div style={{ ...styles.leftBox, background: panelBg }}>
            <div style={styles.panelTitle}>
              灯光
              <button style={styles.miniX} onClick={() => setShowLights(false)}>
                ×
              </button>
            </div>
            <div style={styles.section}>主光(平行光)</div>
            <Slider
              label="强度"
              min={LIGHT_DEFAULTS.key.range.intensity[0]}
              max={LIGHT_DEFAULTS.key.range.intensity[1]}
              step={0.1}
              value={keyLight.intensity}
              onChange={(v) => {
                setKeyLight((s) => ({ ...s, intensity: v }));
                stageRef.current?.setKeyLight({ intensity: v });
              }}
            />
            <Slider
              label="水平"
              min={LIGHT_DEFAULTS.key.range.azimuth[0]}
              max={LIGHT_DEFAULTS.key.range.azimuth[1]}
              step={1}
              value={keyLight.az}
              onChange={(v) => {
                setKeyLight((s) => ({ ...s, az: v }));
                stageRef.current?.setKeyLight({ azimuthDeg: v });
              }}
            />
            <Slider
              label="俯仰"
              min={LIGHT_DEFAULTS.key.range.elevation[0]}
              max={LIGHT_DEFAULTS.key.range.elevation[1]}
              step={1}
              value={keyLight.el}
              onChange={(v) => {
                setKeyLight((s) => ({ ...s, el: v }));
                stageRef.current?.setKeyLight({ elevationDeg: v });
              }}
            />
            <ColorRow
              label="主光颜色"
              value={keyLight.color}
              onChange={(c) => {
                setKeyLight((s) => ({ ...s, color: c }));
                stageRef.current?.setKeyLight({ color: c });
              }}
            />
            <div style={styles.section}>环境光(半球光)</div>
            <Slider
              label="强度"
              min={LIGHT_DEFAULTS.ambient.range.intensity[0]}
              max={LIGHT_DEFAULTS.ambient.range.intensity[1]}
              step={0.05}
              value={ambient.intensity}
              onChange={(v) => {
                setAmbient((s) => ({ ...s, intensity: v }));
                stageRef.current?.setAmbient({ intensity: v });
              }}
            />
            <ColorRow
              label="环境光颜色"
              value={ambient.color}
              onChange={(c) => {
                setAmbient((s) => ({ ...s, color: c }));
                stageRef.current?.setAmbient({ color: c });
              }}
            />

            <LightFxPanel
              value={fx}
              onChange={patchFx}
              accent="#22d3ee"
              showIbl={entry === 'panorama'}
              showDof
            />
            <select style={{ display: 'none' }} aria-hidden defaultValue="auto">
                <option value="auto">自动</option>
                <option value="none"></option>
                <option value="agx">AgX</option>
                <option value="aces">ACES</option>
                <option value="neutral">中性</option>
              </select>
          </div>
        )}
        </div>

        {/* Viewport */}
        <div ref={viewportRef} style={camFull ? styles.viewportFull : styles.viewport}>
          <DirectorStageScene
            ref={stageRef}
            entry={entry}
            panoramaUrl={entry === 'panorama' ? imageUrl : undefined}
            width={size.w}
            height={size.h}
            onSelectionChange={handleSelection}
            onObjectsChange={setObjects}
            onModeChange={setMode}
            onHistoryChange={handleHistoryChange}
            onBoxSelectChange={setBoxSelect}
            keymap={keymap}
            onAnimTick={setAnimTick}
          />
          {/* 动画播放条(有活动动画时浮在视口底部中央) */}
          {animTick && (
            <div style={styles.animBar}>
              <span style={styles.animBarName} title={animTick.name}>
                {animTick.name}
              </span>
              <button
                style={styles.toolBtn}
                title={animTick.playing ? '暂停' : '播放'}
                onClick={() =>
                  animTick.playing
                    ? stageRef.current?.pauseAnimation()
                    : stageRef.current?.resumeAnimation()
                }
              >
                {animTick.playing ? '⏸' : '▶'}
              </button>
              <input
                type="range"
                min={0}
                max={animTick.duration}
                step={0.01}
                value={animTick.time}
                onChange={(e) => stageRef.current?.seekAnimation(Number(e.target.value))}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span style={styles.animBarTime}>
                {animTick.time.toFixed(1)}s / {animTick.duration.toFixed(1)}s
              </span>
              <button
                style={styles.toolBtn}
                title="停止并恢复播放前姿势"
                onClick={() => stageRef.current?.stopAnimation()}
              >
                ⏹
              </button>
            </div>
          )}
          {/* bottom-left camera sliders */}
          <div style={styles.camDock}>
            <Slider
              label="FOV"
              min={FOV_RANGE[0]}
              max={FOV_RANGE[1]}
              step={FOV_STEP}
              value={fov}
              onChange={(v) => {
                setFov(v);
                setFreeFov(v);
                stageRef.current?.setLensFov(v);
              }}
              compact
            />
            <Slider
              label="镜头距离"
              min={DISTANCE_RANGE[0]}
              max={DISTANCE_RANGE[1]}
              step={DISTANCE_STEP}
              value={distance}
              onChange={(v) => {
                setDistance(v);
                stageRef.current?.setDistance(v);
              }}
              compact
            />
          </div>

          {/* 机位预览浮窗 + 属性面板 */}
          {showCamPanel && !recordMode && !camFull && (
            <DirectorCameraPanel
              stageRef={stageRef}
              freeFov={freeFov}
              onClose={() => setShowCamPanel(false)}
              onFullscreen={(tab) => {
                if (tab !== 'free') stageRef.current?.applyCameraSlot(tab);
                setCamFull(tab);
              }}
            />
          )}

          {/* 真实机位全屏(图四):实时主画面铺满 + 极简 chrome */}
          {camFull && (
            <DirectorFullscreenCam
              stageRef={stageRef}
              initialTab={camFull}
              freeFov={freeFov}
              containerRef={viewportRef}
              onExit={() => {
                // 仅当「机位容器自身」占用了 OS 全屏时才退出,
                // 否则会把导演台主页面的全屏一并退掉(返回主页时全屏丢失)。
                if (document.fullscreenElement === viewportRef.current) {
                  void document.exitFullscreen?.();
                }
                setCamFull(null);
              }}
              onCapture={captureAspect}
            />
          )}

          {/* 录制视频:关键帧运镜时间轴覆盖层 */}
          {recordMode && (
            <DirectorRecordTimeline
              stageRef={stageRef}
              onExit={() => setRecordMode(false)}
              onExported={onExported}
            />
          )}
        </div>

        {/* Right panel — 属性 / 姿势 */}
        <div style={{ ...styles.sidePanel, right: 12, background: panelBg }}>
          <div style={styles.tabRow}>
            <button
              style={tab === 'props' ? styles.tabActive : styles.tab}
              onClick={() => switchTab('props')}
            >
              属性
            </button>
            <button
              style={tab === 'pose' ? styles.tabActive : styles.tab}
              onClick={() => switchTab('pose')}
            >
              姿势
            </button>
            <button
              style={tab === 'anim' ? styles.tabActive : styles.tab}
              onClick={() => switchTab('anim')}
            >
              动画
            </button>
          </div>
          {tab === 'props' ? (
            selection ? (
              <>
                <div style={styles.section}>位置</div>
                <XYZ
                  range={TRANSFORM_RANGE.position}
                  value={selection.position}
                  onChange={(position) => editTransform({ position })}
                />
                <div style={styles.section}>旋转 (°)</div>
                <XYZ
                  range={TRANSFORM_RANGE.rotationDeg}
                  step={1}
                  value={selection.rotationDeg}
                  onChange={(rotationDeg) => editTransform({ rotationDeg })}
                />
                <div style={styles.section}>缩放</div>
                <XYZ
                  range={TRANSFORM_RANGE.scale}
                  step={0.01}
                  value={selection.scale}
                  onChange={(scale) => editTransform({ scale })}
                />
              </>
            ) : (
              <div style={styles.hint}>点选一个模型以编辑变换</div>
            )
          ) : tab === 'anim' ? (
            !selection ? (
              <div style={styles.hint}>点选一个高级假人以播放动画</div>
            ) : !isAdvanced ? (
              <div style={styles.hint}>
                该模型无骨骼(非绑定模型)。从底栏「高级假人」添加红/蓝假人(Mixamo
                绑定)即可播放动画。
              </div>
            ) : animLoadErr ? (
              <div style={styles.hint}>动画目录加载失败,切走再切回「动画」页重试。</div>
            ) : !animCatalog ? (
              <div style={styles.hint}>动画目录加载中…</div>
            ) : (
              <>
                <select
                  style={styles.animSelect}
                  value={animCat}
                  onChange={(e) => setAnimCat(e.target.value)}
                >
                  <option value="">全部分类({animCatalog.animations.length})</option>
                  {animCatalog.categories.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <input
                  style={styles.animSearch}
                  value={animKw}
                  onChange={(e) => setAnimKw(e.target.value)}
                  placeholder="搜索动画(中/英文)"
                />
                <div style={styles.poseGrid}>
                  {animList.slice(0, animShown).map((a) => {
                    const url = animUrl(a);
                    const active = animTick?.url === url;
                    return (
                      <button
                        key={a.id}
                        style={active ? styles.posePresetActive : styles.posePreset}
                        title={a.nameEn || a.name}
                        disabled={animBusy != null}
                        onClick={() => void playAnim(a)}
                      >
                        {animBusy === url ? '⏳' : a.name}
                      </button>
                    );
                  })}
                </div>
                {animList.length === 0 && (
                  <div style={styles.hint}>没有匹配的动画,换个关键词试试。</div>
                )}
                {animShown < animList.length && (
                  <button
                    style={{ ...styles.toolBtn, width: '100%', marginTop: 6 }}
                    onClick={() => setAnimShown((n) => n + 30)}
                  >
                    加载更多({Math.min(animShown, animList.length)}/{animList.length})
                  </button>
                )}
              </>
            )
          ) : !selection ? (
            <div style={styles.hint}>点选一个模型以摆姿</div>
          ) : !isAdvanced ? (
            <div style={styles.hint}>
              该模型无骨骼(非绑定模型)。从底栏「高级假人」添加红/蓝假人(Mixamo
              绑定)即可使用姿态预设与骨骼调节。
            </div>
          ) : (
            <>
              <div style={styles.poseToolRow}>
                <button
                  style={skeletonOn ? styles.toolBtnActive : styles.toolBtn}
                  onClick={toggleSkeleton}
                >
                  {skeletonOn ? '隐藏骨架' : '显示骨架'}
                </button>
                <button style={styles.toolBtn} onClick={resetPose}>
                  重置姿势
                </button>
              </div>

              {/* 姿态预设 — 35 个 + 默认 */}
              <div style={styles.section}>姿态预设</div>
              <div style={styles.poseGrid}>
                {POSE_KEYS.map((k) => (
                  <button
                    key={k}
                    style={k === activePose ? styles.posePresetActive : styles.posePreset}
                    onClick={() => applyPosePreset(k)}
                  >
                    {k}
                  </button>
                ))}
              </div>

              {/* 姿势调节 — 按骨骼分组的增量滑杆 */}
              <div style={styles.section}>姿势调节</div>
              {BONES_BY_GROUP.map(({ group, bones: groupBones }) => (
                <div key={group} style={styles.boneGroup}>
                  <button
                    style={styles.boneGroupHead}
                    onClick={() => setOpenGroup((g) => (g === group ? null : group))}
                  >
                    <span>{group}</span>
                    <span style={{ opacity: 0.5 }}>{openGroup === group ? '▾' : '▸'}</span>
                  </button>
                  {openGroup === group &&
                    groupBones.map((b) => {
                      const d = boneDeltas[b.boneName] ?? [0, 0, 0];
                      const dirty = d[0] !== 0 || d[1] !== 0 || d[2] !== 0;
                      return (
                        <div key={b.boneName} style={styles.boneCard}>
                          <div style={styles.boneCardHead}>
                            <span>{b.label}</span>
                            <button
                              style={dirty ? styles.boneResetActive : styles.boneReset}
                              onClick={() => resetBone(b.boneName)}
                            >
                              重置
                            </button>
                          </div>
                          {([0, 1, 2] as const).map((axis) => (
                            <BoneAxis
                              key={axis}
                              axis={axis}
                              value={d[axis]}
                              onChange={(v) => setBoneAxis(b.boneName, axis, v)}
                            />
                          ))}
                        </div>
                      );
                    })}
                </div>
              ))}

              {/* 备选:gizmo 单骨骼摆姿 */}
              <div style={styles.section}>骨骼列表(3D 控制器)</div>
              {activeBone && (
                <button style={styles.poseBackBtn} onClick={() => poseBone(null)}>
                  ← 返回整体移动
                </button>
              )}
              <div style={styles.boneList}>
                {bones.map((b) => (
                  <button
                    key={b.uuid}
                    style={{
                      ...(activeBone === b.uuid ? styles.boneRowActive : styles.boneRow),
                      paddingLeft: 8 + b.depth * 12,
                    }}
                    title={b.name}
                    onClick={() => poseBone(b.uuid)}
                  >
                    {b.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom toolbar */}
      <div style={styles.toolbar}>
        <div style={{ position: 'relative' }}>
          <button style={styles.toolBtn} onClick={() => setShowLibrary((v) => !v)}>
            添加模型
          </button>
          {showLibrary && (
            <ModelLibrary
              catalog={catalog}
              onPick={addModel}
              onLoad={loadModel}
              onClose={() => setShowLibrary(false)}
            />
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            style={showCrowd ? styles.toolBtnActive : styles.toolBtn}
            onClick={() => setShowCrowd((v) => !v)}
          >
            普通假人 ▾
          </button>
          {showCrowd && (
            <div style={styles.mannPop}>
              <div style={styles.mannTitle}>普通假人</div>
              <div style={styles.crowdSeg}>
                {(
                  [
                    ['single', '直接添加'],
                    ['array', '阵列'],
                    ['random', '随机分布'],
                  ] as [CrowdLayout, string][]
                ).map(([k, label]) => (
                  <button
                    key={k}
                    style={k === crowdMode ? styles.crowdSegActive : styles.crowdSegBtn}
                    onClick={() => (k === 'single' ? addCrowd('single') : setCrowdMode(k))}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {crowdMode === 'array' && (
                <>
                  <div style={styles.crowdRow}>
                    <CrowdNum label="数量" value={crowdCount} min={1} max={64} step={1} onChange={setCrowdCount} />
                    <CrowdNum label="列数" value={crowdCols} min={1} max={16} step={1} onChange={setCrowdCols} />
                  </div>
                  <div style={styles.crowdRow}>
                    <CrowdNum label="横向间距" value={crowdGapX} min={0.5} max={4} step={0.05} onChange={setCrowdGapX} />
                    <CrowdNum label="纵向间距" value={crowdGapZ} min={0.5} max={4} step={0.05} onChange={setCrowdGapZ} />
                  </div>
                  <button style={{ ...styles.mannAdd, background: '#2f5fb0' }} onClick={() => addCrowd('array')}>
                    生成批量路人
                  </button>
                </>
              )}
              {crowdMode === 'random' && (
                <>
                  <div style={styles.crowdRow}>
                    <CrowdNum label="数量" value={crowdCount} min={1} max={80} step={1} onChange={setCrowdCount} />
                    <CrowdNum label="分布半径" value={crowdRadius} min={1} max={12} step={0.1} onChange={setCrowdRadius} />
                  </div>
                  <button style={{ ...styles.mannAdd, background: '#2f5fb0' }} onClick={() => addCrowd('random')}>
                    生成批量路人
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <button
            style={showMann ? styles.toolBtnActive : styles.toolBtn}
            onClick={() => setShowMann((v) => !v)}
          >
            高级假人 ▾
          </button>
          {showMann && (
            <div style={styles.mannPop}>
              <div style={styles.mannTitle}>高级假人</div>
              <div style={styles.mannSeg}>
                {(Object.keys(ADVANCED_MANNEQUIN) as MannequinColor[]).map((c) => (
                  <button
                    key={c}
                    style={c === mannColor ? styles.mannSegActive : styles.mannSegBtn}
                    onClick={() => setMannColor(c)}
                  >
                    <span
                      style={{
                        ...styles.mannDot,
                        background: c === 'red' ? '#e0564f' : '#3f7bdb',
                      }}
                    />
                    {ADVANCED_MANNEQUIN[c].label}
                  </button>
                ))}
              </div>
              <button
                style={{
                  ...styles.mannAdd,
                  background: mannColor === 'red' ? '#b5403a' : '#2f5fb0',
                }}
                onClick={() => addAdvancedMannequin(mannColor)}
              >
                添加{ADVANCED_MANNEQUIN[mannColor].label}假人
              </button>
            </div>
          )}
        </div>
        <button
          style={styles.toolBtn}
          title="删除选中 (Delete)"
          onClick={() => stageRef.current?.removeSelected()}
        >
          删除选中
        </button>
        <button
          style={styles.toolBtn}
          title="复制选中 (Ctrl+D)"
          onClick={() => stageRef.current?.duplicateSelected()}
        >
          复制
        </button>
        <span style={styles.sep} />
        <button
          style={history.canUndo ? styles.toolBtn : styles.toolBtnDisabled}
          title="撤销 (Ctrl+Z)"
          disabled={!history.canUndo}
          onClick={() => stageRef.current?.undo()}
        >
          ↶ 撤销
        </button>
        <button
          style={history.canRedo ? styles.toolBtn : styles.toolBtnDisabled}
          title="重做 (Ctrl+Shift+Z)"
          disabled={!history.canRedo}
          onClick={() => stageRef.current?.redo()}
        >
          ↷ 重做
        </button>
        <span style={styles.sep} />
        <button style={mode === 'translate' ? styles.toolBtnActive : styles.toolBtn} onClick={() => setTfMode('translate')} title="移动 (W)">
          移动
        </button>
        <button style={mode === 'rotate' ? styles.toolBtnActive : styles.toolBtn} onClick={() => setTfMode('rotate')} title="旋转 (E)">
          旋转
        </button>
        <button style={mode === 'scale' ? styles.toolBtnActive : styles.toolBtn} onClick={() => setTfMode('scale')} title="缩放 (R)">
          缩放
        </button>
        <button
          style={boxSelect ? styles.toolBtnActive : styles.toolBtn}
          onClick={() => stageRef.current?.setBoxSelect(!boxSelect)}
          title="框选多选 (B):左键拖拽框选,Esc 取消"
        >
          框选
        </button>
        <button
          style={styles.toolBtn}
          title="聚焦选中 (F)"
          onClick={() => stageRef.current?.focusSelected()}
        >
          聚焦
        </button>
        <span style={styles.sep} />
        <div style={{ position: 'relative' }}>
          <button style={styles.toolBtn} onClick={() => setShowLensMenu((v) => !v)}>
            {lens} ▾
          </button>
          {showLensMenu && (
            <div style={styles.lensMenu}>
              {LENS_PRESET_KEYS.map((k) => (
                <button key={k} style={styles.lensItem} onClick={() => applyLens(k)}>
                  <span>
                    {k} <span style={{ opacity: 0.4 }}>{LENS_FOCAL[k]}mm</span>
                  </span>
                  <span style={{ opacity: 0.5 }}>{LENS_PRESETS[k]}°</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button style={showLights ? styles.toolBtnActive : styles.toolBtn} onClick={() => setShowLights((v) => !v)}>
          灯光
        </button>
        <button style={styles.toolBtn} onClick={() => stageRef.current?.reset()}>
          复位
        </button>
        <button
          style={gridVisible ? styles.toolBtnActive : styles.toolBtn}
          onClick={() => {
            const v = !gridVisible;
            setGridVisible(v);
            stageRef.current?.toggleGrid(v);
          }}
        >
          网格
        </button>
        <span style={styles.sep} />
        {/* 分辨率选择器 */}
        <div style={styles.resWrap}>
          <button style={styles.toolBtn} onClick={() => setShowRes((v) => !v)}>
            {resolution} ▾
          </button>
          {showRes && (
            <div style={styles.resMenu}>
              {CAPTURE_RESOLUTIONS.map((r) => (
                <button
                  key={r}
                  style={r === resolution ? styles.resItemActive : styles.resItem}
                  onClick={() => {
                    setResolution(r);
                    setShowRes(false);
                  }}
                >
                  {r}
                  <span style={styles.resPx}>{RES_LABEL[r]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button style={styles.toolBtn} onClick={() => capture('single')}>
          截屏
        </button>
        <button style={styles.toolBtn} onClick={() => capture(4)}>
          4视角
        </button>
        <button style={styles.toolBtn} onClick={() => capture(12)}>
          12视角
        </button>
        <span style={styles.sep} />
        {/* 录制视频:进入关键帧运镜时间轴 */}
        <button
          style={recordMode ? styles.toolBtnActive : styles.toolBtn}
          onClick={() => {
            setShowCamPanel(false);
            setRecordMode(true);
          }}
        >
          🎬 录制视频
        </button>
        {/* 机位:右下角预览浮窗 + 属性面板 */}
        <button
          style={showCamPanel ? styles.toolBtnActive : styles.toolBtn}
          onClick={() => {
            const next = !showCamPanel;
            setShowCamPanel(next);
            if (next) setFreeFov(stageRef.current?.getFov() ?? freeFov);
          }}
        >
          📷 机位
        </button>
        <span style={styles.sep} />
        <button
          style={showShortcuts ? styles.toolBtnActive : styles.toolBtn}
          onClick={() => setShowShortcuts((v) => !v)}
          title="快捷键"
        >
          ⌨ 快捷键
        </button>
      </div>

      {/* 快捷键叠层(可改键) */}
      {showShortcuts && (
        <div
          style={styles.shortcutOverlay}
          onClick={() => {
            setShowShortcuts(false);
            setCapturing(null);
          }}
        >
          <div style={styles.shortcutCard} onClick={(e) => e.stopPropagation()}>
            <div style={styles.shortcutTitle}>
              快捷键
              <span style={{ flex: 1 }} />
              <button style={styles.resetKeyBtn} onClick={resetKeymap} title="恢复默认绑定">
                恢复默认
              </button>
              <button
                style={styles.miniX}
                onClick={() => {
                  setShowShortcuts(false);
                  setCapturing(null);
                }}
              >
                ×
              </button>
            </div>

            <div style={styles.shortcutHint}>点右侧按键可重新绑定 · 捕获时按 Esc 取消</div>
            {SHORTCUT_DEFS.map((def) => {
              const isCap = capturing === def.action;
              return (
                <div key={def.action} style={styles.shortcutRow}>
                  <span style={styles.shortcutDesc}>{def.label}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    style={isCap ? styles.keyBtnCapturing : styles.keyBtn}
                    onClick={() => setCapturing(isCap ? null : def.action)}
                    title="点击后按下要绑定的按键"
                  >
                    {isCap ? '按下按键…' : tokenLabel(keymap[def.action])}
                  </button>
                </div>
              );
            })}

            <div style={styles.shortcutSep} />
            <div style={styles.shortcutHint}>以下为固定交互</div>
            {FIXED_SHORTCUTS.map(([k, d]) => (
              <div key={k} style={styles.shortcutRow}>
                <span style={styles.shortcutDesc}>{d}</span>
                <span style={{ flex: 1 }} />
                <kbd style={styles.kbd}>{k}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const RES_LABEL: Record<CaptureResolution, string> = {
  '1080p': 'FHD',
  '2k': '2K',
  '4k': '4K',
};

const FIXED_SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['左键拖拽', '旋转视角(环绕)'],
  ['右键拖拽', '平移视角'],
  ['滚轮', '推拉镜头(距离)'],
  ['左键点击', '选中对象(框选模式下拖拽=框选)'],
  ['拖拽坐标轴', '变换选中对象'],
  ['Shift + 拖拽', '吸附(移动/旋转/缩放)'],
  ['Esc', '取消选择 / 退出框选'],
  ['姿势页 + 选骨骼', '单骨骼旋转摆姿'],
];

/* ── Small controls ─────────────────────────────────────────────── */

function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  onChange,
  compact,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  compact?: boolean;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: compact ? '2px 0' : '6px 0' }}>
      <span style={{ fontSize: 11, color: '#9aa3b2', width: compact ? 56 : 48 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ flex: 1, accentColor: '#22d3ee' }}
      />
      <span style={{ fontSize: 11, color: '#cbd2dd', width: 40, textAlign: 'right' }}>
        {Number.isInteger(step) ? Math.round(value) : value.toFixed(1)}
      </span>
    </div>
  );
}

const AXIS_META = [
  { label: 'X', color: '#ef4444' },
  { label: 'Y', color: '#22c55e' },
  { label: 'Z', color: '#3b82f6' },
] as const;

/** 单轴骨骼增量滑杆(-180°~180°),配色对应 X/Y/Z. */
function BoneAxis({
  axis,
  value,
  onChange,
}: {
  axis: 0 | 1 | 2;
  value: number;
  onChange: (v: number) => void;
}) {
  const meta = AXIS_META[axis];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
      <span style={{ ...styles.axisBadge, background: meta.color }}>{meta.label}</span>
      <input
        type="range"
        min={-180}
        max={180}
        step={1}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ flex: 1, accentColor: meta.color }}
      />
      <span style={{ fontSize: 11, color: '#cbd2dd', width: 36, textAlign: 'right' }}>
        {Math.round(value)}
      </span>
    </div>
  );
}

function CrowdNum({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
      <span style={{ fontSize: 11, color: '#9aa3b2' }}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = +e.target.value;
          if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        style={{
          width: '100%',
          background: '#15171d',
          border: '1px solid #2a2e38',
          borderRadius: 6,
          color: '#e6e9ef',
          fontSize: 13,
          padding: '6px 8px',
        }}
      />
    </label>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
      <span style={{ fontSize: 11, color: '#9aa3b2', flex: 1 }}>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} style={{ width: 28, height: 22, border: 'none', background: 'none' }} />
    </div>
  );
}

function XYZ({
  value,
  range,
  step = 0.1,
  onChange,
}: {
  value: [number, number, number];
  range: readonly [number, number];
  step?: number;
  onChange: (v: [number, number, number]) => void;
}) {
  const axes: Array<{ k: 0 | 1 | 2; c: string }> = [
    { k: 0, c: '#ef4444' },
    { k: 1, c: '#22c55e' },
    { k: 2, c: '#3b82f6' },
  ];
  return (
    <>
      {axes.map(({ k, c }) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '3px 0' }}>
          <span style={{ width: 14, height: 14, borderRadius: 3, background: c }} />
          <input
            type="range"
            min={range[0]}
            max={range[1]}
            step={step}
            value={value[k]}
            onChange={(e) => {
              const next = [...value] as [number, number, number];
              next[k] = +e.target.value;
              onChange(next);
            }}
            style={{ flex: 1, accentColor: c }}
          />
          <span style={{ fontSize: 11, color: '#cbd2dd', width: 44, textAlign: 'right' }}>
            {value[k].toFixed(2)}
          </span>
        </div>
      ))}
    </>
  );
}

const MY_MODELS_KEY = '__mine__';

function ModelLibrary({
  catalog,
  onPick,
  onLoad,
  onClose,
}: {
  catalog: ReturnType<typeof getCatalog>;
  onPick: (m: DirectorModel) => void;
  /** 加载任意 URL(本地导入用 objectURL + revoke). */
  onLoad: (url: string, opts: { isFbx?: boolean; modelId?: string; revoke?: boolean }) => void;
  onClose: () => void;
}) {
  const [cat, setCat] = useState(catalog[0]?.key ?? '');
  const [mine, setMine] = useState<DirectorAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const isMine = cat === MY_MODELS_KEY;
  const active = catalog.find((c) => c.key === cat) ?? catalog[0];

  const refreshMine = useCallback(() => {
    listAssets('model').then(setMine).catch(() => setMine([]));
  }, []);
  useEffect(() => {
    refreshMine();
  }, [refreshMine]);

  const onFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setBusy(true);
      try {
        for (const file of Array.from(files)) {
          const ext = extOf(file.name);
          if (!isModelExt(ext)) {
            alert(
              `不支持的模型格式:.${ext}\n支持:${MODEL_EXTS.map((e) => '.' + e).join(' / ')}`,
            );
            continue;
          }
          await putAsset({
            kind: 'model',
            name: file.name,
            ext,
            isFbx: ext === 'fbx',
            blob: file,
          });
        }
        refreshMine();
        setCat(MY_MODELS_KEY);
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    },
    [refreshMine],
  );

  const pickMine = useCallback(
    async (a: DirectorAsset) => {
      const r = await openAssetUrl(a.id);
      if (!r) return;
      onLoad(r.url, { isFbx: r.asset.isFbx, modelId: a.id, revoke: true });
    },
    [onLoad],
  );

  return (
    <div style={styles.libraryPop}>
      <div style={styles.libraryHead}>
        <span>选择模型</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            style={styles.uploadBtn}
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {busy ? '导入中…' : '⬆ 上传模型'}
          </button>
          <button style={styles.miniX} onClick={onClose}>
            ×
          </button>
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".glb,.gltf,.fbx"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => onFiles(e.target.files)}
      />
      <div style={styles.libraryTabs}>
        {catalog.map((c) => (
          <button
            key={c.key}
            style={c.key === cat ? styles.libTabActive : styles.libTab}
            onClick={() => setCat(c.key)}
          >
            {c.label}
          </button>
        ))}
        <button
          style={isMine ? styles.libTabActive : styles.libTab}
          onClick={() => setCat(MY_MODELS_KEY)}
        >
          预设模型
        </button>
      </div>

      {isMine ? (
        <>
          <div style={styles.libraryGrid}>
            <button
              style={styles.uploadTile}
              onClick={() => fileRef.current?.click()}
              title="点击上传本地模型"
            >
              <span style={{ fontSize: 28, lineHeight: 1 }}>＋</span>
            </button>
            {mine.map((a) => (
              <div key={a.id} style={styles.mineCell}>
                <button
                  style={styles.libCell}
                  title={`${a.name} · ${formatBytes(a.size)}`}
                  onClick={() => pickMine(a)}
                >
                  <div
                    style={{
                      ...styles.libThumb,
                      display: 'grid',
                      placeItems: 'center',
                      color: '#7c8696',
                      fontSize: 11,
                      gap: 2,
                    }}
                  >
                    <span style={{ fontSize: 18 }}>{a.isFbx ? '🦴' : '📦'}</span>
                    <span>.{a.ext}</span>
                  </div>
                  <span style={styles.libName}>{a.name}</span>
                </button>
                <button
                  style={styles.mineDel}
                  title="删除"
                  onClick={async () => {
                    await deleteAsset(a.id);
                    refreshMine();
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          {mine.length === 0 && (
            <div style={styles.emptyHint}>暂无模型,可点击「＋」或右上角「上传模型」</div>
          )}
          <ImportHints kind="model" />
        </>
      ) : (
        <div style={styles.libraryGrid}>
          {active?.models.map((m) => (
            <button key={m.id} style={styles.libCell} title={m.name} onClick={() => onPick(m)}>
              {m.previewImage ? (
                <img src={m.previewImage} alt={m.name} loading="lazy" style={styles.libThumb} />
              ) : (
                <div style={{ ...styles.libThumb, display: 'grid', placeItems: 'center', color: '#555' }}>3D</div>
              )}
              <span style={styles.libName}>{m.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 导入格式/体积/骨骼提醒 —— 模型 与 全景图 两套文案. */
function ImportHints({ kind }: { kind: 'model' | 'panorama' }) {
  if (kind === 'model') {
    return (
      <div style={styles.hintBox}>
        <div style={styles.hintTitle}>导入须知</div>
        <ul style={styles.hintList}>
          <li>
            支持格式:<b>.glb</b>(推荐,单文件自带贴图)、<b>.gltf</b>(需内嵌 buffer/贴图,
            多文件分离的 .gltf 暂不支持)、<b>.fbx</b>。
          </li>
          <li>
            体积:建议 ≤ {formatBytes(MODEL_SIZE_HINT)};过大将影响加载与帧率。导入后会自动
            居中落地,最长边 &gt; 6 时按比例缩小到约 4 单位。
          </li>
          <li>
            样式:支持带 PBR 材质 / 贴图的静态模型;道具、场景、交通工具均可。透明 / 自发光
            材质请自带。
          </li>
          <li>
            高级模型(骨骼):<b>.fbx 含骨骼(Skeleton/Bones)</b> 可被识别为可摆姿对象,支持
            姿势预设与单骨骼调节(同高级假人);.glb 带 skin 也可,但姿势预设按 Mixamo 命名匹配。
          </li>
          <li>本地导入的模型保存在浏览器(IndexedDB),<b>刷新/重开仍在</b>,可重复使用。</li>
        </ul>
      </div>
    );
  }
  return (
    <div style={styles.hintBox}>
      <div style={styles.hintTitle}>全景图须知</div>
      <ul style={styles.hintList}>
        <li>
          支持:{PANORAMA_EXTS.map((e) => '.' + e).join(' / ')};等距柱状(equirectangular,
          2:1)效果最佳。
        </li>
        <li>来源:本地上传 或 使用当前画布图;上传的全景图同样持久化保存,可重复选用。</li>
        <li>应用后作为内翻球背景,网格地面会隐藏;可随时「清除全景」恢复网格。</li>
      </ul>
    </div>
  );
}

/** 全景图导入 popover(本地上传 / 使用画布图 / 我的全景 / 清除). */
function PanoramaImport({
  imageUrl,
  assets,
  onUploadFile,
  onUseCanvas,
  onPick,
  onDelete,
  onClear,
  onClose,
}: {
  imageUrl?: string;
  assets: DirectorAsset[];
  onUploadFile: (f: File) => void;
  onUseCanvas: () => void;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div style={styles.panoBackdrop} onClick={onClose} />
      <div style={styles.panoPop}>
        <div style={styles.panoHead}>
          <span>全景图导入</span>
          <button style={styles.miniX} onClick={onClose}>
            ×
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={PANORAMA_EXTS.map((e) => '.' + e).join(',')}
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onUploadFile(f);
            if (fileRef.current) fileRef.current.value = '';
          }}
        />
        <div style={styles.panoActions}>
          <button style={styles.panoBtn} onClick={() => fileRef.current?.click()}>
            ⬆ 本地上传
          </button>
          {imageUrl && (
            <button style={styles.panoBtn} onClick={onUseCanvas}>
              🖼 使用画布图
            </button>
          )}
          <button style={styles.panoBtnGhost} onClick={onClear}>
            清除全景
          </button>
        </div>
        {assets.length > 0 && (
          <>
            <div style={styles.panoSub}>我的全景</div>
            <div style={styles.panoGrid}>
              {assets.map((a) => (
                <div key={a.id} style={styles.mineCell}>
                  <button
                    style={styles.panoThumbBtn}
                    title={`${a.name} · ${formatBytes(a.size)}`}
                    onClick={() => onPick(a.id)}
                  >
                    {a.thumb ? (
                      <img src={a.thumb} alt={a.name} style={styles.panoThumb} />
                    ) : (
                      <div style={{ ...styles.panoThumb, display: 'grid', placeItems: 'center' }}>
                        🌐
                      </div>
                    )}
                  </button>
                  <button style={styles.mineDel} title="删除" onClick={() => onDelete(a.id)}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <ImportHints kind="panorama" />
      </div>
    </>
  );
}

/* ── Styles ─────────────────────────────────────────────────────── */

const styles: Record<string, React.CSSProperties> = {
  shell: {
    width: '92vw',
    height: '88vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#0f1116',
    border: '1px solid #2a2e38',
    borderRadius: 12,
    overflow: 'hidden',
    color: '#e5e7eb',
    fontSize: 13,
  },
  header: {
    height: 44,
    flex: '0 0 44px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '0 12px',
    borderBottom: '1px solid #2a2e38',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 12 },
  ghostBtn: {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: '#9aa3b2',
    fontSize: 22,
    lineHeight: 1,
    cursor: 'pointer',
  },
  body: { flex: 1, position: 'relative', display: 'flex', minHeight: 0 },
  viewport: { flex: 1, position: 'relative', minWidth: 0 },
  // 真实机位全屏:脱离布局,铺满整个窗口(ResizeObserver 会把 stage 同步放大)
  viewportFull: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    minWidth: 0,
    background: '#14161c',
  },
  camDock: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    width: 220,
    padding: 8,
    background: 'rgba(15,17,22,0.7)',
    borderRadius: 8,
    backdropFilter: 'blur(4px)',
  },
  // ── 动画播放条(视口底部中央,有活动动画时显示) ──
  animBar: {
    position: 'absolute',
    left: '50%',
    bottom: 12,
    transform: 'translateX(-50%)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: 'min(520px, calc(100% - 500px))',
    minWidth: 320,
    padding: '6px 10px',
    background: 'rgba(15,17,22,0.8)',
    border: '1px solid #333a46',
    borderRadius: 8,
    backdropFilter: 'blur(4px)',
    zIndex: 5,
  },
  animBarName: {
    maxWidth: 110,
    fontSize: 12,
    color: '#22d3ee',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 0,
  },
  animBarTime: {
    fontSize: 11,
    color: '#9aa3b2',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  animSelect: {
    width: '100%',
    marginBottom: 6,
    padding: '6px 8px',
    background: '#12141a',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    fontSize: 12,
  },
  animSearch: {
    width: '100%',
    boxSizing: 'border-box',
    marginBottom: 8,
    padding: '6px 8px',
    background: '#12141a',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    fontSize: 12,
  },
  sidePanel: {
    position: 'absolute',
    top: 12,
    width: 232,
    maxHeight: 'calc(100% - 24px)',
    overflowY: 'auto',
    padding: 12,
    borderRadius: 10,
    border: '1px solid #2a2e38',
    zIndex: 5,
  },
  leftStack: {
    position: 'absolute',
    top: 12,
    left: 12,
    width: 232,
    maxHeight: 'calc(100% - 24px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    zIndex: 5,
    minHeight: 0,
  },
  leftBox: {
    flex: '1 1 auto',
    minHeight: 0,
    overflowY: 'auto',
    padding: 12,
    borderRadius: 10,
    border: '1px solid #2a2e38',
  },
  objPanel: {
    flex: '0 0 auto',
    borderRadius: 10,
    border: '1px solid #2a2e38',
    overflow: 'hidden',
  },
  objHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 12px',
    background: 'none',
    border: 'none',
    color: '#22d3ee',
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
  },
  objCount: {
    fontSize: 11,
    fontWeight: 600,
    color: '#0b0d12',
    background: '#22d3ee',
    borderRadius: 999,
    padding: '0 7px',
    lineHeight: '16px',
  },
  objList: { maxHeight: 200, overflowY: 'auto', padding: '0 8px 8px' },
  objEmpty: { fontSize: 11, color: '#6b7280', padding: '6px 4px 10px', lineHeight: 1.5 },
  objRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 6,
    cursor: 'pointer',
    color: '#9aa3b2',
  },
  objRowActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 6,
    cursor: 'pointer',
    color: '#e6edf6',
    background: '#22d3ee18',
    border: '1px solid #22d3ee55',
  },
  objIcon: { color: '#22d3ee', fontSize: 10 },
  objName: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 },
  objDel: { background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 15, lineHeight: 1 },
  panelTitle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: '#22d3ee',
    fontWeight: 700,
    marginBottom: 8,
  },
  section: { fontSize: 11, color: '#7c8696', margin: '10px 0 4px', borderTop: '1px solid #23262f', paddingTop: 8 },
  fxRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '6px 0', cursor: 'pointer' },
  fxRowLabel: { fontSize: 12, color: '#9aa3b2' },
  fxSelect: { background: 'rgba(255,255,255,0.06)', border: '1px solid #333a46', color: '#cdd3dd', borderRadius: 6, padding: '3px 6px', fontSize: 12 },
  miniX: { background: 'none', border: 'none', color: '#7c8696', cursor: 'pointer', fontSize: 16 },
  tabRow: { display: 'flex', gap: 6, marginBottom: 8 },
  tab: { flex: 1, padding: '6px 0', background: 'rgba(255,255,255,0.04)', border: '1px solid #333a46', color: '#9aa3b2', borderRadius: 6, cursor: 'pointer' },
  tabActive: { flex: 1, padding: '6px 0', background: '#22d3ee22', border: '1px solid #22d3ee', color: '#22d3ee', borderRadius: 6, cursor: 'pointer' },
  hint: { fontSize: 12, color: '#7c8696', lineHeight: 1.6, padding: '12px 4px' },
  poseToolRow: { display: 'flex', gap: 6, marginBottom: 8 },
  poseBackBtn: {
    width: '100%',
    background: '#22d3ee18',
    border: '1px solid #22d3ee66',
    color: '#22d3ee',
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'pointer',
    fontSize: 12,
    marginBottom: 8,
  },
  boneList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    maxHeight: 320,
    overflowY: 'auto',
    borderTop: '1px solid #23262f',
    paddingTop: 6,
  },
  boneRow: {
    textAlign: 'left',
    background: 'transparent',
    border: '1px solid transparent',
    color: '#9aa3b2',
    borderRadius: 4,
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  boneRowActive: {
    textAlign: 'left',
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    color: '#22d3ee',
    borderRadius: 4,
    padding: '4px 8px',
    cursor: 'pointer',
    fontSize: 11,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  toolbar: {
    flex: '0 0 auto',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
    padding: '8px 12px',
    borderTop: '1px solid #2a2e38',
    background: '#12141a',
  },
  toolBtn: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  toolBtnActive: {
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    color: '#22d3ee',
    borderRadius: 6,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  toolBtnDisabled: {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid #232934',
    color: '#5a626f',
    borderRadius: 6,
    padding: '6px 10px',
    cursor: 'default',
    fontSize: 12,
    whiteSpace: 'nowrap',
  },
  sep: { width: 1, height: 20, background: '#2a2e38', margin: '0 4px' },
  resWrap: { position: 'relative', display: 'inline-block' },
  resMenu: {
    position: 'absolute',
    bottom: '110%',
    left: 0,
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 8,
    padding: 4,
    minWidth: 120,
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  resItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    background: 'none',
    border: 'none',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  resItemActive: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    color: '#22d3ee',
    borderRadius: 6,
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  resPx: { fontSize: 10, opacity: 0.6 },
  shortcutOverlay: {
    position: 'absolute',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 40,
  },
  shortcutCard: {
    width: 320,
    background: '#1a1c22',
    border: '1px solid #2a2e38',
    borderRadius: 12,
    padding: 16,
    boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
  },
  shortcutTitle: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: '#22d3ee',
    fontWeight: 700,
    marginBottom: 10,
  },
  shortcutRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0' },
  kbd: {
    minWidth: 90,
    textAlign: 'center',
    fontSize: 11,
    color: '#e6edf6',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid #333a46',
    borderRadius: 6,
    padding: '3px 8px',
  },
  shortcutDesc: { fontSize: 12, color: '#9aa3b2' },
  shortcutHint: { fontSize: 11, color: '#6b7280', margin: '2px 0 6px' },
  shortcutSep: { height: 1, background: '#2a2e38', margin: '10px 0 6px' },
  resetKeyBtn: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '3px 8px',
    cursor: 'pointer',
    fontSize: 11,
    marginRight: 8,
  },
  keyBtn: {
    minWidth: 100,
    textAlign: 'center',
    fontSize: 11,
    color: '#e6edf6',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid #333a46',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
  },
  keyBtnCapturing: {
    minWidth: 100,
    textAlign: 'center',
    fontSize: 11,
    color: '#22d3ee',
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
  },
  lensMenu: {
    position: 'absolute',
    bottom: '110%',
    left: 0,
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 8,
    padding: 4,
    minWidth: 140,
    zIndex: 20,
  },
  lensItem: {
    display: 'flex',
    justifyContent: 'space-between',
    width: '100%',
    background: 'none',
    border: 'none',
    color: '#cbd2dd',
    padding: '6px 10px',
    cursor: 'pointer',
    fontSize: 12,
    borderRadius: 4,
  },
  libraryPop: {
    position: 'absolute',
    bottom: '110%',
    left: 0,
    width: 440,
    height: 'auto',
    maxHeight: '74vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 10,
    zIndex: 20,
    overflow: 'hidden',
  },
  libraryHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #2a2e38' },
  libraryTabs: { display: 'flex', gap: 4, padding: 8, flexWrap: 'wrap', borderBottom: '1px solid #2a2e38' },
  libTab: { background: 'rgba(255,255,255,0.05)', border: '1px solid #333a46', color: '#9aa3b2', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11 },
  libTabActive: { background: '#22d3ee22', border: '1px solid #22d3ee', color: '#22d3ee', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 11 },
  libraryGrid: { flex: 1, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: 10 },
  libCell: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, background: 'rgba(255,255,255,0.03)', border: '1px solid #2a2e38', borderRadius: 8, padding: 6, cursor: 'pointer' },
  libThumb: { width: '100%', aspectRatio: '1', objectFit: 'cover', borderRadius: 6, background: '#0f1116' },
  libName: { fontSize: 11, color: '#cbd2dd', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' },

  // 本地导入 / 我的模型
  uploadBtn: {
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    color: '#22d3ee',
    borderRadius: 6,
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  uploadTile: {
    display: 'grid',
    placeItems: 'center',
    aspectRatio: '1',
    background: 'rgba(255,255,255,0.02)',
    border: '1px dashed #3a414e',
    borderRadius: 8,
    color: '#7c8696',
    cursor: 'pointer',
  },
  mineCell: { position: 'relative' },
  mineDel: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    lineHeight: '16px',
    textAlign: 'center',
    background: 'rgba(0,0,0,0.6)',
    border: '1px solid #444',
    borderRadius: 4,
    color: '#e5e7eb',
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
  },
  emptyHint: { fontSize: 12, color: '#7c8696', textAlign: 'center', padding: '4px 10px' },
  hintBox: {
    flex: '0 0 auto',
    borderTop: '1px solid #2a2e38',
    background: 'rgba(255,255,255,0.02)',
    padding: '8px 12px',
    overflowY: 'auto',
    maxHeight: 190,
  },
  hintTitle: { fontSize: 11, color: '#8b94a2', marginBottom: 4, letterSpacing: 1 },
  hintList: { margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.7, color: '#9aa3b2' },

  // 全景图导入 popover
  panoBackdrop: { position: 'fixed', inset: 0, zIndex: 19 },
  panoPop: {
    position: 'absolute',
    top: '110%',
    left: 0,
    width: 360,
    maxHeight: '70vh',
    display: 'flex',
    flexDirection: 'column',
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 10,
    zIndex: 20,
    overflow: 'hidden',
  },
  panoHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderBottom: '1px solid #2a2e38' },
  panoActions: { display: 'flex', gap: 8, padding: 10, flexWrap: 'wrap' },
  panoBtn: { background: '#22d3ee22', border: '1px solid #22d3ee', color: '#22d3ee', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12 },
  panoBtnGhost: { background: 'rgba(255,255,255,0.06)', border: '1px solid #333a46', color: '#cbd2dd', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', fontSize: 12 },
  panoSub: { fontSize: 11, color: '#8b94a2', padding: '0 12px' },
  panoGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, padding: 10 },
  panoThumbBtn: { padding: 0, background: 'none', border: 'none', cursor: 'pointer', width: '100%' },
  panoThumb: { width: '100%', aspectRatio: '2 / 1', objectFit: 'cover', borderRadius: 6, background: '#0f1116', border: '1px solid #2a2e38' },

  // 高级假人 弹出
  mannPop: {
    position: 'absolute',
    bottom: '110%',
    left: 0,
    width: 220,
    background: '#1f232b',
    border: '1px solid #333a46',
    borderRadius: 10,
    padding: 12,
    zIndex: 20,
    boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
  },
  mannTitle: { fontSize: 12, color: '#9aa3b2', marginBottom: 8 },
  mannSeg: { display: 'flex', gap: 6, marginBottom: 10, background: '#15171d', borderRadius: 8, padding: 3 },
  mannSegBtn: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    background: 'transparent',
    border: 'none',
    color: '#9aa3b2',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
  },
  mannSegActive: {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    background: '#2a2f3a',
    border: '1px solid #3a4150',
    color: '#e6edf6',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
  },
  mannDot: { width: 10, height: 10, borderRadius: 999, display: 'inline-block' },
  // 普通假人 阵列
  crowdSeg: { display: 'flex', gap: 4, marginBottom: 10, background: '#15171d', borderRadius: 8, padding: 3 },
  crowdSegBtn: {
    flex: 1,
    background: 'transparent',
    border: 'none',
    color: '#9aa3b2',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
  },
  crowdSegActive: {
    flex: 1,
    background: '#2a2f3a',
    border: '1px solid #3a4150',
    color: '#e6edf6',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
  },
  crowdRow: { display: 'flex', gap: 10, marginBottom: 10 },
  mannAdd: {
    width: '100%',
    border: 'none',
    color: '#fff',
    borderRadius: 8,
    padding: '9px 0',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
  },

  // 姿态预设 网格
  poseGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 6,
    marginBottom: 4,
  },
  posePreset: {
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  posePresetActive: {
    background: '#2f5fb0',
    border: '1px solid #4f7fd0',
    color: '#fff',
    borderRadius: 6,
    padding: '6px 0',
    cursor: 'pointer',
    fontSize: 12,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },

  // 姿势调节 分组
  boneGroup: { marginBottom: 6 },
  boneGroupHead: {
    width: '100%',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid #2a2e38',
    color: '#9fb4e0',
    borderRadius: 6,
    padding: '7px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  boneCard: {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid #23262f',
    borderRadius: 8,
    padding: '8px 10px',
    margin: '6px 0',
  },
  boneCardHead: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: 12,
    color: '#cbd2dd',
    marginBottom: 4,
  },
  boneReset: {
    background: 'none',
    border: '1px solid #333a46',
    color: '#7c8696',
    borderRadius: 5,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
  },
  boneResetActive: {
    background: '#22d3ee18',
    border: '1px solid #22d3ee66',
    color: '#22d3ee',
    borderRadius: 5,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
  },
  axisBadge: {
    width: 18,
    height: 18,
    borderRadius: 4,
    color: '#fff',
    fontSize: 11,
    fontWeight: 700,
    display: 'grid',
    placeItems: 'center',
  },
  // ── 机位 + 录制面板 ──
  camPanel: {
    position: 'absolute',
    bottom: '110%',
    right: 0,
    width: 260,
    background: '#1a1c22',
    border: '1px solid #333a46',
    borderRadius: 10,
    padding: 10,
    zIndex: 30,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    boxShadow: '0 8px 28px rgba(0,0,0,0.45)',
  },
  camHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    color: '#e5e9f0',
    fontSize: 12,
    fontWeight: 600,
  },
  camAddBtn: {
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    color: '#22d3ee',
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'pointer',
    fontSize: 12,
  },
  camList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    maxHeight: 140,
    overflowY: 'auto',
  },
  camEmpty: { color: '#6b7480', fontSize: 11, padding: '6px 2px' },
  camRow: { display: 'flex', alignItems: 'center', gap: 4 },
  camApply: {
    flex: 1,
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '6px 8px',
    cursor: 'pointer',
    fontSize: 12,
  },
  camFov: { opacity: 0.5, fontSize: 11 },
  camDel: {
    background: 'none',
    border: '1px solid #3a2730',
    color: '#d77',
    borderRadius: 6,
    width: 24,
    height: 28,
    cursor: 'pointer',
    fontSize: 14,
  },
  recBox: {
    borderTop: '1px solid #2a2f3a',
    paddingTop: 8,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  recTitle: { color: '#e5e9f0', fontSize: 12, fontWeight: 600 },
  recRow: { display: 'flex', alignItems: 'center', gap: 8 },
  recLbl: { color: '#8b94a2', fontSize: 11, width: 36, flexShrink: 0 },
  recSlider: { flex: 1 },
  recVal: { color: '#cbd2dd', fontSize: 11, width: 30, textAlign: 'right' },
  recResVal: { color: '#cbd2dd', fontSize: 11 },
  recSeg: { display: 'flex', gap: 4, flex: 1 },
  recSegBtn: {
    flex: 1,
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '4px 0',
    cursor: 'pointer',
    fontSize: 11,
  },
  recSegActive: {
    flex: 1,
    background: '#22d3ee22',
    border: '1px solid #22d3ee',
    color: '#22d3ee',
    borderRadius: 6,
    padding: '4px 0',
    cursor: 'pointer',
    fontSize: 11,
  },
  recBtn: {
    background: '#e0483d',
    border: 'none',
    color: '#fff',
    borderRadius: 6,
    padding: '7px 0',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
    marginTop: 2,
  },
  recBtnBusy: {
    background: '#3a2a2a',
    border: '1px solid #e0483d',
    color: '#e0a',
    borderRadius: 6,
    padding: '7px 0',
    cursor: 'default',
    fontSize: 12,
    fontWeight: 600,
    marginTop: 2,
  },
};
