import { memo, useState, useCallback, useRef, type ReactNode, lazy, Suspense } from "react";
import { buildCameraPrompt } from "./prompts";

const ThreeGlobe = lazy(() => import("./ThreeGlobe").then((m) => ({ default: m.ThreeGlobe })));

interface Preset {
  label: string;
  horizontal: number;
  vertical: number;
  zoom: number;
}

const PRESETS: Preset[] = [
  { label: "自定义", horizontal: 0, vertical: 0, zoom: 1.0 },
  { label: "鱼眼视角", horizontal: 0, vertical: 60, zoom: 0.6 },
  { label: "倾斜视角", horizontal: 45, vertical: 30, zoom: 1.0 },
  { label: "正面俯拍", horizontal: 0, vertical: 60, zoom: 1.0 },
  { label: "正面仰拍", horizontal: 0, vertical: -30, zoom: 1.0 },
  { label: "全景俯拍", horizontal: 0, vertical: 60, zoom: 1.4 },
  { label: "背面视角", horizontal: 180, vertical: 0, zoom: 1.0 },
];

const ZOOM_LABELS: Record<number, string> = {
  0.6: "特写",
  1: "中景",
  1.4: "远景",
};

interface MultiAngleEditorProps {
  onInjectPrompt: (prompt: string) => void;
  onClose: () => void;
  imageUrl?: string;
}

function MultiAngleEditorInner({ onInjectPrompt, onClose, imageUrl }: MultiAngleEditorProps) {
  const [activePreset, setActivePreset] = useState(0);
  const [horizontal, setHorizontal] = useState(0);
  const [vertical, setVertical] = useState(0);
  const [zoom, setZoom] = useState(1.0);
  const [promptCopied, setPromptCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cameraPromptText = buildCameraPrompt(horizontal, vertical, zoom);

  const applyPreset = useCallback((i: number) => {
    setActivePreset(i);
    const p = PRESETS[i];
    setHorizontal(p.horizontal);
    setVertical(p.vertical);
    setZoom(p.zoom);
  }, []);

  const setCustom = useCallback(() => setActivePreset(0), []);

  const resetParams = useCallback(() => {
    setActivePreset(0);
    setHorizontal(0);
    setVertical(0);
    setZoom(1.0);
  }, []);

  const handleInject = useCallback(() => {
    onInjectPrompt(cameraPromptText);
    onClose();
  }, [onInjectPrompt, onClose, cameraPromptText]);

  const handleCopyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(cameraPromptText);
      setPromptCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setPromptCopied(false), 1200);
    } catch {
      /* silently ignore */
    }
  }, [cameraPromptText]);

  const zoomLabel = ZOOM_LABELS[zoom] ?? `${zoom}`;

  return (
    <div
      className="flex flex-col"
      style={{
        width: 600,
        backgroundColor: "rgb(38, 38, 38)",
        borderRadius: 12,
        padding: "12px 8px 8px",
        gap: 8,
      }}
    >
      {/* Header */}
      <header className="flex items-center px-2" style={{ height: 32, gap: 16 }}>
        <h1 className="flex-1 text-[15px] font-medium tracking-[-0.01em] text-[rgb(247,247,247)]">
          多角度编辑器
        </h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(145,145,145)] transition-colors hover:bg-white/10 hover:text-white"
        >
          <CloseIcon />
        </button>
      </header>

      {/* Presets */}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 px-1">
        {PRESETS.map((p, i) => {
          const active = activePreset === i;
          return (
            <button
              key={p.label}
              type="button"
              onClick={() => applyPreset(i)}
              aria-pressed={active}
              className="select-none whitespace-nowrap transition-colors"
              style={{
                padding: "3px 10px",
                borderRadius: 6,
                border: active
                  ? "1px solid rgba(54, 181, 240, 0.55)"
                  : "1px solid rgb(54, 54, 54)",
                backgroundColor: active
                  ? "rgba(54, 181, 240, 0.10)"
                  : "transparent",
                color: active ? "#7bc6f0" : "rgb(145, 145, 145)",
                fontSize: 12,
                lineHeight: "20px",
                boxShadow: active
                  ? "0 0 0 1px rgba(54, 181, 240, 0.15), inset 0 0 12px rgba(54, 181, 240, 0.08)"
                  : "none",
              }}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="mx-1 h-px bg-white/[0.06]" />

      {/* Body: Scene + Controls */}
      <div className="flex items-start" style={{ gap: 8 }}>
        {/* 3D Scene */}
        <div
          className="shrink-0 overflow-hidden"
          style={{
            width: 240,
            borderRadius: 14,
            border: "1px solid rgba(255, 255, 255, 0.08)",
            background: "rgb(28, 28, 28)",
            boxShadow: "inset 0 0 40px rgba(54, 181, 240, 0.05)",
          }}
        >
          <div className="relative" style={{ width: 238, height: 240 }}>
            {imageUrl ? (
              <Suspense
                fallback={
                  <div className="flex h-full w-full items-center justify-center bg-[rgb(54,54,54)]">
                    <span className="text-xs text-white/50">加载 3D 预览...</span>
                  </div>
                }
              >
                <ThreeGlobe
                  horizontal={horizontal}
                  vertical={vertical}
                  width={238}
                  height={240}
                  imageUrl={imageUrl}
                  onRotate={(h, v) => {
                    setHorizontal(h);
                    setVertical(v);
                    setCustom();
                  }}
                />
              </Suspense>
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-[rgb(28,28,28)]">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.25"
                  className="text-white/25"
                  aria-hidden
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
                <span className="text-[12px] text-white/45">先选择一张图片</span>
              </div>
            )}
          </div>

          <div className="h-px w-full bg-white/[0.06]" />

          <div
            className="flex items-center justify-center gap-1.5 py-1.5"
            role="group"
            aria-label="快捷旋转"
          >
            <DirBtn
              ariaLabel="向左环绕 45°"
              onClick={() => {
                setHorizontal((h) => (((h - 45) % 360) + 360) % 360);
                setCustom();
              }}
            >
              <ChevronLeftIcon />
            </DirBtn>
            <DirBtn
              ariaLabel="向上俯仰 30°"
              onClick={() => {
                setVertical((v) => Math.min(60, v + 30));
                setCustom();
              }}
            >
              <ChevronUpIcon />
            </DirBtn>
            <DirBtn
              ariaLabel="向下俯仰 30°"
              onClick={() => {
                setVertical((v) => Math.max(-30, v - 30));
                setCustom();
              }}
            >
              <ChevronDownIcon />
            </DirBtn>
            <DirBtn
              ariaLabel="向右环绕 45°"
              onClick={() => {
                setHorizontal((h) => (h + 45) % 360);
                setCustom();
              }}
            >
              <ChevronRightIcon />
            </DirBtn>
          </div>
        </div>

        {/* Controls */}
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 12, minHeight: 240 }}>
          <section className="flex flex-col gap-1">
            <div className="flex items-center gap-2 px-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/40">
                镜头角度
              </span>
              <div className="h-px flex-1 bg-white/[0.06]" />
            </div>
            <div className="flex flex-col" style={{ gap: 2 }}>
              <SliderRow
                label="水平环绕"
                min={0}
                max={359}
                step={1}
                value={horizontal}
                displayValue={`${horizontal}°`}
                onChange={(v) => { setHorizontal(v); setCustom(); }}
              />
              <SliderRow
                label="垂直俯仰"
                min={-30}
                max={60}
                step={1}
                value={vertical}
                displayValue={`${vertical}°`}
                onChange={(v) => { setVertical(v); setCustom(); }}
              />
              <SliderRow
                label="景别缩放"
                min={0.6}
                max={1.4}
                step={0.4}
                value={zoom}
                displayValue={zoomLabel}
                onChange={(v) => { setZoom(v); setCustom(); }}
              />
            </div>
          </section>

          {/* Prompt preview */}
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 px-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/40">
                提示词
              </span>
              <div className="h-px flex-1 bg-white/[0.06]" />
            </div>
            <button
              type="button"
              onClick={handleCopyPrompt}
              title="点击复制相机提示词"
              className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all"
              style={{
                background: "rgba(54, 181, 240, 0.05)",
                border: "1px solid rgba(54, 181, 240, 0.12)",
              }}
            >
              <span
                className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium tracking-[0.04em]"
                style={{
                  background: "rgba(54, 181, 240, 0.15)",
                  color: "#7bc6f0",
                }}
              >
                PROMPT
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-white/75" title={cameraPromptText}>
                {cameraPromptText}
              </span>
              <span
                className={`flex shrink-0 items-center gap-1 text-[10px] transition-colors ${
                  promptCopied ? "text-emerald-400" : "text-white/45"
                }`}
                aria-live="polite"
              >
                {promptCopied ? (
                  "已复制"
                ) : (
                  <>
                    <CopyIcon />
                    复制
                  </>
                )}
              </span>
            </button>
          </section>
        </div>
      </div>

      {/* Footer */}
      <footer className="flex items-center" style={{ gap: 12, minHeight: 36 }}>
        <button
          type="button"
          onClick={resetParams}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-[rgb(145,145,145)] transition-colors hover:bg-white/5 hover:text-white"
        >
          <ResetIcon />
          <span>重置参数</span>
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleInject}
          className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-medium text-white shadow-[0_2px_10px_rgba(54,181,240,0.35)] transition-all duration-150 hover:shadow-[0_3px_14px_rgba(54,181,240,0.5)] active:scale-95"
          style={{ background: "linear-gradient(135deg, #36b5f0 0%, #2b9cd9 100%)" }}
        >
          注入 Prompt
        </button>
      </footer>
    </div>
  );
}

export const MultiAngleEditor = memo(MultiAngleEditorInner);
export default MultiAngleEditor;

function DirBtn({
  ariaLabel,
  onClick,
  children,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className="flex h-7 w-7 items-center justify-center rounded-md text-white/55 transition-colors hover:bg-white/10 hover:text-white focus-visible:bg-white/10 focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:scale-95"
    >
      {children}
    </button>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  displayValue,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  displayValue: string;
  onChange: (v: number) => void;
}) {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div className="flex items-center gap-3 px-1 py-1.5">
      <span className="w-[56px] shrink-0 text-right text-[13px] text-[rgb(145,145,145)]">
        {label}
      </span>
      <div className="relative min-w-0 flex-1">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="angle-slider w-full cursor-pointer appearance-none"
          style={{
            background: `linear-gradient(to right, #36b5f0 0%, #2b9cd9 ${pct}%, rgba(255,255,255,0.08) ${pct}%, rgba(255,255,255,0.08) 100%)`,
            height: 6,
            borderRadius: 3,
          }}
        />
      </div>
      <span className="w-[40px] shrink-0 text-right text-[13px] tabular-nums text-[rgb(247,247,247)]">
        {displayValue}
      </span>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function ResetIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 2v5h5M14 14V9H9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.49 6.01A6 6 0 0 0 3.04 4.53L2 7M2.51 9.99a6 6 0 0 0 10.45 1.48L14 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
