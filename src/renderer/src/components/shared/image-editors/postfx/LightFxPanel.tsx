/**
 * LightFxPanel —— 光感 / 调色统一 UI 组件(全景图编辑器 + 3D 导演台共用)。
 *
 * 设计目标(见 docs/导演台-光感后处理-集成计划.md):
 * - 「导演台有什么,全景这边也要有」:同一套控件、同一份参数形状(LightFxValue),
 *   两端只是 accent 配色不同(导演台青、全景橙)+ 个别区段是否显示不同。
 * - 纯展示组件:不持有 three.js,只发 onChange(patch);宿主负责把 patch 应用到管线。
 * - 控件:曝光 / 辉光 / 对比 / 饱和 / 色温 / 暗角 / 颗粒 + 色调映射下拉
 *   + 可选 IBL(环境光照,仅对 PBR 材质有效)+ 可选 景深 DoF。
 * - 样式按 DESIGN.md:暗底、caption 小标题、accent 高亮、44px 不强求(滑杆按桌面端)。
 */
import type { CSSProperties } from 'react'
import type { LightFxValue, ToneMappingMode } from './lightFxConstants'

export interface LightFxPanelProps {
  value: LightFxValue
  onChange: (patch: Partial<LightFxValue>) => void
  /** 主题色(导演台 #22d3ee / 全景 #f54e00). */
  accent?: string
  /** 显示「环境光照 IBL」区段(仅在有 PBR 模型 + 全景背景时有意义). 默认 false. */
  showIbl?: boolean
  /** 显示「景深 DoF」区段. 默认 true. */
  showDof?: boolean
  /** 小标题文案. 默认「光感 / 调色 (后处理)」. */
  title?: string
}

const TONE_OPTIONS: { value: ToneMappingMode; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'none', label: '关' },
  { value: 'agx', label: 'AgX' },
  { value: 'aces', label: 'ACES' },
  { value: 'neutral', label: '中性' },
]

export default function LightFxPanel({
  value,
  onChange,
  accent = '#22d3ee',
  showIbl = false,
  showDof = true,
  title = '光感 / 调色 (后处理)',
}: LightFxPanelProps): React.ReactElement {
  const section: CSSProperties = {
    fontSize: 11,
    color: '#7c8696',
    margin: '10px 0 6px',
    borderTop: '1px solid #23262f',
    paddingTop: 8,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  }
  const row: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    margin: '6px 0',
  }
  const rowLabel: CSSProperties = { fontSize: 12, color: '#9aa3b2' }
  const select: CSSProperties = {
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid #333a46',
    color: '#cdd3dd',
    borderRadius: 6,
    padding: '3px 6px',
    fontSize: 12,
    cursor: 'pointer',
  }

  return (
    <div>
      <div style={section}>{title}</div>

      <Fx label="曝光" min={0.2} max={3} step={0.01} value={value.exposure} accent={accent} onChange={(v) => onChange({ exposure: v })} />
      <Fx label="辉光" min={0} max={2} step={0.01} value={value.bloom} accent={accent} onChange={(v) => onChange({ bloom: v })} />
      <Fx label="对比度" min={0.5} max={2} step={0.01} value={value.contrast} accent={accent} onChange={(v) => onChange({ contrast: v })} />
      <Fx label="饱和度" min={0} max={2} step={0.01} value={value.saturation} accent={accent} onChange={(v) => onChange({ saturation: v })} />
      <Fx label="色温" min={-1} max={1} step={0.01} value={value.temperature} accent={accent} onChange={(v) => onChange({ temperature: v })} />
      <Fx label="暗角" min={0} max={1} step={0.01} value={value.vignette} accent={accent} onChange={(v) => onChange({ vignette: v })} />
      <Fx label="颗粒" min={0} max={0.3} step={0.005} value={value.grain} accent={accent} onChange={(v) => onChange({ grain: v })} />

      <label style={{ ...row, cursor: 'pointer' }}>
        <span style={rowLabel}>色调映射</span>
        <select
          style={select}
          value={value.toneMapping}
          onChange={(e) => onChange({ toneMapping: e.target.value as ToneMappingMode })}
        >
          {TONE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {showIbl && (
        <>
          <label style={{ ...row, cursor: 'pointer' }}>
            <span style={rowLabel}>环境光照 IBL</span>
            <input
              type="checkbox"
              checked={value.envEnabled}
              style={{ accentColor: accent }}
              onChange={(e) => onChange({ envEnabled: e.target.checked })}
            />
          </label>
          {value.envEnabled && (
            <Fx
              label="环境强度"
              min={0}
              max={3}
              step={0.05}
              value={value.envIntensity}
              accent={accent}
              onChange={(v) => onChange({ envIntensity: v })}
            />
          )}
        </>
      )}

      {showDof && (
        <>
          <label style={{ ...row, cursor: 'pointer' }}>
            <span style={rowLabel}>景深 DoF</span>
            <input
              type="checkbox"
              checked={value.dofEnabled}
              style={{ accentColor: accent }}
              onChange={(e) => onChange({ dofEnabled: e.target.checked })}
            />
          </label>
          {value.dofEnabled && (
            <>
              <Fx
                label="对焦距离"
                min={0.5}
                max={50}
                step={0.5}
                value={value.dofFocus}
                accent={accent}
                onChange={(v) => onChange({ dofFocus: v })}
              />
              <Fx
                label="虚化强度"
                min={0}
                max={1}
                step={0.02}
                value={value.dofMaxBlur / 0.012}
                accent={accent}
                onChange={(v) => onChange({ dofAperture: v * 0.0008, dofMaxBlur: v * 0.012 })}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

/** 内置滑杆(accent 着色,数值右对齐),不依赖各编辑器自己的 Slider. */
function Fx({
  label,
  min,
  max,
  step,
  value,
  accent,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  accent: string
  onChange: (v: number) => void
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
      <span style={{ fontSize: 11, color: '#9aa3b2', width: 52 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        style={{ flex: 1, accentColor: accent }}
      />
      <span
        style={{
          fontSize: 11,
          color: '#cbd2dd',
          width: 42,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {Number.isInteger(step) ? Math.round(value) : value.toFixed(2)}
      </span>
    </div>
  )
}
