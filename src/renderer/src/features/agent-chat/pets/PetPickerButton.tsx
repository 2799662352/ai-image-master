// src/renderer/src/features/agent-chat/pets/PetPickerButton.tsx
/**
 * Composer 工具栏的宠物入口:只显示爪印图标的方形小按钮,宠物名放在
 * title / aria-label 里。点击开/关 `/pets` 选择器(选择器本体由 PetOverlay
 * 渲染在 composer 上方)。`/pets` 命令仍然可用,这只是给鼠标党的等价入口。
 */

import { usePetStore, useSelectedPet } from './petStore'

export function PetPickerButton({ disabled }: { disabled?: boolean }) {
  const pickerOpen = usePetStore((s) => s.pickerOpen)
  const openPicker = usePetStore((s) => s.openPicker)
  const closePicker = usePetStore((s) => s.closePicker)

  const current = useSelectedPet()
  const label = current?.displayName ?? '宠物'

  return (
    <button
      type="button"
      data-testid="agent-pet-picker-button"
      data-selected={current ? 'true' : 'false'}
      disabled={disabled}
      onClick={() => (pickerOpen ? closePicker() : openPicker())}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-zinc-900/70 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50 ${
        pickerOpen ? 'border-cyan-300/60 text-cyan-100' : current ? 'border-zinc-700/80 text-cyan-200/90' : 'border-zinc-700/80 text-zinc-400'
      }`}
      aria-haspopup="dialog"
      aria-expanded={pickerOpen}
      aria-label={`宠物：${label}`}
      title={`宠物 · ${label}(/pets)`}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
        <circle cx="3.6" cy="5.4" r="1.5" fill="currentColor" />
        <circle cx="8" cy="3.6" r="1.6" fill="currentColor" />
        <circle cx="12.4" cy="5.4" r="1.5" fill="currentColor" />
        <path
          d="M8 7.2c-2.5 0-4.5 2-4.5 4 0 1.4 1 2.2 2.2 2.2.9 0 1.5-.5 2.3-.5s1.4.5 2.3.5c1.2 0 2.2-.8 2.2-2.2 0-2-2-4-4.5-4Z"
          fill="currentColor"
        />
      </svg>
    </button>
  )
}
