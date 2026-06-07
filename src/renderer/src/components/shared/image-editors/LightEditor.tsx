import { memo, useState, useCallback, useMemo, useRef, useEffect, lazy, Suspense, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { buildLightingPrompt } from "./prompts";
import type { LightAngle, LightTarget } from "./ThreeLightScene";

const ThreeLightScene = lazy(() => import("./ThreeLightScene").then((m) => ({ default: m.ThreeLightScene })));

type LightDirection = "left" | "top" | "right" | "front" | "bottom" | "back";

const DIRECTIONS: { key: LightDirection; label: string; Icon: () => ReactNode }[] = [
  { key: "left", label: "左侧", Icon: DirLeftIcon },
  { key: "top", label: "顶部", Icon: DirTopIcon },
  { key: "right", label: "右侧", Icon: DirRightIcon },
  { key: "front", label: "前方", Icon: DirFrontIcon },
  { key: "bottom", label: "底部", Icon: DirBottomIcon },
  { key: "back", label: "后方", Icon: DirBackIcon },
];

const BRIGHTNESS_LABELS: Record<number, string> = {
  0: "0",
  1: "25",
  2: "50",
  3: "75",
  4: "100",
};

const BRIGHTNESS_TICKS = ["0", "柔和", "自然", "明亮", "强光"];

const COLOR_PRESETS: { hex: string; label: string }[] = [
  { hex: "#ffe4c4", label: "暖黄" },
  { hex: "#fff8e7", label: "自然" },
  { hex: "#ffffff", label: "中性白" },
  { hex: "#d4e4ff", label: "冷白" },
  { hex: "#b4c7ff", label: "科技蓝" },
  { hex: "#ffd6e8", label: "粉调" },
];

interface LightEditorProps {
  onInjectPrompt: (prompt: string) => void;
  onClose: () => void;
  imageUrl?: string;
  /** 视觉主题. punk = ドーナドーナ × P5 拼贴; default = 暗色 SaaS. 默认 default. */
  theme?: "punk" | "default";
  /** 进入 3D 导演台:把当前图作为背景导入。缺省则隐藏入口按钮。 */
  onEnterDirector?: () => void;
}

function LightEditorInner({ onInjectPrompt, onClose, imageUrl, theme = "default", onEnterDirector }: LightEditorProps) {
  const isPunk = theme === "punk";
  const [brightness, setBrightness] = useState(2);
  const [color, setColor] = useState("#ffe4c4");
  const [direction, setDirection] = useState<LightDirection>("front");
  const [customAngle, setCustomAngle] = useState<LightAngle | null>(null);
  const [rimLight, setRimLight] = useState(false);
  const [viewMode, setViewMode] = useState<"perspective" | "front">("perspective");
  // 磁吸到预设 —— 默认关. 开启后拖完松手若在 18° 内会自动吸到最近的 6 向预设,
  // 自由角度会跳回预设标签(如 "front"). 关时保留任意自由 (az, el).
  const [snapToPreset, setSnapToPreset] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lightPrompt = useMemo(
    () => buildLightingPrompt(customAngle ?? direction, brightness, color, rimLight),
    [customAngle, direction, brightness, color, rimLight],
  );

  const handleLightChange = useCallback((target: LightTarget) => {
    if (target.type === "preset") {
      setDirection(target.key);
      setCustomAngle(null);
    } else {
      setCustomAngle({ az: target.az, el: target.el });
    }
  }, []);

  const handlePresetClick = useCallback((key: LightDirection) => {
    setDirection(key);
    setCustomAngle(null);
  }, []);

  const resetParams = useCallback(() => {
    setBrightness(2);
    setColor("#ffe4c4");
    setDirection("front");
    setCustomAngle(null);
    setRimLight(false);
  }, []);

  const handleInject = useCallback(() => {
    onInjectPrompt(lightPrompt);
    onClose();
  }, [onInjectPrompt, onClose, lightPrompt]);

  const handleCopyPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(lightPrompt);
      setPromptCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setPromptCopied(false), 1200);
    } catch {
      /* silently ignore */
    }
  }, [lightPrompt]);

  // ESC 退出全屏
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  const fullscreenOverlay = fullscreen ? (
    <LightFullscreenStage
      imageUrl={imageUrl}
      direction={direction}
      customAngle={customAngle}
      brightness={brightness}
      color={color}
      viewMode={viewMode}
      snapToPreset={snapToPreset}
      rimLight={rimLight}
      lightPrompt={lightPrompt}
      promptCopied={promptCopied}
      onViewMode={setViewMode}
      onBrightness={setBrightness}
      onColor={setColor}
      onPreset={handlePresetClick}
      onLightChange={handleLightChange}
      onRim={setRimLight}
      onSnap={setSnapToPreset}
      onCopy={handleCopyPrompt}
      resetParams={resetParams}
      onInject={handleInject}
      onExit={() => setFullscreen(false)}
    />
  ) : null;

  const brightnessPct = BRIGHTNESS_LABELS[brightness] ?? `${brightness * 25}`;
  const sliderPct = (brightness / 4) * 100;

  // ====================================================================
  // PUNK 分支 — ドーナドーナ × P5 拼贴风
  // ====================================================================
  if (isPunk) {
    return (
      <div
        className="flex w-full flex-col"
        style={{
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
            打光 / LIGHTING
          </div>
          <span className="p-hazard-tape" style={{ transform: "rotate(2deg)" }} aria-hidden>
            RELIGHT · BETA
          </span>
          <div className="flex-1" />
          {onEnterDirector && (
            <button
              type="button"
              onClick={onEnterDirector}
              title="把当前图作为背景,进入 3D 导演台"
              style={{
                height: 28,
                padding: "0 10px",
                background: "var(--punk-pink)",
                color: "var(--punk-black)",
                border: "2px solid var(--punk-black)",
                boxShadow: "2px 2px 0 var(--punk-black)",
                cursor: "pointer",
                fontFamily: "var(--punk-font-display)",
                fontWeight: 900,
                fontSize: 12,
                textTransform: "uppercase",
              }}
            >
              进入导演台
            </button>
          )}
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        {/* Body */}
        <div className="flex items-start" style={{ gap: 12 }}>
          {/* 3D Scene */}
          <div
            className="relative shrink-0"
            style={{
              width: 210,
              border: "3px solid var(--punk-black)",
              background: "var(--punk-cream)",
              boxShadow: "4px 4px 0 var(--punk-black)",
            }}
          >
            <span
              className="p-hazard-tape"
              style={{ position: "absolute", top: -8, left: -6, zIndex: 2, transform: "rotate(-4deg)", fontSize: 9 }}
              aria-hidden
            >
              PREVIEW
            </span>
            <div
              className="flex items-center"
              style={{ gap: 6, padding: "6px 6px 4px", background: "var(--punk-cream-dim)", borderBottom: "2px solid var(--punk-black)" }}
            >
              <PunkModeTab label="透视" active={viewMode === "perspective"} onClick={() => setViewMode("perspective")} />
              <PunkModeTab label="正面" active={viewMode === "front"} onClick={() => setViewMode("front")} />
            </div>
            <div className="relative flex items-center justify-center overflow-hidden" style={{ width: 204, height: 240, background: "var(--punk-cream)" }}>
              <FullscreenButton onClick={() => setFullscreen(true)} />
              <Suspense fallback={<div className="flex h-full w-full items-center justify-center"><span className="p-mono" style={{ fontSize: 11, color: "var(--punk-pink-deep)" }}>LOADING 3D…</span></div>}>
                <ThreeLightScene
                  direction={direction}
                  customAngle={customAngle}
                  brightness={brightness}
                  color={color}
                  viewMode={viewMode}
                  width={204}
                  height={240}
                  imageUrl={imageUrl}
                  onLightChange={handleLightChange}
                  snapToPreset={snapToPreset}
                />
              </Suspense>
            </div>
          </div>

          {/* Controls */}
          <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 10, minHeight: 288 }}>
            <PunkSectionLabel>光源 / SOURCE</PunkSectionLabel>

            {/* Brightness */}
            <div className="flex flex-col" style={{ gap: 4 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <span className="p-display p-upper" style={{ width: 52, flexShrink: 0, fontSize: 12 }}>亮度</span>
                <PunkInfoIcon title="控制光源的整体强度。0% 几乎无光，100% 为最亮。" />
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={1}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  className="p-range min-w-0 flex-1"
                  style={{
                    background: `linear-gradient(to right,
                      var(--punk-pink) 0%,
                      var(--punk-pink-deep) ${sliderPct}%,
                      var(--punk-cream) ${sliderPct}%,
                      var(--punk-cream) 100%)`,
                  }}
                />
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
                    fontWeight: 700,
                  }}
                >
                  {brightnessPct}%
                </span>
              </div>
              <div className="flex items-center" style={{ paddingLeft: 68, paddingRight: 66 }}>
                <div className="flex min-w-0 flex-1 items-center justify-between">
                  {BRIGHTNESS_TICKS.map((t, i) => {
                    const active = i === brightness;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setBrightness(i)}
                        className="p-mono"
                        style={{
                          fontSize: 9,
                          fontWeight: active ? 900 : 700,
                          letterSpacing: "0.04em",
                          color: active ? "var(--punk-pink-deep)" : "var(--punk-black)",
                          opacity: active ? 1 : 0.55,
                          background: "transparent",
                          border: "none",
                          cursor: "pointer",
                          padding: 0,
                          textDecoration: active ? "underline 2px var(--punk-pink)" : "none",
                          textUnderlineOffset: 3,
                        }}
                        title={`亮度:${t}(${i * 25}%)`}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Color */}
            <div className="flex items-center" style={{ gap: 8 }}>
              <span className="p-display p-upper" style={{ width: 52, flexShrink: 0, fontSize: 12 }}>颜色</span>
              <PunkInfoIcon title="光源色温。暖色(橙黄)适合温馨场景，冷色(蓝白)适合科技/清爽场景。" />
              <button
                type="button"
                className="relative flex items-center justify-center overflow-hidden"
                style={{
                  height: 24,
                  width: 36,
                  border: "2px solid var(--punk-black)",
                  boxShadow: "2px 2px 0 var(--punk-black)",
                  cursor: "pointer",
                  background: color,
                }}
                title={`自定义颜色 ${color}`}
                aria-label="自定义颜色"
              >
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </button>
              <div className="flex items-center" style={{ gap: 6 }}>
                {COLOR_PRESETS.map((p) => {
                  const active = color.toLowerCase() === p.hex.toLowerCase();
                  return (
                    <button
                      key={p.hex}
                      type="button"
                      onClick={() => setColor(p.hex)}
                      style={{
                        position: "relative",
                        width: 22,
                        height: 22,
                        background: p.hex,
                        border: active ? "3px solid var(--punk-black)" : "2px solid var(--punk-black)",
                        boxShadow: active ? "3px 3px 0 var(--punk-pink)" : "1.5px 1.5px 0 var(--punk-black)",
                        transform: active ? "translate(-1px,-1px)" : "none",
                        cursor: "pointer",
                        transition: "transform 100ms, box-shadow 100ms",
                      }}
                      title={`${p.label}(${p.hex})`}
                      aria-label={p.label}
                      aria-pressed={active}
                    />
                  );
                })}
              </div>
            </div>

            {/* Direction */}
            <div className="flex flex-col" style={{ gap: 6 }}>
              <div className="flex items-center" style={{ gap: 8 }}>
                <span className="p-display p-upper" style={{ fontSize: 12 }}>主光源方向</span>
                {customAngle && (
                  <span
                    className="p-mono"
                    style={{
                      fontSize: 9,
                      padding: "1px 6px",
                      background: "var(--punk-toxic)",
                      color: "var(--punk-black)",
                      border: "2px solid var(--punk-black)",
                      letterSpacing: "0.04em",
                      fontWeight: 900,
                    }}
                    title={`方位 ${Math.round(customAngle.az)}° / 仰角 ${Math.round(customAngle.el)}° (拖灯泡自定义)`}
                  >
                    FREE {Math.round(customAngle.az)}° / {Math.round(customAngle.el)}°
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3" style={{ gap: 6 }}>
                {DIRECTIONS.map((d) => {
                  const active = direction === d.key && !customAngle;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => handlePresetClick(d.key)}
                      className="flex select-none items-center justify-center"
                      style={{
                        gap: 5,
                        padding: "7px 0",
                        border: "2px solid var(--punk-black)",
                        background: active ? "var(--punk-black)" : "var(--punk-cream)",
                        color: active ? "var(--punk-pink)" : "var(--punk-black)",
                        boxShadow: active ? "3px 3px 0 var(--punk-pink)" : "2px 2px 0 var(--punk-black)",
                        transform: active ? "translate(-1px,-1px)" : "none",
                        fontFamily: "var(--punk-font-display)",
                        fontWeight: 900,
                        fontSize: 12,
                        letterSpacing: "-0.01em",
                        textTransform: "uppercase",
                        cursor: "pointer",
                        transition: "transform 100ms, box-shadow 100ms, background 100ms",
                      }}
                      aria-pressed={active}
                    >
                      <span className="flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden>
                        <d.Icon />
                      </span>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Rim Light */}
            <PunkSectionLabel>辅助 / RIM</PunkSectionLabel>
            <div className="flex items-center" style={{ gap: 8 }}>
              <span className="p-display p-upper" style={{ fontSize: 12 }}>轮廓光</span>
              <PunkInfoIcon title="在主体边缘添加一层补光,让人物或物体与背景更好地分离。" />
              <div className="flex-1" />
              <PunkToggle checked={rimLight} onChange={setRimLight} />
            </div>

            {/* 磁吸到预设 —— 默认关. 统一控制 light / camera 两种 drag 的松手磁吸. */}
            <div className="flex items-center" style={{ gap: 8, marginTop: 6 }}>
              <span className="p-display p-upper" style={{ fontSize: 12 }}>磁吸</span>
              <PunkInfoIcon title={"关（默认）：停在你松手的位置，自由 X°/Y° 一直是自由。\n开：若 ≤18° 内自动吸到最近预设，跳回预设标签（如 from the front）。"} />
              <div className="flex-1" />
              <PunkToggle checked={snapToPreset} onChange={setSnapToPreset} />
            </div>
          </div>
        </div>

        {/* Prompt preview */}
        <PunkSectionLabel>提示词 / PROMPT</PunkSectionLabel>
        <button
          type="button"
          onClick={handleCopyPrompt}
          title="点击复制打光提示词"
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
            title={lightPrompt}
          >
            {lightPrompt}
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
        {fullscreenOverlay}
      </div>
    );
  }

  // ====================================================================
  // DEFAULT 分支 — 保留原有暗色 SaaS 视觉
  // ====================================================================
  return (
    <div
      className="flex w-full flex-col"
      style={{
        backgroundColor: "rgb(38, 38, 38)",
        borderRadius: 12,
        padding: "12px 8px 8px",
        gap: 8,
      }}
    >
      {/* Header */}
      <header className="flex items-center px-2" style={{ height: 32, gap: 16 }}>
        <h1 className="flex-1 text-[15px] font-medium tracking-[-0.01em] text-[rgb(247,247,247)]">
          打光效果
        </h1>
        {onEnterDirector && (
          <button
            type="button"
            onClick={onEnterDirector}
            title="把当前图作为背景,进入 3D 导演台"
            className="flex h-6 cursor-pointer items-center rounded-md px-2.5 text-[12px] font-medium text-[rgb(247,247,247)] transition-colors hover:bg-white/10"
            style={{ border: "1px solid rgba(255,255,255,0.12)" }}
          >
            进入导演台
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[rgb(145,145,145)] transition-colors hover:bg-white/10 hover:text-white"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="mx-1 h-px bg-white/[0.06]" />

      {/* Body */}
      <div className="flex items-start" style={{ gap: 8 }}>
        {/* 3D Scene */}
        <div
          className="shrink-0 overflow-hidden"
          style={{
            width: 200,
            borderRadius: 14,
            border: "1px solid rgba(255, 255, 255, 0.08)",
            background: "rgb(28, 28, 28)",
            boxShadow: "inset 0 0 40px rgba(54, 181, 240, 0.05)",
          }}
        >
          <div className="flex items-center gap-1.5 px-2 py-2">
            <ModeTab label="透视" active={viewMode === "perspective"} onClick={() => setViewMode("perspective")} />
            <ModeTab label="正面" active={viewMode === "front"} onClick={() => setViewMode("front")} />
          </div>
          <div className="h-px w-full bg-white/[0.06]" />
          <div className="relative flex items-center justify-center overflow-hidden" style={{ width: 198, height: 240, backgroundColor: "rgb(28, 28, 28)" }}>
            <FullscreenButton onClick={() => setFullscreen(true)} />
            <Suspense fallback={<div className="flex h-full w-full items-center justify-center"><span className="text-xs text-white/50">加载 3D 预览...</span></div>}>
              <ThreeLightScene
                direction={direction}
                customAngle={customAngle}
                brightness={brightness}
                color={color}
                viewMode={viewMode}
                width={198}
                height={240}
                imageUrl={imageUrl}
                onLightChange={handleLightChange}
                snapToPreset={snapToPreset}
              />
            </Suspense>
          </div>
        </div>

        {/* Controls */}
        <div className="flex min-w-0 flex-1 flex-col" style={{ gap: 12, minHeight: 288 }}>
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 px-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/40">
                光源
              </span>
              <div className="h-px flex-1 bg-white/[0.06]" />
            </div>

            {/* Brightness */}
            <div className="flex flex-col gap-1 py-1">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[rgb(145,145,145)]">亮度</span>
                <InfoIcon title="控制光源的整体强度。0% 几乎无光，100% 为最亮。" />
                <input
                  type="range"
                  min={0}
                  max={4}
                  step={1}
                  value={brightness}
                  onChange={(e) => setBrightness(Number(e.target.value))}
                  className="angle-slider min-w-0 flex-1 cursor-pointer appearance-none"
                  style={{
                    background: `linear-gradient(to right, #36b5f0 0%, #2b9cd9 ${sliderPct}%, rgba(255,255,255,0.08) ${sliderPct}%, rgba(255,255,255,0.08) 100%)`,
                    height: 6,
                    borderRadius: 3,
                  }}
                />
                <div className="flex items-center gap-0.5">
                  <span className="inline-flex h-6 min-w-[36px] items-center justify-center rounded border border-[rgb(54,54,54)] bg-transparent px-1 text-center text-[12px] tabular-nums text-[rgb(247,247,247)]">
                    {brightnessPct}
                  </span>
                  <span className="text-[11px] text-[rgb(145,145,145)]">%</span>
                </div>
              </div>
              <div className="flex items-center" style={{ paddingLeft: 44, paddingRight: 56 }}>
                <div className="flex min-w-0 flex-1 items-center justify-between">
                  {BRIGHTNESS_TICKS.map((t, i) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setBrightness(i)}
                      className="text-[10px] leading-none transition-colors"
                      style={{
                        color: i === brightness ? "#7bc6f0" : "rgb(110,110,110)",
                        fontWeight: i === brightness ? 500 : 400,
                      }}
                      title={`亮度：${t}（${i * 25}%）`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Color */}
            <div className="flex items-center gap-2 py-1">
              <span className="text-[12px] text-[rgb(145,145,145)]">颜色</span>
              <InfoIcon title="光源色温。暖色（橙黄）适合温馨场景，冷色（蓝白）适合科技/清爽场景。" />
              <button
                type="button"
                className="relative flex h-7 w-10 items-center justify-center overflow-hidden rounded-md border border-[rgb(54,54,54)] transition-colors hover:border-[rgba(54,181,240,0.55)]"
                title="自定义颜色"
                aria-label="自定义颜色"
              >
                <div
                  className="h-full w-full"
                  style={{ backgroundColor: color }}
                />
                <input
                  type="color"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  className="absolute inset-0 cursor-pointer opacity-0"
                />
              </button>
              <div className="flex items-center gap-1">
                {COLOR_PRESETS.map((p) => {
                  const active = color.toLowerCase() === p.hex.toLowerCase();
                  return (
                    <button
                      key={p.hex}
                      type="button"
                      onClick={() => setColor(p.hex)}
                      className="relative h-5 w-5 rounded-full transition-all hover:scale-110"
                      style={{
                        backgroundColor: p.hex,
                        border: active
                          ? "2px solid rgba(54, 181, 240, 0.65)"
                          : "1px solid rgba(255,255,255,0.12)",
                        boxShadow: active ? "0 0 0 2px rgba(54, 181, 240, 0.25)" : "none",
                      }}
                      title={`${p.label}（${p.hex}）`}
                      aria-label={p.label}
                      aria-pressed={active}
                    />
                  );
                })}
              </div>
            </div>

            {/* Direction */}
            <div className="mt-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[12px] text-[rgb(145,145,145)]">主光源方向</span>
                {customAngle && (
                  <span
                    className="rounded px-1.5 py-0.5 text-[9px] font-medium tracking-[0.06em] text-[#7bc6f0]"
                    style={{ background: "rgba(54, 181, 240, 0.12)", border: "1px solid rgba(54, 181, 240, 0.3)" }}
                    title={`方位 ${Math.round(customAngle.az)}° / 仰角 ${Math.round(customAngle.el)}° (拖灯泡自定义)`}
                  >
                    自由 {Math.round(customAngle.az)}° / {Math.round(customAngle.el)}°
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {DIRECTIONS.map((d) => {
                  const active = direction === d.key && !customAngle;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      onClick={() => handlePresetClick(d.key)}
                      className="flex select-none items-center justify-center gap-1 whitespace-nowrap text-center text-[12px] transition-colors"
                      style={{
                        padding: "6px 0",
                        borderRadius: 8,
                        border: active
                          ? "1px solid rgba(54, 181, 240, 0.55)"
                          : "1px solid rgb(54, 54, 54)",
                        backgroundColor: active
                          ? "rgba(54, 181, 240, 0.10)"
                          : "transparent",
                        color: active ? "#7bc6f0" : "rgb(145, 145, 145)",
                        boxShadow: active
                          ? "inset 0 0 12px rgba(54, 181, 240, 0.08)"
                          : "none",
                      }}
                      aria-pressed={active}
                    >
                      <span
                        className="flex h-3 w-3 shrink-0 items-center justify-center"
                        style={{ opacity: active ? 1 : 0.7 }}
                        aria-hidden
                      >
                        <d.Icon />
                      </span>
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {/* Rim Light */}
          <section className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 px-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/40">
                辅助
              </span>
              <div className="h-px flex-1 bg-white/[0.06]" />
            </div>
            <div className="flex items-center gap-2 px-1 py-0.5">
              <span className="text-[12px] text-[rgb(145,145,145)]">轮廓光</span>
              <InfoIcon title="在主体边缘添加一层补光，让人物或物体与背景更好地分离。" />
              <div className="flex-1" />
              <ToggleSwitch checked={rimLight} onChange={setRimLight} />
            </div>
            <div className="flex items-center gap-2 px-1 py-0.5">
              <span className="text-[12px] text-[rgb(145,145,145)]">磁吸</span>
              <InfoIcon title={"关（默认）：停在你松手的位置，自由 X°/Y° 一直是自由。\n开：若 ≤18° 内自动吸到最近预设，跳回预设标签（如 from the front）。"} />
              <div className="flex-1" />
              <ToggleSwitch checked={snapToPreset} onChange={setSnapToPreset} />
            </div>
          </section>
        </div>
      </div>

      {/* Prompt preview */}
      <section className="flex flex-col gap-1.5 px-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-white/40">
            提示词
          </span>
          <div className="h-px flex-1 bg-white/[0.06]" />
        </div>
        <button
          type="button"
          onClick={handleCopyPrompt}
          title="点击复制打光提示词"
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
          <span className="min-w-0 flex-1 truncate text-[11px] text-white/75" title={lightPrompt}>
            {lightPrompt}
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

      <div className="mx-1 h-px bg-white/[0.06]" />

      {/* Footer */}
      <div className="flex items-center" style={{ padding: "0 4px", gap: 4, minHeight: 40 }}>
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
      </div>
      {fullscreenOverlay}
    </div>
  );
}

export const LightEditor = memo(LightEditorInner);
export default LightEditor;

/* ========== Fullscreen 操作台 ========== */

function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ShrinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

/** 内嵌 3D 预览右上角的「全屏操作台」悬浮按钮。 */
function FullscreenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="全屏操作台"
      title="全屏操作台 / 放大 3D 预览"
      style={{
        position: "absolute",
        top: 6,
        right: 6,
        zIndex: 4,
        width: 28,
        height: 28,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        color: "#fff",
        border: "1px solid rgba(255,255,255,0.25)",
        borderRadius: 6,
        cursor: "pointer",
        backdropFilter: "blur(2px)",
      }}
    >
      <ExpandIcon />
    </button>
  );
}

interface LightFullscreenStageProps {
  imageUrl?: string;
  direction: LightDirection;
  customAngle: LightAngle | null;
  brightness: number;
  color: string;
  viewMode: "perspective" | "front";
  snapToPreset: boolean;
  rimLight: boolean;
  lightPrompt: string;
  promptCopied: boolean;
  onViewMode: (m: "perspective" | "front") => void;
  onBrightness: (n: number) => void;
  onColor: (c: string) => void;
  onPreset: (k: LightDirection) => void;
  onLightChange: (t: LightTarget) => void;
  onRim: (v: boolean) => void;
  onSnap: (v: boolean) => void;
  onCopy: () => void;
  resetParams: () => void;
  onInject: () => void;
  onExit: () => void;
}

/**
 * 全屏打光操作台 —— 通过 portal 铺满视口, 提供大尺寸可拖拽光照场景 +
 * 底部悬浮控制栏。复用 ThreeLightScene(响应 width/height)与既有控件。
 * 画布底色本就是深色, 故 punk / default 主题共用同一套深色玻璃风格。
 */
function LightFullscreenStage({
  imageUrl,
  direction,
  customAngle,
  brightness,
  color,
  viewMode,
  snapToPreset,
  rimLight,
  lightPrompt,
  promptCopied,
  onViewMode,
  onBrightness,
  onColor,
  onPreset,
  onLightChange,
  onRim,
  onSnap,
  onCopy,
  resetParams,
  onInject,
  onExit,
}: LightFullscreenStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        setSize({ w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const brightnessPct = BRIGHTNESS_LABELS[brightness] ?? `${brightness * 25}`;
  const sliderPct = (brightness / 4) * 100;

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        background: "rgba(10,10,12,0.94)",
        backdropFilter: "blur(6px)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 顶栏 */}
      <div className="flex items-center" style={{ gap: 12, padding: "12px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <span className="text-[14px] font-medium text-white/90">打光效果 · 全屏操作台</span>
        <span className="text-[11px] text-white/40">拖拽灯泡旋转 · 滑块微调 · ESC 退出</span>
        <div className="flex-1" />
        <div className="flex items-center" style={{ gap: 6, marginRight: 8 }}>
          <ModeTab label="透视" active={viewMode === "perspective"} onClick={() => onViewMode("perspective")} />
          <ModeTab label="正面" active={viewMode === "front"} onClick={() => onViewMode("front")} />
        </div>
        <button
          type="button"
          onClick={onExit}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          style={{ border: "1px solid rgba(255,255,255,0.14)" }}
        >
          <ShrinkIcon />
          退出全屏
        </button>
      </div>

      {/* 大画布 */}
      <div ref={hostRef} className="relative min-h-0 flex-1" style={{ overflow: "hidden" }}>
        {size.w > 1 ? (
          <Suspense
            fallback={
              <div className="flex h-full w-full items-center justify-center">
                <span className="text-sm text-white/50">加载 3D 预览...</span>
              </div>
            }
          >
            <ThreeLightScene
              direction={direction}
              customAngle={customAngle}
              brightness={brightness}
              color={color}
              viewMode={viewMode}
              width={size.w}
              height={size.h}
              imageUrl={imageUrl}
              orbitControls
              onLightChange={onLightChange}
              snapToPreset={snapToPreset}
            />
          </Suspense>
        ) : null}
        {customAngle && (
          <span
            className="absolute left-3 top-3 rounded px-1.5 py-0.5 text-[11px] font-medium tracking-[0.06em] text-[#7bc6f0]"
            style={{ background: "rgba(54,181,240,0.12)", border: "1px solid rgba(54,181,240,0.3)" }}
            title={`方位 ${Math.round(customAngle.az)}° / 仰角 ${Math.round(customAngle.el)}°`}
          >
            自由 {Math.round(customAngle.az)}° / {Math.round(customAngle.el)}°
          </span>
        )}
      </div>

      {/* 底部控制栏 */}
      <div style={{ padding: "12px 16px 16px", borderTop: "1px solid rgba(255,255,255,0.08)", background: "rgba(0,0,0,0.35)" }}>
        <div className="flex items-start" style={{ gap: 24, flexWrap: "wrap", marginBottom: 10 }}>
          {/* 亮度 */}
          <div style={{ minWidth: 280, flex: 1 }}>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-white/70" style={{ width: 36 }}>亮度</span>
              <input
                type="range"
                min={0}
                max={4}
                step={1}
                value={brightness}
                onChange={(e) => onBrightness(Number(e.target.value))}
                className="angle-slider min-w-0 flex-1 cursor-pointer appearance-none"
                style={{
                  background: `linear-gradient(to right, #36b5f0 0%, #2b9cd9 ${sliderPct}%, rgba(255,255,255,0.08) ${sliderPct}%, rgba(255,255,255,0.08) 100%)`,
                  height: 6,
                  borderRadius: 3,
                }}
              />
              <span className="inline-flex h-6 min-w-[44px] items-center justify-center rounded border border-[rgb(54,54,54)] px-1 text-center text-[12px] tabular-nums text-white/90">
                {brightnessPct}%
              </span>
            </div>
            <div className="flex items-center justify-between" style={{ paddingLeft: 44, paddingRight: 52, marginTop: 4 }}>
              {BRIGHTNESS_TICKS.map((t, i) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onBrightness(i)}
                  className="text-[10px] leading-none transition-colors"
                  style={{ color: i === brightness ? "#7bc6f0" : "rgb(110,110,110)", fontWeight: i === brightness ? 500 : 400 }}
                  title={`亮度：${t}（${i * 25}%）`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* 颜色 */}
          <div className="flex items-center gap-2">
            <span className="text-[12px] text-white/70">颜色</span>
            <button
              type="button"
              className="relative flex h-7 w-10 items-center justify-center overflow-hidden rounded-md border border-[rgb(54,54,54)] transition-colors hover:border-[rgba(54,181,240,0.55)]"
              title="自定义颜色"
              aria-label="自定义颜色"
            >
              <div className="h-full w-full" style={{ backgroundColor: color }} />
              <input
                type="color"
                value={color}
                onChange={(e) => onColor(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
              />
            </button>
            <div className="flex items-center gap-1">
              {COLOR_PRESETS.map((p) => {
                const active = color.toLowerCase() === p.hex.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    type="button"
                    onClick={() => onColor(p.hex)}
                    className="relative h-5 w-5 rounded-full transition-all hover:scale-110"
                    style={{
                      backgroundColor: p.hex,
                      border: active ? "2px solid rgba(54, 181, 240, 0.65)" : "1px solid rgba(255,255,255,0.12)",
                      boxShadow: active ? "0 0 0 2px rgba(54, 181, 240, 0.25)" : "none",
                    }}
                    title={`${p.label}（${p.hex}）`}
                    aria-label={p.label}
                    aria-pressed={active}
                  />
                );
              })}
            </div>
          </div>

          {/* 方向 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] uppercase tracking-[0.08em] text-white/40">主光源方向</span>
            <div className="grid grid-cols-3 gap-1.5">
              {DIRECTIONS.map((d) => {
                const active = direction === d.key && !customAngle;
                return (
                  <button
                    key={d.key}
                    type="button"
                    onClick={() => onPreset(d.key)}
                    className="flex select-none items-center justify-center gap-1 whitespace-nowrap text-[12px] transition-colors"
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      border: active ? "1px solid rgba(54, 181, 240, 0.55)" : "1px solid rgb(54, 54, 54)",
                      backgroundColor: active ? "rgba(54, 181, 240, 0.10)" : "transparent",
                      color: active ? "#7bc6f0" : "rgb(160, 160, 160)",
                    }}
                    aria-pressed={active}
                  >
                    <span className="flex h-3 w-3 shrink-0 items-center justify-center" style={{ opacity: active ? 1 : 0.7 }} aria-hidden>
                      <d.Icon />
                    </span>
                    {d.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 开关 */}
          <div className="flex flex-col" style={{ gap: 8 }}>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-white/70">轮廓光</span>
              <div className="flex-1" />
              <ToggleSwitch checked={rimLight} onChange={onRim} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-white/70">磁吸</span>
              <div className="flex-1" />
              <ToggleSwitch checked={snapToPreset} onChange={onSnap} />
            </div>
          </div>
        </div>

        {/* 提示词 + 操作 */}
        <div className="flex items-center" style={{ gap: 12, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onCopy}
            title="点击复制打光提示词"
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left"
            style={{ background: "rgba(54, 181, 240, 0.05)", border: "1px solid rgba(54, 181, 240, 0.12)" }}
          >
            <span className="shrink-0 rounded px-1 py-0.5 text-[10px] font-medium tracking-[0.04em]" style={{ background: "rgba(54, 181, 240, 0.15)", color: "#7bc6f0" }}>
              PROMPT
            </span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-white/75" title={lightPrompt}>
              {lightPrompt}
            </span>
            <span className={`shrink-0 text-[10px] ${promptCopied ? "text-emerald-400" : "text-white/45"}`} aria-live="polite">
              {promptCopied ? "已复制" : "复制"}
            </span>
          </button>
          <button
            type="button"
            onClick={resetParams}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-white/70 transition-colors hover:bg-white/5 hover:text-white"
          >
            <ResetIcon />
            <span>重置</span>
          </button>
          <button
            type="button"
            onClick={onInject}
            className="flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-[13px] font-medium text-white transition-all active:scale-95"
            style={{ background: "linear-gradient(135deg, #36b5f0 0%, #2b9cd9 100%)" }}
          >
            注入 Prompt
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="select-none whitespace-nowrap transition-colors"
      style={{
        padding: "4px 12px",
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
          ? "inset 0 0 12px rgba(54, 181, 240, 0.08)"
          : "none",
      }}
    >
      {label}
    </button>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative flex h-[20px] w-[36px] shrink-0 items-center rounded-full transition-colors"
      style={{
        backgroundColor: checked ? "rgb(54, 181, 240)" : "rgb(82, 82, 82)",
      }}
    >
      <div
        className="h-[16px] w-[16px] rounded-full bg-white shadow transition-transform"
        style={{
          transform: checked ? "translateX(18px)" : "translateX(2px)",
        }}
      />
    </button>
  );
}

function InfoIcon({ title }: { title?: string }) {
  return (
    <span
      className="flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[rgb(82,82,82)] text-[9px] text-[rgb(145,145,145)] transition-colors hover:border-[rgb(134,144,156)] hover:text-[rgb(220,220,220)]"
      title={title}
      aria-label={title}
      role="img"
    >
      ?
    </span>
  );
}

function ResetIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 4v6h6" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
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

function DirLeftIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

function DirRightIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  );
}

function DirTopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="19 12 12 5 5 12" />
    </svg>
  );
}

function DirBottomIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="5 12 12 19 19 12" />
    </svg>
  );
}

function DirFrontIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function DirBackIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
      <line x1="8" y1="8" x2="16" y2="16" />
      <line x1="16" y1="8" x2="8" y2="16" />
    </svg>
  );
}

/* ========== Punk helper components ========== */

function PunkSectionLabel({ children }: { children: ReactNode }) {
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

function PunkModeTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="p-tab"
      style={{
        padding: "3px 12px",
        fontSize: 11,
        letterSpacing: "-0.01em",
        cursor: "pointer",
        ...(active
          ? {
              background: "var(--punk-black)",
              color: "var(--punk-pink)",
              boxShadow: "3px 3px 0 var(--punk-cream)",
              transform: "translate(-2px,-2px) rotate(-1deg)",
            }
          : {}),
      }}
    >
      {label}
    </button>
  );
}

function PunkToggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="p-mono p-upper"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0,
        padding: 0,
        border: "2px solid var(--punk-black)",
        boxShadow: "2px 2px 0 var(--punk-black)",
        background: "var(--punk-cream)",
        fontSize: 10,
        fontWeight: 900,
        letterSpacing: "0.08em",
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          padding: "3px 9px",
          background: checked ? "var(--punk-cream)" : "var(--punk-black)",
          color: checked ? "var(--punk-pink-deep)" : "var(--punk-cream)",
          transition: "background 100ms, color 100ms",
        }}
      >
        OFF
      </span>
      <span style={{ width: 2, alignSelf: "stretch", background: "var(--punk-black)" }} />
      <span
        style={{
          padding: "3px 9px",
          background: checked ? "var(--punk-pink)" : "var(--punk-cream)",
          color: checked ? "var(--punk-black)" : "var(--punk-pink-deep)",
          transition: "background 100ms, color 100ms",
        }}
      >
        ON
      </span>
    </button>
  );
}

function PunkInfoIcon({ title }: { title?: string }) {
  return (
    <span
      className="p-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 14,
        height: 14,
        background: "var(--punk-cream-dim)",
        color: "var(--punk-black)",
        border: "1.5px solid var(--punk-black)",
        fontSize: 9,
        fontWeight: 900,
        cursor: "help",
        flexShrink: 0,
      }}
      title={title}
      aria-label={title}
      role="img"
    >
      ?
    </span>
  );
}
