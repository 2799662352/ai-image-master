import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnimTick, DirectorStageHandle } from './DirectorStageScene';
import {
  buildPoseClip,
  clipToExportJson,
  newKeyframeId,
  type PoseKeyframe,
} from './directorPoseClip';
import { putAsset } from './directorAssetStore';

/** 预览剪辑固定名 —— 用于从 AnimTick 识别「正在播的是本时间轴的预览」。 */
const CLIP_NAME = 'K动画预览';
const DUR_DEFAULT = 8;
const DUR_MIN = 1;
const DUR_MAX = 60;
/** 同一时刻打点视为覆盖更新的时间容差(秒)。 */
const T_EPS = 0.05;

interface Props {
  stageRef: React.RefObject<DirectorStageHandle | null>;
  /** 场景动画进度回传(编辑器已有的 animTick 透传;用于同步游标/播放态). */
  animTick: AnimTick | null;
  /** 当前选中是否高级假人(非高级假人时禁用打点/预览). */
  isAdvanced: boolean;
  onClose: () => void;
  /** 「保存到我的动画」成功后回调(编辑器刷新我的动画列表). */
  onSaved: () => void;
}

/**
 * K 动画:姿势关键帧时间轴(底部面板)。
 * 交互语言对齐录制时间轴(RunningHub 同款):F 在游标处打点 /「更新选中关键帧到
 * 当前姿势」/ 双击删点 / Space 预览 / 时长可调;摆姿用右栏现有姿势系统。
 * 数据(关键帧集合)由本组件持有;取样/编译/播放/导出由场景 handle 提供。
 */
export default function DirectorPoseTimeline({
  stageRef,
  animTick,
  isAdvanced,
  onClose,
  onSaved,
}: Props) {
  const [keys, setKeys] = useState<PoseKeyframe[]>([]);
  const [duration, setDuration] = useState(DUR_DEFAULT);
  const [playhead, setPlayhead] = useState(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [name, setName] = useState(`K动画-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const railRef = useRef<HTMLDivElement>(null);
  /** 关键帧/时长改动后置脏:下次播放/scrub 重新编译剪辑。 */
  const dirtyRef = useRef(true);

  /** 当前场景里播的是否本时间轴的预览剪辑。 */
  const previewActive = animTick?.name === CLIP_NAME;
  const playing = previewActive && animTick.playing;

  // 播放中把场景回传的时间同步到游标(循环播放 → 取模)。
  useEffect(() => {
    if (previewActive) setPlayhead(animTick.time % Math.max(duration, 0.001));
  }, [animTick, previewActive, duration]);

  const sorted = useMemo(() => [...keys].sort((a, b) => a.t - b.t), [keys]);
  const hasKeys = keys.length > 0;
  const canPreview = sorted.length >= 2;

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 2200);
  }, []);

  const mutateKeys = useCallback((fn: (prev: PoseKeyframe[]) => PoseKeyframe[]) => {
    dirtyRef.current = true;
    setKeys(fn);
  }, []);

  /** ◆ 在游标处记录当前姿势(同 t 覆盖更新)。 */
  const record = useCallback(() => {
    const snap = stageRef.current?.capturePoseKeyframe();
    if (!snap) {
      flash('请先选中一个高级假人');
      return;
    }
    const t = Math.min(playhead, duration);
    mutateKeys((prev) => {
      const hit = prev.find((k) => Math.abs(k.t - t) < T_EPS);
      if (hit) {
        setSelId(hit.id);
        return prev.map((k) => (k === hit ? { ...k, ...snap } : k));
      }
      const nk: PoseKeyframe = { id: newKeyframeId(), t, ...snap };
      setSelId(nk.id);
      return [...prev, nk];
    });
  }, [duration, flash, mutateKeys, playhead, stageRef]);

  /** 更新选中关键帧到当前姿势(RH「更新选中关键帧到当前相机」的姿势版)。 */
  const updateSelected = useCallback(() => {
    if (!selId) return;
    const snap = stageRef.current?.capturePoseKeyframe();
    if (!snap) return;
    mutateKeys((prev) => prev.map((k) => (k.id === selId ? { ...k, ...snap } : k)));
    flash('已更新关键帧姿势');
  }, [flash, mutateKeys, selId, stageRef]);

  const removeKey = useCallback(
    (id: string) => {
      mutateKeys((prev) => prev.filter((k) => k.id !== id));
      setSelId((cur) => (cur === id ? null : cur));
    },
    [mutateKeys],
  );

  /** 点关键帧 pill:停预览、套用该帧姿势(可继续用右栏摆姿后「更新」)。 */
  const selectKey = useCallback(
    (k: PoseKeyframe) => {
      setSelId(k.id);
      setPlayhead(k.t);
      stageRef.current?.applyPoseKeyframe(k);
    },
    [stageRef],
  );

  /** ▷/⏸ 预览:脏或未激活时重新编译播放;激活时切换暂停/继续。 */
  const togglePlay = useCallback(() => {
    const st = stageRef.current;
    if (!st || !canPreview) return;
    if (previewActive && !dirtyRef.current) {
      if (playing) st.pauseAnimation();
      else st.resumeAnimation();
      return;
    }
    dirtyRef.current = false;
    void st.playPoseClip(sorted, duration, CLIP_NAME).catch(() => flash('预览失败'));
  }, [canPreview, duration, flash, playing, previewActive, sorted, stageRef]);

  const stopPreview = useCallback(() => {
    if (previewActive) stageRef.current?.stopAnimation();
  }, [previewActive, stageRef]);

  /** 时间尺 scrub:移动游标;预览剪辑已激活且不脏时同步 seek(插值取样)。 */
  const seekTo = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t));
      setPlayhead(clamped);
      if (previewActive && !dirtyRef.current) stageRef.current?.seekAnimation(clamped);
    },
    [duration, previewActive, stageRef],
  );

  const onRailClick = (e: React.MouseEvent) => {
    const rail = railRef.current;
    if (!rail) return;
    const rect = rail.getBoundingClientRect();
    seekTo(((e.clientX - rect.left) / rect.width) * duration);
  };

  const jumpKey = useCallback(
    (dir: -1 | 1) => {
      if (sorted.length === 0) return;
      const next =
        dir > 0
          ? sorted.find((k) => k.t > playhead + T_EPS) ?? sorted[sorted.length - 1]
          : [...sorted].reverse().find((k) => k.t < playhead - T_EPS) ?? sorted[0];
      selectKey(next);
    },
    [playhead, selectKey, sorted],
  );

  const changeDuration = useCallback(
    (v: number) => {
      const lastT = sorted.length ? sorted[sorted.length - 1].t : 0;
      const d = Math.max(DUR_MIN, Math.max(lastT, Math.min(DUR_MAX, v)));
      dirtyRef.current = true;
      setDuration(d);
      setPlayhead((p) => Math.min(p, d));
    },
    [sorted],
  );

  // 快捷键:F 打点 / Space 预览(输入框聚焦时不响应)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.key === 'f' || e.key === 'F') && !e.repeat) record();
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [record, togglePlay]);

  // 关闭时停掉本时间轴的预览(恢复预览前姿势)。
  useEffect(() => stopPreview, [stopPreview]);

  const exportName = name.trim() || 'K动画';

  const doExportJson = useCallback(() => {
    try {
      const json = clipToExportJson(buildPoseClip(sorted, duration, exportName));
      downloadBlob(new Blob([json], { type: 'application/json' }), `${exportName}.json`);
    } catch {
      flash('导出失败:至少需要 1 个关键帧');
    }
  }, [duration, exportName, flash, sorted]);

  const doExportGlb = useCallback(async () => {
    const st = stageRef.current;
    if (!st) return;
    setBusy('glb');
    try {
      const blob = await st.exportPoseClipGlb(sorted, duration, exportName);
      downloadBlob(blob, `${exportName}.glb`);
    } catch (err) {
      flash(err instanceof Error ? err.message : '导出 glb 失败');
    } finally {
      setBusy(null);
    }
  }, [duration, exportName, flash, sorted, stageRef]);

  const doSave = useCallback(async () => {
    setBusy('save');
    try {
      const json = clipToExportJson(buildPoseClip(sorted, duration, exportName));
      await putAsset({
        kind: 'animation',
        name: exportName,
        ext: 'json',
        blob: new Blob([json], { type: 'application/json' }),
      });
      onSaved();
      flash('已保存到「我的动画」');
    } catch {
      flash('保存失败:至少需要 1 个关键帧');
    } finally {
      setBusy(null);
    }
  }, [duration, exportName, flash, onSaved, sorted]);

  const tickStep = duration <= 12 ? 1 : duration <= 30 ? 2 : 5;
  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let t = 0; t <= duration; t += tickStep) out.push(t);
    return out;
  }, [duration, tickStep]);

  return (
    <div style={styles.panel}>
      <div style={styles.top}>
        <span style={styles.title}>◆ K 动画</span>
        <input
          style={styles.nameInput}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="动画名称"
          title="动画名称(用于保存/导出文件名)"
        />
        <button
          style={isAdvanced ? styles.kfBtn : styles.btnDisabled}
          onClick={record}
          disabled={!isAdvanced}
          title="把假人当前姿势记录为游标处的关键帧"
        >
          ◆ 记录当前姿势 (F)
        </button>
        <button
          style={selId && isAdvanced ? styles.btn : styles.btnDisabled}
          onClick={updateSelected}
          disabled={!selId || !isAdvanced}
        >
          更新选中关键帧
        </button>
        <button
          style={selId ? styles.btn : styles.btnDisabled}
          onClick={() => selId && removeKey(selId)}
          disabled={!selId}
        >
          删除选中
        </button>
        <button style={hasKeys ? styles.btn : styles.btnDisabled} onClick={() => jumpKey(-1)} disabled={!hasKeys} title="上一关键帧">
          |◁
        </button>
        <button style={hasKeys ? styles.btn : styles.btnDisabled} onClick={() => jumpKey(1)} disabled={!hasKeys} title="下一关键帧">
          ▷|
        </button>
        <button
          style={canPreview ? styles.btn : styles.btnDisabled}
          onClick={togglePlay}
          disabled={!canPreview}
          title="循环预览 (Space);至少需要 2 个关键帧"
        >
          {playing ? '⏸ 暂停' : '▷ 预览'}
        </button>
        {previewActive && (
          <button style={styles.btn} onClick={stopPreview} title="停止预览并恢复预览前姿势">
            ⏹
          </button>
        )}
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
        <span style={{ flex: 1 }} />
        {notice && <span style={styles.notice}>{notice}</span>}
        <button
          style={hasKeys && busy == null ? styles.btn : styles.btnDisabled}
          onClick={() => void doSave()}
          disabled={!hasKeys || busy != null}
        >
          {busy === 'save' ? '保存中…' : '💾 存入我的动画'}
        </button>
        <button
          style={hasKeys ? styles.btn : styles.btnDisabled}
          onClick={doExportJson}
          disabled={!hasKeys}
          title="导出剪辑 JSON(可再导入本软件)"
        >
          ⤓ .json
        </button>
        <button
          style={hasKeys && busy == null ? styles.btn : styles.btnDisabled}
          onClick={() => void doExportGlb()}
          disabled={!hasKeys || busy != null}
          title="导出 glb(含假人网格+动画;Blender/Unity 可用)"
        >
          {busy === 'glb' ? '导出中…' : '⤓ .glb'}
        </button>
        <button style={styles.exitBtn} onClick={onClose}>
          × 关闭
        </button>
      </div>

      {!isAdvanced && (
        <div style={styles.hintRow}>选中一个高级假人后,用右栏「姿势」摆好姿势再打关键帧。</div>
      )}

      <div style={styles.rail} ref={railRef} onMouseDown={onRailClick}>
        {ticks.map((t) => (
          <span key={t} style={{ ...styles.tick, left: `${(t / duration) * 100}%` }}>
            {t}s
          </span>
        ))}
        {sorted.map((k) => (
          <span
            key={k.id}
            style={{
              ...(k.id === selId ? styles.kfSel : styles.kf),
              left: `${(k.t / duration) * 100}%`,
            }}
            title={`关键帧 @ ${k.t.toFixed(1)}s — 点击选中,双击删除`}
            onMouseDown={(e) => {
              e.stopPropagation();
              selectKey(k);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              removeKey(k.id);
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
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 42,
    background: '#16181eF7',
    borderTop: '1px solid #2c313b',
    padding: '8px 14px 14px',
    pointerEvents: 'auto',
  },
  top: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' },
  title: { color: '#cbd2dd', fontSize: 12, fontWeight: 600 },
  nameInput: {
    background: '#0f1116',
    border: '1px solid #333a46',
    color: '#e5e9f0',
    borderRadius: 6,
    padding: '4px 8px',
    fontSize: 12,
    width: 140,
  },
  kfBtn: {
    background: '#2d3340',
    border: '1px solid #3b4250',
    color: '#e5e9f0',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  btn: {
    background: '#23262e',
    border: '1px solid #333a46',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  btnDisabled: {
    background: '#1c1f26',
    border: '1px solid #2a2f38',
    color: '#5a626d',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'not-allowed',
    fontSize: 12,
  },
  durLabel: { color: '#8b94a2', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 },
  durInput: {
    width: 48,
    background: '#0f1116',
    border: '1px solid #333a46',
    color: '#e5e9f0',
    borderRadius: 5,
    padding: '2px 6px',
    fontSize: 12,
  },
  notice: { color: '#7ec97e', fontSize: 11 },
  exitBtn: {
    background: 'none',
    border: '1px solid #3b4250',
    color: '#cbd2dd',
    borderRadius: 6,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
  },
  hintRow: { color: '#8b94a2', fontSize: 11, marginBottom: 6 },
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
  kfSel: {
    position: 'absolute',
    bottom: 2,
    transform: 'translateX(-50%)',
    color: '#4aa3ff',
    fontSize: 15,
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
};
