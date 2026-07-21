// src/renderer/src/features/agent-chat/pets/PetPickerButton.tsx
/**
 * Composer 工具栏的宠物入口按钮:和旁边的 ModelPicker / ImageChannelPicker
 * 同款药丸样式(icon + 标签 + 上下箭头),点击开/关 `/pets` 选择器
 * (选择器本体由 PetOverlay 渲染在 composer 上方)。`/pets` 命令仍然可用,
 * 这只是给鼠标党的等价入口。
 */

import { BUILT_IN_PETS } from './petAnimations'
import { usePetStore } from './petStore'

export function PetPickerButton({ disabled }: { disabled?: boolean }) {
  const petId = usePetStore((s) => s.petId)
  const pickerOpen = usePetStore((s) => s.pickerOpen)
  const openPicker = usePetStore((s) => s.openPicker)
  const closePicker = usePetStore((s) => s.closePicker)

  const current = petId ? BUILT_IN_PETS.find((p) => p.id === petId) : undefined
  const label = current?.displayName ?? '宠物'

  return (
    <button
      type="button"
      data-testid="agent-pet-picker-button"
      disabled={disabled}
      onClick={() => (pickerOpen ? closePicker() : openPicker())}
      className="flex items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
      aria-haspopup="dialog"
      aria-expanded={pickerOpen}
      aria-label={`宠物：${label}`}
      title={`宠物 · ${label}(/pets)`}
    >
      {/* 爪印 icon,尺寸/透明度对齐邻位 picker 的 icon */}
      <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="opacity-80">
        <circle cx="3.6" cy="5.4" r="1.5" fill="currentColor" />
        <circle cx="8" cy="3.6" r="1.6" fill="currentColor" />
        <circle cx="12.4" cy="5.4" r="1.5" fill="currentColor" />
        <path
          d="M8 7.2c-2.5 0-4.5 2-4.5 4 0 1.4 1 2.2 2.2 2.2.9 0 1.5-.5 2.3-.5s1.4.5 2.3.5c1.2 0 2.2-.8 2.2-2.2 0-2-2-4-4.5-4Z"
          fill="currentColor"
        />
      </svg>
      <span className="font-medium">{label}</span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 12 12"
        aria-hidden
        className={`opacity-70 transition ${pickerOpen ? 'rotate-180' : ''}`}
      >
        <path
          d="M2 4l4 4 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )
}
