import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useDragPanel } from './useDragPanel';

interface Props {
  stageRef: React.RefObject<DirectorStageHandle | null>;
  onExit: () => void;
  onExported: (r: RecordResult) => void;
}

const ASPECTS = ['16:9', '9:16', '1:1', '4:3'] as const;
type Aspect = (typeof ASPECTS)[number];
const ASPECT_RATIO: Record<Aspect, number> = { '16:9': 16 / 9, '9:16': 9 / 16, '1:1': 1, '4:3': 4 / 3 };
const DURATION_SEC = 8; // 实站默认时长

const RES_LABEL: Record<CaptureResolution, string> = { '1080p': 'FHD', '2k': '2K', '4k': '4K' };

/**
 * 录制视频 = 关键帧相机运镜时间轴 — 复刻实站:
 * 左上 Preview 面板 + 中央 16:9 安全框 + 底部 Timeline(F 加关键帧 / 插值 / 导出)。
 */
export default function DirectorRecordTimeline({ stageRef, onExit, onExported }: Props) {
  const [keys, setKeys] = useState<CameraKeyframe[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [aspect, setAspect] = useState<Aspect>('16:9');
  const [playing, setPlaying] = useState(false);
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [res, setRes] = useState<CaptureResolution>('1080p');
  const [fps, setFps] = useState<RecordFps>(RECORD_FPS_DEFAULT);
  const [quality, setQuality] = useState<RecordQualityKey>(RECORD_QUALITY_DEFAULT);
  const stopRef = useRef<(() => void) | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
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

  // Live preview thumbnail of the current camera.
  useEffect(() => {
    const cv = previewRef.current;
    if (cv) {
      cv.width = 240;
      cv.height = 135;
    }
    const draw = () => stageRef.current?.renderSlotPreview(null, previewRef.current!);
    const t = setInterval(() => {
      if (previewRef.current) draw();
    }, 200);
    return () => clearInterval(t);
  }, [stageRef]);

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
      const clamped = Math.max(0, Math.min(DURATION_SEC, t));
      setPlayhead(clamped);
      stageRef.current?.recordSeek(clamped);
    },
    [stageRef],
  );

  const onRailClick = (e: React.MouseEvent) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seekTo(ratio * DURATION_SEC);
  };

  const togglePlay = useCallback(() => {
    if (playing) {
      stopRef.current?.();
      setPlaying(false);
      return;
    }
    if (keys.length === 0) return;
    setPlaying(true);
    stopRef.current = stageRef.current!.recordPlay(
      DURATION_SEC,
      (t) => setPlayhead(t),
      () => setPlaying(false),
    );
  }, [keys.length, playing, stageRef]);

  const doExport = useCallback(async () => {
    const stage = stageRef.current;
    if (!stage || keys.length < 1) return;
    setShowExport(false);
    setExportPct(0);
    try {
      const r = await stage.recordExport({
        durationSec: DURATION_SEC,
        resolution: res,
        fps,
        quality,
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

  return (
    <div style={styles.overlay}>
      {/* 中央 16:9 安全框 */}
      <div style={styles.frameArea}>
        <div style={{ ...styles.safeFrame, aspectRatio: String(ASPECT_RATIO[aspect]) }} />
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
          <select
            style={styles.aspectSel}
            value={aspect}
            onChange={(e) => setAspect(e.target.value as Aspect)}
          >
            {ASPECTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
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
          >
            {playing ? '⏸ 暂停' : '▷ 预览'}
          </button>
          <span style={{ flex: 1 }} />
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

        {/* 时间尺 + 关键帧 + 游标 */}
        <div style={styles.rail} ref={railRef} onMouseDown={onRailClick}>
          {Array.from({ length: DURATION_SEC + 1 }, (_, i) => (
            <span key={i} style={{ ...styles.tick, left: `${(i / DURATION_SEC) * 100}%` }}>
              {i}s
            </span>
          ))}
          {keys.map((k) => (
            <span
              key={k.id}
              style={{ ...styles.kf, left: `${(k.t / DURATION_SEC) * 100}%` }}
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
          <span style={{ ...styles.playhead, left: `${(playhead / DURATION_SEC) * 100}%` }}>
            <span style={styles.playheadLabel}>{playhead.toFixed(1)}s</span>
          </span>
        </div>
      </div>

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
  overlay: { position: 'absolute', inset: 0, zIndex: 40, pointerEvents: 'none' },
  frameArea: {
    position: 'absolute',
    inset: '56px 0 130px 0',
    display: 'grid',
    placeItems: 'center',
  },
  safeFrame: {
    width: '58%',
    maxHeight: '92%',
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
    overflow: 'hidden',
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
  aspectSel: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 5,
    fontSize: 11,
    padding: '1px 4px',
  },
  xBtn: { background: 'none', border: 'none', color: '#8b94a2', cursor: 'pointer', fontSize: 14 },
  previewBody: { position: 'relative', lineHeight: 0 },
  previewCanvas: { width: '100%', display: 'block', background: '#0c0e12' },
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
  rail: {
    position: 'relative',
    height: 34,
    background: '#0f1116',
    border: '1px solid #262b34',
    borderRadius: 6,
    cursor: 'pointer',
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
