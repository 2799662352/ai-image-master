import { useEffect, useRef, useState } from 'react'
import { IMAGE_CHANNELS, findImageChannel } from './imageChannels'
import { useAgentChatStore } from './store'

interface ImageChannelPickerProps {
  disabled?: boolean
}

/**
 * Composer-footer dropdown that lets the user pick which image *channel* the
 * chat renders on (VIP / 腾讯 / Nano2 / Wan2.7). The selection is authoritative:
 * every `generate_image` the agent runs uses it — the mirror of the GPT model
 * picker sitting right next to it. Options come straight from `IMAGE_CHANNELS`
 * so the list tracks the registry automatically.
 */
export function ImageChannelPicker({ disabled }: ImageChannelPickerProps) {
  const selectedImageChannel = useAgentChatStore((state) => state.selectedImageChannel)
  const setSelectedImageChannel = useAgentChatStore((state) => state.setSelectedImageChannel)

  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const selected = findImageChannel(selectedImageChannel) ?? IMAGE_CHANNELS[0]

  useEffect(() => {
    if (!isOpen) return undefined
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen])

  function handlePick(id: string) {
    setSelectedImageChannel(id)
    setIsOpen(false)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition hover:border-fuchsia-400/40 hover:text-fuchsia-100 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={`出图渠道：${selected.fullLabel}`}
        title={`出图渠道 · ${selected.fullLabel}`}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="opacity-80">
          <path
            d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-9Zm3.5 1A1.5 1.5 0 1 0 5.5 7 1.5 1.5 0 0 0 5.5 4.5Zm7 6.5-3-4-2.5 3-1.5-1.5L3.5 12h9Z"
            fill="currentColor"
          />
        </svg>
        <span className="font-medium">{selected.label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden
          className={`opacity-70 transition ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-[40001] mb-2 w-[280px] overflow-hidden rounded-lg border border-fuchsia-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          <div className="border-b border-zinc-800/80 px-3 py-1.5 text-[9px] uppercase tracking-[0.18em] text-zinc-500">
            出图渠道
          </div>
          <div className="max-h-[320px] overflow-y-auto py-1">
            {IMAGE_CHANNELS.map((c) => {
              const isActive = c.id === selectedImageChannel
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => handlePick(c.id)}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition ${
                    isActive
                      ? 'bg-fuchsia-500/10 text-fuchsia-100'
                      : 'text-zinc-200 hover:bg-zinc-800/60 hover:text-fuchsia-100'
                  }`}
                  title={c.description}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{c.fullLabel}</span>
                    <span className="truncate text-[10px] text-zinc-500">{c.description}</span>
                  </span>
                  {isActive ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden className="shrink-0">
                      <path
                        d="M2 6l3 3 5-6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        fill="none"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>
              )
            })}
          </div>
          <div className="border-t border-zinc-800/80 px-3 py-1.5 text-[10px] text-zinc-500">
            选中的渠道决定 chat 出图用哪个模型
          </div>
        </div>
      ) : null}
    </div>
  )
}
