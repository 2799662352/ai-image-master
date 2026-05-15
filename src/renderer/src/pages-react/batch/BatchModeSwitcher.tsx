import type { BatchMode } from '../../stores/useBatchStore'

interface Props {
  mode: BatchMode
  onChange: (m: BatchMode) => void
}

interface TabDef {
  key: BatchMode
  label: string
  hint: string
}

const TABS: TabDef[] = [
  { key: 'card',  label: '抽卡',   hint: 'GACHA — 单条提示词,跑 N 张' },
  { key: 'multi', label: '多提示', hint: 'MULTI — 整段文本,重复跑' },
]

/**
 * BatchModeSwitcher - 抽卡 / 多提示词 模式切换
 * 替代 PunkModeSwitcher 的倾斜 P5 tab 风格,现在是干净的 underline tab。
 */
export default function BatchModeSwitcher({ mode, onChange }: Props) {
  return (
    <div role="tablist" aria-label="批量生成模式" className="flex items-end gap-1 border-b border-zinc-800">
      {TABS.map((t) => {
        const active = t.key === mode
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.key)}
            title={t.hint}
            className={`relative px-4 py-2 font-mono text-sm uppercase tracking-wider transition-colors -mb-px border-b-2 ${
              active
                ? 'text-cyberpunk-yellow border-cyberpunk-yellow'
                : 'text-zinc-500 border-transparent hover:text-zinc-200'
            }`}
          >
            <span>{t.label}</span>
            <span className="ml-2 text-[10px] opacity-60">
              // {t.key === 'card' ? 'GACHA' : 'MULTI'}
            </span>
          </button>
        )
      })}
      <span className="ml-auto self-center font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
        mode / {mode === 'card' ? '01' : '02'}
      </span>
    </div>
  )
}
