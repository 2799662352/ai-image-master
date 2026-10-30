import { useEffect, useMemo, useRef, useState } from 'react'
import { ImageChannelPanel } from './ImageChannelPanel'
import { channelTriggerBadge, placeImageChannels } from './imageChannelPlacement'
import { usePopoverPlacement } from './usePopoverPlacement'
import { useAgentChatStore } from './store'

interface ImageChannelPickerProps {
  disabled?: boolean
}

/**
 * Composer-footer dropdown that lets the user pick which image *channel* the
 * chat renders on (腾讯 image2 / 2.5 Flare / Sunburst / Seedream / Nano / 万相 / NovelAI …).
 * The selection is the DEFAULT for every `generate_image` the agent runs — the mirror of
 * the GPT model picker sitting right next to it (agent 显式传的合法 model 优先,见
 * `AgentToolExecutor.resolveEffectiveImageChannel`)。
 *
 * 弹层是两栏「分区导航」面板(`ImageChannelPanel`,复刻 sora-ui 网页版的图像模型下拉):
 * 左边 最近使用 / 常用 / 备用渠道 / 更多模型·按系列,右边是该分区的渠道。选项来自
 * `IMAGE_CHANNELS`,摆放见 `imageChannelPlacement`;选择仍写进 `selectedImageChannel`,
 * 对 store / MCP 没有任何改动。
 */
export function ImageChannelPicker({ disabled }: ImageChannelPickerProps) {
  const selectedImageChannel = useAgentChatStore((state) => state.selectedImageChannel)
  const setSelectedImageChannel = useAgentChatStore((state) => state.setSelectedImageChannel)

  const [isOpen, setIsOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  // 弹层的左右位置:贴着触发按钮,但整块落在输入框(form)的左右边界内。窗口 / 聊天面板缩小后
  // 不再冲出面板被裁掉。没有布局(jsdom)时为 null,走 CSS 默认尺寸。见 popoverPlacement.ts。
  const placement = usePopoverPlacement(rootRef, isOpen)

  const channels = useMemo(() => placeImageChannels(), [])
  const selected = channels.find((c) => c.id === selectedImageChannel) ?? channels[0]
  const badge = channelTriggerBadge(selected)

  useEffect(() => {
    if (!isOpen) return undefined
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      setIsOpen(false)
      // 焦点还在弹层里时,收起后把焦点还给触发按钮,键盘用户不会掉到页面顶部。
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus()
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
    // 药丸宽度不够时只让渠道名用省略号收短(root 可收缩、有下限);窄到一定程度徽标先收起,
    // 形状 / 高度不变,完整渠道名在 title / aria-label 里。分级见 toolbarCompact.ts。
    <div ref={rootRef} className="relative min-w-[4.5rem]">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((v) => !v)}
        className="flex h-[27px] w-full min-w-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-zinc-700/80 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition hover:border-fuchsia-400/40 hover:text-fuchsia-100 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-label={`出图渠道：${selected.fullLabel}`}
        title={`出图渠道 · ${selected.fullLabel}（默认用它出图）`}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden className="shrink-0 opacity-80">
          <path
            d="M2 3.5A1.5 1.5 0 0 1 3.5 2h9A1.5 1.5 0 0 1 14 3.5v9A1.5 1.5 0 0 1 12.5 14h-9A1.5 1.5 0 0 1 2 12.5v-9Zm3.5 1A1.5 1.5 0 1 0 5.5 7 1.5 1.5 0 0 0 5.5 4.5Zm7 6.5-3-4-2.5 3-1.5-1.5L3.5 12h9Z"
            fill="currentColor"
          />
        </svg>
        <span className="min-w-0 truncate font-medium">{selected.label}</span>
        {badge ? (
          <span className="shrink-0 rounded bg-zinc-700/70 px-1 text-[9px] leading-[14px] text-zinc-300 group-data-[c1]/tb:hidden" data-testid="image-channel-trigger-badge">
            {badge}
          </span>
        ) : null}
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden
          className={`shrink-0 opacity-70 transition ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div
          role="dialog"
          aria-label="出图渠道"
          style={placement ? { left: placement.left, width: placement.width } : undefined}
          className={
            'absolute bottom-full z-[40001] mb-2 rounded-lg border border-fuchsia-400/25 bg-zinc-950/95 p-1.5 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur' +
            (placement ? '' : ' left-0 w-[min(540px,calc(100vw-48px))]')
          }
        >
          <ImageChannelPanel options={channels} selectedId={selected.id} onSelect={(c) => handlePick(c.id)} autoFocus />
        </div>
      ) : null}
    </div>
  )
}
