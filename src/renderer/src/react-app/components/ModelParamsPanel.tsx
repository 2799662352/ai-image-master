import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Plus, RotateCcw, Trash2 } from 'lucide-react'
import {
  resolveModelParams,
  type CharacterParamValue,
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
 * (悠船原生 2K 默认开;NovelAI 的步数 / CFG / 采样器……)才有默认态,输入框的占位文案写成
 * 「默认 23」而不是「自动」。组件不持有状态(除 urls 输入框的草稿):`values` 只含用户
 * **显式设置**的项,清空 / 改回默认就是删键 —— 「全部恢复自动」因此不需要知道每个默认值。
 *
 * 角色提示词(`characters`)是列表型参数:每行一个角色(启用开关 + 提示词 + 不想要的内容 + 位置),
 * 位置用 3×3 预设格点 + x / y 微调;留空的草稿行不外发(见 `resolveModelParams`)。
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

/** 位置预设:3×3 格点的中心。0.2 / 0.5 / 0.8 避开贴边,与 NovelAI 官方的网格取向一致(左上 → 右下)。 */
const POSITION_STEPS = [0.2, 0.5, 0.8] as const
const POSITION_NAMES = [
  ['左上', '上中', '右上'],
  ['左中', '居中', '右中'],
  ['左下', '下中', '右下'],
] as const

function isListedCharacter(value: unknown): value is CharacterParamValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 角色提示词列表。值是「用户显式设置」的完整行(含没填的草稿行与关掉的行),原样放在 store 里;
 * 草稿 / 关掉的行由校验丢弃,这样切走再切回来用户的输入不会丢。
 */
function CharactersField({
  spec,
  value,
  onChange,
}: {
  spec: ModelParamSpec
  value: ModelParamValue | undefined
  onChange: (value: ModelParamValue | undefined) => void
}) {
  const list: CharacterParamValue[] = Array.isArray(value)
    ? (value as unknown[]).filter(isListedCharacter)
    : []
  const max = spec.maxItems ?? 22
  const commit = (next: CharacterParamValue[]) => onChange(next.length > 0 ? next : undefined)
  const patch = (index: number, change: Partial<CharacterParamValue>) =>
    commit(list.map((c, i) => (i === index ? { ...c, ...change } : c)))
  const toPosition = (raw: string): number => {
    if (raw.trim() === '') return 0.5
    const n = Number(raw)
    return Number.isFinite(n) ? n : 0.5
  }

  return (
    <div className="grid gap-2" data-testid={`model-param-${spec.key}`}>
      {list.map((c, index) => {
        const no = index + 1
        const disabled = c.enabled === false
        return (
          <div
            key={index}
            data-testid={`character-row-${index}`}
            className={`grid gap-2 border-2 border-zinc-700 bg-zinc-950/60 p-2 ${disabled ? 'opacity-60' : ''}`}
          >
            <div className="flex items-center justify-between gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-zinc-200">
                <input
                  type="checkbox"
                  checked={!disabled}
                  aria-label={`启用角色 ${no}`}
                  onChange={(e) => patch(index, { enabled: e.target.checked ? undefined : false })}
                />
                {`角色 ${no}`}
              </label>
              <button
                type="button"
                aria-label={`删除角色 ${no}`}
                onClick={() => commit(list.filter((_, i) => i !== index))}
                className="text-zinc-400 hover:text-red-400"
              >
                <Trash2 size={13} aria-hidden />
              </button>
            </div>
            <textarea
              rows={2}
              value={c.prompt ?? ''}
              maxLength={2000}
              placeholder="这个角色的提示词，如：1girl, silver hair, smile"
              aria-label={`角色 ${no} 提示词`}
              className={`${CONTROL} resize-y`}
              onChange={(e) => patch(index, { prompt: e.target.value })}
            />
            <input
              type="text"
              value={c.uc ?? ''}
              maxLength={1000}
              placeholder="不想要的内容（可选）"
              aria-label={`角色 ${no} 不想要的内容`}
              className={CONTROL}
              onChange={(e) => patch(index, { uc: e.target.value === '' ? undefined : e.target.value })}
            />
            <div className="flex flex-wrap items-center gap-3">
              <div
                role="group"
                aria-label={`角色 ${no} 位置`}
                className="grid grid-cols-3 gap-0.5"
              >
                {POSITION_STEPS.map((py, row) =>
                  POSITION_STEPS.map((px, col) => {
                    const active = Math.abs((c.x ?? 0.5) - px) < 0.05 && Math.abs((c.y ?? 0.5) - py) < 0.05
                    return (
                      <button
                        key={`${row}-${col}`}
                        type="button"
                        aria-label={`角色 ${no} 放在${POSITION_NAMES[row][col]}`}
                        aria-pressed={active}
                        onClick={() => patch(index, { x: px, y: py })}
                        className={`h-4 w-4 border ${
                          active
                            ? 'border-cyberpunk-yellow bg-cyberpunk-yellow'
                            : 'border-zinc-600 bg-zinc-800 hover:border-zinc-400'
                        }`}
                      />
                    )
                  }),
                )}
              </div>
              <label className="flex items-center gap-1 font-mono text-[10px] uppercase text-zinc-400">
                x
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  value={c.x ?? 0.5}
                  aria-label={`角色 ${no} 位置 x`}
                  className={`${CONTROL} w-20`}
                  onChange={(e) => patch(index, { x: toPosition(e.target.value) })}
                />
              </label>
              <label className="flex items-center gap-1 font-mono text-[10px] uppercase text-zinc-400">
                y
                <input
                  type="number"
                  step={0.05}
                  min={0}
                  max={1}
                  value={c.y ?? 0.5}
                  aria-label={`角色 ${no} 位置 y`}
                  className={`${CONTROL} w-20`}
                  onChange={(e) => patch(index, { y: toPosition(e.target.value) })}
                />
              </label>
            </div>
          </div>
        )
      })}
      <button
        type="button"
        data-testid="characters-add"
        disabled={list.length >= max}
        onClick={() => commit([...list, { prompt: '', x: 0.5, y: 0.5 }])}
        className="flex w-fit items-center gap-1 border-2 border-zinc-700 bg-zinc-800 px-2.5 py-1 font-mono text-[11px] text-zinc-200 hover:border-cyberpunk-yellow disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Plus size={12} aria-hidden />
        {list.length >= max ? `已达上限 ${max} 个` : '添加角色'}
      </button>
    </div>
  )
}

/** 有产品默认值的参数,「未设置」读作「默认 X」而不是「自动」。 */
function unsetLabel(spec: ModelParamSpec): string {
  if (spec.defaultValue === undefined) return '自动'
  if (spec.type === 'select') {
    const hit = (spec.options ?? []).find((o) => o.key === String(spec.defaultValue))
    return `默认（${hit?.label ?? String(spec.defaultValue)}）`
  }
  return `默认 ${String(spec.defaultValue)}`
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
          value={value === undefined || (spec.defaultValue !== undefined && String(value) === String(spec.defaultValue)) ? '' : String(value)}
          aria-label={spec.label}
          data-testid={testId}
          className={`${CONTROL} cursor-pointer`}
          onChange={(e) => {
            const raw = e.target.value
            if (raw === '') return onChange(spec.key, undefined)
            // 带上 defaultValue:选回默认项就是「未设置」(删键),与清空等价。
            const next = spec.valueType === 'number' ? Number(raw) : raw
            if (spec.defaultValue === undefined) onChange(spec.key, next)
            else onChange(spec.key, next, spec.defaultValue)
          }}
        >
          <option value="">{unsetLabel(spec)}</option>
          {(spec.options ?? []).filter((o) => spec.defaultValue === undefined || o.key !== String(spec.defaultValue)).map((o) => (
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
          placeholder={unsetLabel(spec)}
          aria-label={spec.label}
          data-testid={testId}
          className={CONTROL}
          onChange={(e) => {
            const raw = e.target.value
            if (raw.trim() === '') return onChange(spec.key, undefined)
            const n = Number(raw)
            const next = Number.isFinite(n) ? n : undefined
            if (spec.defaultValue === undefined) onChange(spec.key, next)
            else onChange(spec.key, next, spec.defaultValue)
          }}
        />
      )

    case 'text':
      if (spec.multiline) {
        return (
          <textarea
            rows={3}
            value={typeof value === 'string' ? value : ''}
            maxLength={spec.maxLength}
            placeholder={unsetLabel(spec)}
            aria-label={spec.label}
            data-testid={testId}
            className={`${CONTROL} resize-y`}
            onChange={(e) => onChange(spec.key, e.target.value === '' ? undefined : e.target.value)}
          />
        )
      }
      return (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          maxLength={spec.maxLength}
          placeholder={unsetLabel(spec)}
          aria-label={spec.label}
          data-testid={testId}
          className={CONTROL}
          onChange={(e) => onChange(spec.key, e.target.value === '' ? undefined : e.target.value)}
        />
      )

    case 'urls':
      return <UrlsField spec={spec} value={value} onChange={(v) => onChange(spec.key, v)} />

    case 'characters':
      return <CharactersField spec={spec} value={value} onChange={(v) => onChange(spec.key, v)} />
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
    <div
      className={`${CARD} ${
        spec.type === 'urls' || spec.type === 'characters' || (spec.type === 'text' && spec.multiline)
          ? 'sm:col-span-2'
          : ''
      }`}
    >
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
