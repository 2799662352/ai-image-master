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
  /** 视觉主题. punk = ドーナドーナ × P5 拼贴; default = 暗色 SaaS. 默认 default. */
  theme?: "punk" | "default";
}

function MultiAngleEditorInner({ onInjectPrompt, onClose, imageUrl, theme = "default" }: MultiAngleEditorProps) {
  const isPunk = theme === "punk";
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

  // ====================================================================
  // PUNK 分支 — ドーナドーナ × P5 拼贴风; 使用 donor-punk.css 里的 .p-* 工具类
  // ====================================================================
  if (isPunk) {
    return (
      <div
        className="flex flex-col"
        style={{
          width: 600,
          background: "var(--punk-cream)",
          border: "3px solid var(--punk-black)",
          boxShadow: "4px 4px 0 var(--punk-black)",
          padding: "14px 14px 12px",
          gap: 10,
          fontFamily: "var(--punk-font-display)",
          color: "var(--punk-black)",
        }}
      >
        {/* Header */}
        <header
          className="flex items-center"
          style={{ gap: 12, paddingBottom: 8, borderBottom: "2px dashed var(--punk-black)" }}
        >
          <div
            style={{
              background: "var(--punk-black)",
              color: "var(--punk-pink)",
              padding: "4px 10px",
              fontFamily: "var(--punk-font-display)",
              fontWeight: 900,
              fontSize: 18,
              letterSpacing: "-0.02em",
              textTransform: "uppercase",
              transform: "rotate(-1.5deg)",
              boxShadow: "3px 3px 0 var(--punk-pink)",
            }}
          >
            多角度 / CAMERA
          </div>
          <span
            className="p-hazard-tape"
            style={{ transform: "rotate(2deg)" }}
            aria-hidden
          >
            3D · BETA
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            title="关闭"
            style={{
              width: 28,
              height: 28,
              background: "var(--punk-black)",
              color: "var(--punk-cream)",
              border: "2px solid var(--punk-black)",
              boxShadow: "2px 2px 0 var(--punk-pink)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "transform 120ms, box-shadow 120ms",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.transform = "translate(-1px,-1px)";
              (e.currentTarget as HTMLElement).style.boxShadow = "3px 3px 0 var(--punk-pink)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.transform = "none";
              (e.currentTarget as HTMLElement).style.boxShadow = "2px 2px 0 var(--punk-pink)";
            }}
          >
            <CloseIcon />
          </button>
        </header>

        {/* Presets — 贴纸 chip */}
        <div className="flex flex-wrap items-center" style={{ gap: 6 }}>
          {PRESETS.map((p, i) => {
            const active = activePreset === i;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => applyPreset(i)}
                aria-pressed={active}
                className="p-tab"
                style={{
                  padding: "4px 12px",
                  fontSize: 12,
                  letterSpacing: "-0.01em",
                  cursor: "pointer",
                  ...(active
                    ? {
                        background: "var(--punk-black)",
                        color: "var(--punk-pink)",
                        boxShadow: "3px 3px 0 var(--punk-cream-dim)",
                        transform: "translate(-2px,-2px) rotate(-1deg)",
                      }
                    : {}),
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>

        {/* Body: Scene + Controls */}
        <div className="flex items-start" style={{ gap: 12 }}>
          {/* 3D Scene — 厚黑描边 + 硬投影 + 角标 */}
          <div
            className="relative shrink-0"
            style={{
              width: 240,
              border: "3px solid var(--punk-black)",
              background: "var(--punk-cream)",
              boxShadow: "4px 4px 0 var(--punk-black)",
            }}
          >
            <span
              className="p-hazard-tape"
              style={{
                position: "absolute",
                top: -8,
                left: -6,
                zIndex: 2,
                transform: "rotate(-4deg)",
                fontSize: 9,
              }}
              aria-hidden
            >
              PREVIEW
            </span>
            <div className="relative" style={{ width: 234, height: 240 }}>
              {imageUrl ? (
                <Suspense
                  fallback={
                    <div className="flex h-full w-full items-center justify-center">
                      <span className="p-mono" style={{ fontSize: 11, color: "var(--punk-pink-deep)" }}>LOADING 3D…</span>
                    </div>
                  }
                >
                  <ThreeGlobe
                    horizontal={horizontal}
                    vertical={vertical}
                    width={234}
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
                <div className="flex h-full w-full flex-col items-center justify-center" style={{ gap: 6 }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--punk-black)" strokeWidth="2" aria-hidden>
                    <rect x="3" y="3" width="18" height="18" />
                    <circle cx="8.5" cy="8.5" r="1.5" fill="var(--punk-black)" />
                    <polyline points="21 15 16 10 5 21" />
                  </svg>
                  <span className="p-mono" style={{ fontSize: 11, color: "var(--punk-pink-deep)" }}>NO IMAGE</span>
                </div>
              )}
            </div>
            <div style={{ height: 2, background: "var(--punk-black)" }} />
            <div
              className="flex items-center justify-center"
              style={{ gap: 6, padding: "6px 4px", background: "var(--punk-cream-dim)" }}
              role="group"
              aria-label="快捷旋转"
            >
              <PunkDirBtn ariaLabel="向左环绕 45°" onClick={() => { setHorizontal((h) => (((h - 45) % 360) + 360) % 360); setCustom(); }}>
                <ChevronLeftIcon />
              </PunkDirBtn>
              <PunkDirBtn ariaLabel="向上俯仰 30°" onClick={() => { setVertical((v) => Math.min(60, v + 30)); setCustom(); }}>
                <ChevronUpIcon />
              </PunkDirBtn>
              <PunkDirBtn ariaLabel="向下俯仰 30°" onClick={() => { setVertical((v) => Math.max(-30, v - 30)); setCustom(); }}>
                <ChevronDownIcon />
              </PunkDirBtn>
              <PunkDirBtn ariaLabel="向右环绕 45°" onClick={() => { setHorizontal((h) => (h + 45) % 360); setCustom(); }}>
                <ChevronRightIcon />
              </PunkDirBtn>
            </div>
          </div>

          {/* Controls */}
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 10, minHeight: 240 }}>
            <SectionLabelPunk>镜头角度 / ANGLE</SectionLabelPunk>
            <div className="flex flex-col" style={{ gap: 4 }}>
              <PunkSliderRow label="水平环绕" min={0} max={359} step={1} value={horizontal} displayValue={`${horizontal}°`}
                onChange={(v) => { setHorizontal(v); setCustom(); }} />
              <PunkSliderRow label="垂直俯仰" min={-30} max={60} step={1} value={vertical} displayValue={`${vertical}°`}
                onChange={(v) => { setVertical(v); setCustom(); }} />
              <PunkSliderRow label="景别缩放" min={0.6} max={1.4} step={0.4} value={zoom} displayValue={zoomLabel}
                onChange={(v) => { setZoom(v); setCustom(); }} />
            </div>

            {/* Prompt preview — 黑色贴纸 */}
            <SectionLabelPunk>提示词 / PROMPT</SectionLabelPunk>
            <button
              type="button"
              onClick={handleCopyPrompt}
              title="点击复制相机提示词"
              className="flex w-full min-w-0 items-start text-left"
              style={{
                gap: 8,
                padding: "8px 10px",
                background: "var(--punk-black)",
                color: "var(--punk-cream)",
                border: "2px solid var(--punk-black)",
                boxShadow: "3px 3px 0 var(--punk-pink)",
                cursor: "pointer",
                transition: "transform 120ms, box-shadow 120ms",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.transform = "translate(-2px,-2px)";
                (e.currentTarget as HTMLElement).style.boxShadow = "5px 5px 0 var(--punk-pink)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.transform = "none";
                (e.currentTarget as HTMLElement).style.boxShadow = "3px 3px 0 var(--punk-pink)";
              }}
            >
              <span className="p-hazard-tape" style={{ flexShrink: 0, fontSize: 9, padding: "2px 6px" }} aria-hidden>
                PROMPT
              </span>
              <span
                className="p-mono min-w-0 flex-1"
                style={{ fontSize: 11, lineHeight: 1.5, color: "var(--punk-cream)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}
                title={cameraPromptText}
              >
                {cameraPromptText}
              </span>
              <span
                className="p-mono"
                style={{
                  flexShrink: 0,
                  fontSize: 10,
                  padding: "2px 6px",
                  background: promptCopied ? "var(--punk-toxic)" : "var(--punk-cream)",
                  color: "var(--punk-black)",
                  border: "1.5px solid var(--punk-black)",
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                }}
                aria-live="polite"
              >
                {promptCopied ? "COPIED" : "COPY"}
              </span>
            </button>
          </div>
        </div>

        {/* Footer */}
        <footer
          className="flex items-center"
          style={{ gap: 10, paddingTop: 8, borderTop: "2px dashed var(--punk-black)", minHeight: 44 }}
        >
          <button
            type="button"
            onClick={resetParams}
            className="p-btn"
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderWidth: 2,
              background: "var(--punk-cream)",
              color: "var(--punk-black)",
              boxShadow: "3px 3px 0 var(--punk-black)",
            }}
          >
            <ResetIcon />
            <span>重置</span>
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleInject}
            className="p-btn p-btn--pink"
            style={{ fontSize: 14, padding: "8px 18px" }}
          >
            ★ 注入 PROMPT
          </button>
        </footer>
      </div>
    );
  }

  // ====================================================================
  // DEFAULT 分支 — 保留原有暗色 SaaS 视觉
  // ====================================================================
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

/* ========== Punk helper components ========== */

function SectionLabelPunk({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center" style={{ gap: 8 }}>
      <span
        className="p-mono p-upper"
        style={{
          background: "var(--punk-black)",
          color: "var(--punk-cream)",
          padding: "2px 8px",
          fontSize: 10,
          letterSpacing: "0.1em",
          fontWeight: 900,
        }}
      >
        {children}
      </span>
      <div
        style={{
          flex: 1,
          height: 3,
          background:
            "repeating-linear-gradient(90deg, var(--punk-black) 0 6px, transparent 6px 10px)",
        }}
      />
    </div>
  );
}

function PunkDirBtn({ ariaLabel, onClick, children }: { ariaLabel: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={{
        width: 28,
        height: 28,
        background: "var(--punk-cream)",
        color: "var(--punk-black)",
        border: "2px solid var(--punk-black)",
        boxShadow: "2px 2px 0 var(--punk-black)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "transform 100ms, box-shadow 100ms, background 100ms",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "var(--punk-pink)";
        el.style.transform = "translate(-1px,-1px)";
        el.style.boxShadow = "3px 3px 0 var(--punk-black)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.background = "var(--punk-cream)";
        el.style.transform = "none";
        el.style.boxShadow = "2px 2px 0 var(--punk-black)";
      }}
      onMouseDown={(e) => {
        const el = e.currentTarget as HTMLElement;
        el.style.transform = "translate(2px,2px)";
        el.style.boxShadow = "0 0 0 var(--punk-black)";
      }}
    >
      {children}
    </button>
  );
}

function PunkSliderRow({
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
    <div className="flex items-center" style={{ gap: 10, padding: "4px 0" }}>
      <span
        className="p-display p-upper"
        style={{ width: 72, flexShrink: 0, fontSize: 12, color: "var(--punk-black)", letterSpacing: "-0.01em" }}
      >
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
          className="p-range"
          style={{
            // 覆盖 .p-range 默认 cream 底, 改为粉色渐变填充
            background: `linear-gradient(to right,
              var(--punk-pink) 0%,
              var(--punk-pink-deep) ${pct}%,
              var(--punk-cream) ${pct}%,
              var(--punk-cream) 100%)`,
          }}
        />
      </div>
      <span
        className="p-mono"
        style={{
          minWidth: 52,
          flexShrink: 0,
          textAlign: "center",
          fontSize: 12,
          padding: "2px 6px",
          background: "var(--punk-cream)",
          color: "var(--punk-black)",
          border: "2px solid var(--punk-black)",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 700,
        }}
      >
        {displayValue}
      </span>
    </div>
  );
}
