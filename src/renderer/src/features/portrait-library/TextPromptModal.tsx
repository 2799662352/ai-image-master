// 自建文本输入弹窗 —— Electron 渲染进程不实现 `window.prompt`(始终返回 null),
// 改名 / 新建分组必须用这个。
//
// 组件自持输入态,避免父组件每次 render 抢焦点。

import { useState } from 'react'

export function TextPromptModal({
  title,
  placeholder,
  initial,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  placeholder?: string
  initial: string
  confirmLabel: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const [val, setVal] = useState(initial)
  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-6" onClick={onCancel}>
      <div
        className="w-full max-w-sm bg-zinc-900 border border-cyberpunk-yellow/40 rounded-lg p-4 flex flex-col gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-bold text-white">{title}</h3>
        <input
          autoFocus
          value={val}
          placeholder={placeholder}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onConfirm(val)
            else if (e.key === 'Escape') onCancel()
          }}
          className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded w-full"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 bg-zinc-800 border border-zinc-600 text-zinc-300 text-sm rounded hover:bg-zinc-700"
          >
            取消
          </button>
          <button
            onClick={() => onConfirm(val)}
            className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black font-bold text-sm rounded hover:opacity-90"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
