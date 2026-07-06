import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CameraKeyframe,
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

/** 拖拽 payload 的 dataTransfer 类型(预设 / 我的镜头 → 时间轴)。 */
const CLIP_DND_MIME = 'application/x-director-camera-clip';

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
  const previewRef = useRef<HTMLCanvasElement>(null);
  // 镜头库弹层(预设 / 我的镜头 / 导入导出)
  const [showClips, setShowClips] = useState(false);
  const [myClips, setMyClips] = useState<DirectorAsset[]>([]);
  const [clipMsg, setClipMsg] = useState<string | null>(null);
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
    setKeys(stageRef.current?.recordListKeyframes() ?? []);
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
      const r = aspectRatioOf(aspect) ?? 16 / 9; // 全屏时缩略图保持 16:9
      let w = 240;
      let h = Math.round(240 / r);
      if (h > 240) {
        h = 240;
        w = Math.max(2, Math.round(240 * r));
      }
      cv.width = w;
      cv.height = h;
    }
    const draw = () => stageRef.current?.renderSlotPreview(null, previewRef.current!);
    const t = setInterval(() => {
      if (previewRef.current) draw();
    }, 200);
    return () => clearInterval(t);
  }, [aspect, stageRef]);

  const addKeyframe = useCallback(() => {
    stageRef.current?.recordAddKeyframe(playhead);
    refresh();
  }, [playhead, refresh, stageRef]);

  // F = add keyframe at playhead.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'f' || e.key === 'F') && !e.repeat) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        addKeyframe();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addKeyframe]);

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

  // 预设/我的镜头可拖到时间尺:落点时刻 = 插入起始时间(关键帧全部可编辑)。
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
      const p = JSON.parse(raw) as { preset?: CameraPresetId; assetId?: string };
      if (p.preset) applyPreset(p.preset, t);
      else if (p.assetId) void applyAssetClip(p.assetId, t);
    } catch {
      // 非本组件的拖拽 payload,忽略。
    }
  };

  /** 时长可调:不小于最后一个关键帧时间(否则关键帧会掉出时间轴)。 */
  const changeDuration = useCallback(
    (v: number) => {
      if (!Number.isFinite(v)) return;
      const lastT = keys.length ? keys[keys.length - 1].t : 0;
      const d = Math.max(DUR_MIN, Math.max(Math.ceil(lastT), Math.min(DUR_MAX, v)));
      setDuration(d);
      setPlayhead((p) => Math.min(p, d));
    },
    [keys],
  );

  // ── 镜头库:预设 / 我的镜头 / 导入(json/glb/gltf/fbx)/ 导出 ──────
  const flashClip = useCallback((m: string) => {
    setClipMsg(m);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setClipMsg(null), 2600);
  }, []);
  useEffect(() => () => {
    if (msgTimer.current) clearTimeout(msgTimer.current);
  }, []);

  const loadMyClips = useCallback(() => {
    listAssets('camera')
      .then(setMyClips)
      .catch(() => setMyClips([]));
  }, []);
  useEffect(() => {
    if (showClips) loadMyClips();
  }, [loadMyClips, showClips]);

  /** 把镜头关键帧装入时间轴(覆盖 / 拖入落点),必要时自动加长时间轴。 */
  const loadKeys = useCallback(
    (ks: readonly CameraKeyframe[], mode: 'replace' | 'append', atSec?: number) => {
      const all = stageRef.current?.recordLoadKeyframes(ks, mode, atSec) ?? [];
      const lastT = all.length ? all[all.length - 1].t : 0;
      if (lastT > duration) setDuration(Math.min(DUR_MAX, Math.ceil(lastT)));
      refresh();
    },
    [duration, refresh, stageRef],
  );

  const applyPreset = useCallback(
    (id: CameraPresetId, atSec?: number) => {
      const st = stageRef.current;
      if (!st) return;
      const ks = buildCameraPreset(id, st.getCameraPose());
      loadKeys(ks, atSec != null ? 'append' : 'replace', atSec);
      flashClip(atSec != null ? '预设已插入时间轴落点' : '预设已应用(覆盖原关键帧)');
    },
    [flashClip, loadKeys, stageRef],
  );

  const applyAssetClip = useCallback(
    async (id: string, atSec?: number) => {
      try {
        const asset = await getAsset(id);
        if (!asset) return;
        const parsed = parseCameraClipJson(await asset.blob.text());
        loadKeys(parsed.keys, atSec != null ? 'append' : 'replace', atSec);
        flashClip(`已装入「${asset.name}」(${parsed.keys.length} 关键帧)`);
      } catch (err) {
        console.error('[director] load camera clip failed', err);
        flashClip('镜头装入失败');
      }
    },
    [flashClip, loadKeys],
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
        loadKeys(r.keys, 'replace');
        flashClip(`已导入「${clipName}」(${r.keys.length} 关键帧)`);
      } catch (err) {
        console.error('[director] import camera clip failed', err);
        flashClip(err instanceof Error ? err.message : '镜头导入失败');
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [flashClip, loadKeys, loadMyClips, stageRef],
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
    async (fmt: 'json' | 'vmd' | 'glb') => {
      if (keys.length === 0) return;
      const stamp = new Date().toISOString().slice(0, 10);
      try {
        if (fmt === 'json') {
          downloadBlob(
            new Blob([cameraClipToJson(keys, 'director-camera')], { type: 'application/json' }),
            `camera-clip-${stamp}.json`,
          );
        } else if (fmt === 'vmd') {
          downloadBlob(
            new Blob([cameraKeysToVmd(keys)], { type: 'application/octet-stream' }),
            `camera-clip-${stamp}.vmd`,
          );
        } else {
          downloadBlob(
            new Blob([await cameraKeysToGlb(keys)], { type: 'model/gltf-binary' }),
            `camera-clip-${stamp}.glb`,
          );
        }
        flashClip(`已导出 .${fmt}`);
      } catch (err) {
        console.error('[director] export camera clip failed', err);
        flashClip('镜头导出失败');
      }
    },
    [downloadBlob, flashClip, keys],
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

  // 预览/导出只覆盖关键帧首→末区间,不含前后空白段。
  const tStart = keys.length ? keys[0].t : 0;
  const tEnd = keys.length ? keys[keys.length - 1].t : 0;

  const togglePlay = useCallback(() => {
    if (playing) {
      stopRef.current?.();
      setPlaying(false);
      return;
    }
    if (keys.length === 0) return;
    setPlaying(true);
    stopRef.current = stageRef.current!.recordPlay(
      tStart,
      tEnd,
      (t) => setPlayhead(t),
      () => setPlaying(false),
      loopPreview,
    );
  }, [keys.length, loopPreview, playing, stageRef, tEnd, tStart]);

  /** 切换循环预览;正在播时就地按新模式重启,不用先暂停。 */
  const toggleLoop = useCallback(() => {
    const next = !loopPreview;
    setLoopPreview(next);
    if (playing) {
      stopRef.current?.();
      stopRef.current = stageRef.current!.recordPlay(
        tStart,
        tEnd,
        (t) => setPlayhead(t),
        () => setPlaying(false),
        next,
      );
    }
  }, [loopPreview, playing, stageRef, tEnd, tStart]);

  const doExport = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || keys.length < 1) return;
    setShowExport(false);
    setExportPct(0);
    try {
      const r = await stage.recordExport({
        // 0 = 按关键帧首→末跨度 1:1 实时导出(recordKeyframeAnimation 语义),
        // 导出时长与时间轴严格一致,不再拉伸到固定 8s。
        durationSec: 0,
        resolution: res,
        fps,
        quality,
        // 与机位共用的画幅比例;null = 全屏(跟随画布,不裁剪)。
        aspect: aspectRatioOf(aspect),
        onProgress: (p) => setExportPct(p),
      });
      onExported(r);
    } catch (err) {
      console.error('[director] export failed', err);
    } finally {
      setExportPct(null);
    }
  }, [fps, keys.length, onExported, quality, res, stageRef]);

  const hasKeys = keys.length > 0;
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
      <div style={{ ...styles.preview, left: previewDrag.pos.x, top: previewDrag.pos.y }}>
        <div
          title="拖动移动面板"
          style={{ ...styles.previewHead, ...previewDrag.handleProps.style, userSelect: 'none' }}
          onPointerDown={previewDrag.handleProps.onPointerDown}
          onPointerMove={previewDrag.handleProps.onPointerMove}
          onPointerUp={previewDrag.handleProps.onPointerUp}
        >
          <span style={styles.previewTitle}>⠿ Preview</span>
          <AspectSelect value={aspect} onChange={setAspect} openUp={false} />
          <button style={styles.xBtn} onClick={onExit} title="关闭">
            ×
          </button>
        </div>
        <div style={styles.previewBody}>
          <canvas ref={previewRef} style={styles.previewCanvas} />
          {!hasKeys && (
            <div style={styles.previewEmpty}>
              <div style={{ color: '#cbd2dd', fontSize: 13 }}>暂无关键帧</div>
              <div style={{ color: '#6b7480', fontSize: 11, marginTop: 4 }}>
                按 F 在当前位置添加关键帧
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 底部 Timeline */}
      <div style={styles.timeline}>
        <div style={styles.tlTop}>
          <span style={styles.tlName}>Timeline 1</span>
          <button style={styles.kfBtn} onClick={addKeyframe}>
            ◆ 在游标处添加关键帧 (F)
          </button>
          <button
            style={hasKeys ? styles.tlBtn : styles.tlBtnDisabled}
            onClick={togglePlay}
            disabled={!hasKeys}
            title={
              hasKeys
                ? `预览关键帧区间 ${tStart.toFixed(1)}s → ${tEnd.toFixed(1)}s${loopPreview ? '(循环)' : ''}`
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
                <div style={{ color: '#8b94a2', fontSize: 11 }}>
                  导出时长 = 关键帧区间 {clipSec.toFixed(1)}s
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

        {/* 时间尺 + 关键帧区间高亮 + 关键帧 + 游标(接受镜头拖入) */}
        <div
          style={styles.rail}
          ref={railRef}
          onMouseDown={onRailClick}
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
          {ticks.map((t) => (
            <span key={t} style={{ ...styles.tick, left: `${(t / duration) * 100}%` }}>
              {t}s
            </span>
          ))}
          {keys.map((k) => (
            <span
              key={k.id}
              style={{ ...styles.kf, left: `${(k.t / duration) * 100}%` }}
              title={`关键帧 @ ${k.t.toFixed(1)}s — 双击删除`}
              onMouseDown={(e) => {
                e.stopPropagation();
                seekTo(k.t);
              }}
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
  rail: {
    position: 'relative',
    height: 34,
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
  kf: {
    position: 'absolute',
    bottom: 2,
    transform: 'translateX(-50%)',
    color: '#e6c84a',
    fontSize: 13,
    cursor: 'pointer',
    lineHeight: 1,
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
