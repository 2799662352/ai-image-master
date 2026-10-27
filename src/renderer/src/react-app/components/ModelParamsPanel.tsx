import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import {
  resolveModelParams,
  type ModelParamSpec,
  type ModelParamValue,
} from '../../../../shared/imageModelParams'

/**
 * ModelParamsPanel —— 「模型专属参数」面板(悠船:原生 2K / 混沌 / 风格化 / 风格参考……)。
 *
 * 数据驱动:每个控件都从 `ModelParamSpec` 渲染,不认识任何具体模型。参数表在
 * `shared/imageModelParams`,MCP 的 `modelParams` schema、`ApiService` 的请求体装配、
 * 这里的界面都读同一张,加一个参数只改那一处。
 *
 * ## 「不设置 = 自动」
 *
 * 高级参数默认折叠、默认全部不设置,「由模型自动决定」。只有声明了 `defaultValue` 的
 * (原生 2K 默认开)才有默认态。组件不持有状态(除 urls 输入框的草稿):`values` 只含用户
 * **显式设置**的项,清空 / 改回默认就是删键 —— 「全部恢复自动」因此不需要知道每个默认值。
 */

interface ModelParamsPanelProps {
  specs: readonly ModelParamSpec[]
  /** 用户显式设置的值(没有的键 = 自动 / 默认)。 */
  values: Record<string, ModelParamValue>
  /** value 为 undefined 即「回到自动」;带上 defaultValue 让 store 在「等于默认」时也删键。 */
  onChange: (key: string, value: ModelParamValue | undefined, defaultValue?: ModelParamValue) => void
  onReset: () => void
  className?: string
}

const CARD = 'border-2 border-zinc-700 bg-zinc-900/60 p-3'
const CONTROL =
  'w-full px-2.5 py-1.5 bg-zinc-800 border-2 border-zinc-700 text-white text-sm font-mono focus:outline-none focus:border-cyberpunk-yellow placeholder:text-zinc-500'
const HINT = 'mt-1.5 font-mono text-[10px] leading-snug text-zinc-400'

function FieldLabel({ children }: { children: string }) {
  return (
    <div className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80">
      {`// ${children}`}
    </div>
  )
}

/** 链接列表输入:本地保存草稿文本,否则输入换行时会被「去空行后的数组」吞掉,永远打不出第二行。 */
function UrlsField({
  spec,
  value,
  onChange,
}: {
  spec: ModelParamSpec
  value: ModelParamValue | undefined
  onChange: (value: ModelParamValue | undefined) => void
}) {
  const stored = Array.isArray(value) ? value : []
  const [draft, setDraft] = useState(stored.join('\n'))

  // 外部清空(全部恢复自动)时同步回来;只在「草稿解析结果 ≠ 已存值」时覆盖,免得打断输入。
  useEffect(() => {
    const parsed = draft.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    if (JSON.stringify(parsed) !== JSON.stringify(stored)) setDraft(stored.join('\n'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <textarea
      value={draft}
      rows={3}
      placeholder={`每行一个链接，最多 ${spec.maxItems ?? 20} 个`}
      aria-label={spec.label}
      data-testid={`model-param-${spec.key}`}
      className={`${CONTROL} resize-y`}
      onChange={(e) => {
        const text = e.target.value
        setDraft(text)
        const list = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        onChange(list.length > 0 ? list : undefined)
      }}
    />
  )
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: ModelParamSpec
  value: ModelParamValue | undefined
  onChange: ModelParamsPanelProps['onChange']
}) {
  const testId = `model-param-${spec.key}`

  switch (spec.type) {
    case 'switch': {
      const defaultOn = spec.defaultValue === true
      const on = typeof value === 'boolean' ? value : defaultOn
      return (
        <select
          value={on ? 'on' : 'off'}
          aria-label={spec.label}
          data-testid={testId}
          className={`${CONTROL} cursor-pointer`}
          onChange={(e) => {
            const next = e.target.value === 'on'
            // 没有产品默认的开关,「关」就是不设置(删键),而不是显式发一个 false。
            if (spec.defaultValue === undefined) onChange(spec.key, next ? true : undefined)
            else onChange(spec.key, next, spec.defaultValue)
          }}
        >
          <option value="off">{defaultOn ? '否' : '否 默认'}</option>
          <option value="on">{defaultOn ? '是 默认' : '是'}</option>
        </select>
      )
    }

    case 'select':
      return (
        <select
          value={value === undefined ? '' : String(value)}
          aria-label={spec.label}
          data-testid={testId}
          className={`${CONTROL} cursor-pointer`}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return onChange(spec.key, undefined)
            onChange(spec.key, spec.valueType === 'number' ? Number(raw) : raw)
          }}
        >
          <option value="">自动</option>
          {(spec.options ?? []).map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      )

    case 'number':
      return (
        <input
          type="number"
          inputMode={spec.integer ? 'numeric' : 'decimal'}
          step={spec.step ?? 1}
          min={spec.min}
          max={spec.max}
          value={typeof value === 'number' ? value : ''}
          placeholder="自动"
          aria-label={spec.label}
          data-testid={testId}
          className={CONTROL}
          onChange={(e) => {
            const raw = e.target.value
            if (raw.trim() === '') return onChange(spec.key, undefined)
            const n = Number(raw)
            onChange(spec.key, Number.isFinite(n) ? n : undefined)
          }}
        />
      )

    case 'text':
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          maxLength={spec.maxLength}
          placeholder="自动"
          aria-label={spec.label}
          data-testid={testId}
          className={CONTROL}
          onChange={(e) => onChange(spec.key, e.target.value === '' ? undefined : e.target.value)}
        />
      )

    case 'urls':
      return <UrlsField spec={spec} value={value} onChange={(v) => onChange(spec.key, v)} />
  }
}

function ParamCard({
  spec,
  value,
  onChange,
}: {
  spec: ModelParamSpec
  value: ModelParamValue | undefined
  onChange: ModelParamsPanelProps['onChange']
}) {
  return (
    <div className={`${CARD} ${spec.type === 'urls' ? 'sm:col-span-2' : ''}`}>
      <FieldLabel>{spec.label}</FieldLabel>
      <ParamControl spec={spec} value={value} onChange={onChange} />
      {spec.description && <p className={HINT}>{spec.description}</p>}
    </div>
  )
}

export function ModelParamsPanel({ specs, values, onChange, onReset, className }: ModelParamsPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  if (specs.length === 0) return null

  const primary = specs.filter((s) => !s.advanced)
  const advanced = specs.filter((s) => s.advanced)
  const advancedSetCount = advanced.filter((s) => values[s.key] !== undefined).length
  const dirtyCount = Object.keys(values).length
  // 界面上逐项给出越界提示;出网前 ApiService 还会再校验一次,这里只是让用户早点看见。
  const { errors } = resolveModelParams(specs, values)

  return (
    <div className={className ?? 'grid gap-3'} data-testid="model-params-panel">
      {primary.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {primary.map((spec) => (
            <ParamCard key={spec.key} spec={spec} value={values[spec.key]} onChange={onChange} />
          ))}
        </div>
      )}

      {advanced.length > 0 && (
        <div className={CARD}>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              aria-expanded={advancedOpen}
              data-testid="model-params-advanced-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80 hover:text-cyberpunk-yellow"
            >
              {advancedOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
              {'// 高级参数'}
              {advancedSetCount > 0 && (
                <span className="ml-1 text-zinc-300" data-testid="model-params-set-count">
                  {`已设置 ${advancedSetCount} 项`}
                </span>
              )}
            </button>
            <button
              type="button"
              data-testid="model-params-reset"
              disabled={dirtyCount === 0}
              onClick={onReset}
              className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-zinc-400 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw size={11} aria-hidden />
              全部恢复自动
            </button>
          </div>
          <p className={HINT}>不设置的项由模型自动决定，一般保持默认即可。</p>

          {advancedOpen && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2" data-testid="model-params-advanced">
              {advanced.map((spec) => (
                <ParamCard key={spec.key} spec={spec} value={values[spec.key]} onChange={onChange} />
              ))}
            </div>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <p role="alert" data-testid="model-params-errors" className="font-mono text-[11px] text-red-400">
          {errors.join('；')}
        </p>
      )}
    </div>
  )
}
