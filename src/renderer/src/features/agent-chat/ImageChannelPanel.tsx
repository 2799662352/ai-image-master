/**
 * 出图渠道的「分区导航」面板 —— 复刻 sora-ui 网页版 ModelPanel(图像模型下拉)的结构与交互。
 *
 *   ┌ 分区栏 ─────┬ 渠道 ───────────────────────────────┐
 *   │ 最近使用  1 │ 常用 · 常用渠道，稳定、日常出图首选   │
 *   │ 常用   •  6 │ Seedream 5.0 Pro                     │
 *   │ 备用渠道  2 │ 火山豆包，多图融合……                 │
 *   │ 更多模型    │ …                                    │
 *   │   风格化   6│                                      │
 *   └─────────────┴──────────────────────────────────────┘
 *
 * - 分区由 `arrangeChannelMenu` 排好;打开时停在当前渠道所在的分区,圆点标出当前渠道在哪个分区。
 * - 悬停(短延迟,斜着划向右栏不会误切)、点击、键盘聚焦都会切换分区。
 * - 键盘:分区栏 ↑↓ 切换、→ 进入右栏;右栏 ↑↓ 移动、←→ 切到上 / 下一个分区、Enter 选择;Esc 由宿主弹层处理。
 * - 面板窄于 NARROW_WIDTH 时分区栏变成顶部一排横向标签。
 * - 「选择」与「固定」是同一行里的两个兄弟按钮(不嵌套),所以右栏不用 listbox
 *   (listbox 内不允许放可交互按钮)。
 *
 * 与网页版的差异:配色走桌面端的 fuchsia(CSS 变量);没有 NEW 标签(桌面端没有「模型上新」通知)、
 * 没有「暂未开放」置灰(桌面端渠道清单是写死的精选子集,没有这个状态)。
 */
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Pin, PinOff } from 'lucide-react'
import { useImageChannelPrefsStore } from './imageChannelPrefs'
import {
  MAX_FEATURED_TOTAL,
  arrangeChannelMenu,
  type PlacedImageChannel,
} from './imageChannelPlacement'
import './imageChannelPanel.css'

const HOVER_SWITCH_DELAY_MS = 90
const NARROW_WIDTH = 440
const OPTION_SELECTOR = '[data-icp-option]:not(:disabled)'

type SectionKind = 'recent' | 'featured' | 'backup' | 'more'

interface PanelSection {
  key: string
  kind: SectionKind
  label: string
  caption: string
  options: PlacedImageChannel[]
}

const SECTION_CAPTION: Record<SectionKind, string> = {
  recent: '最近选过、不在常用里的渠道',
  featured: '常用渠道，稳定、日常出图首选',
  backup: '常用渠道在其他线路的同款，主线路排队或出错时再用',
  more: '用得少的渠道，按系列归类',
}

export interface ImageChannelPanelProps {
  options: readonly PlacedImageChannel[]
  selectedId: string | undefined
  /** 宿主把选择写进 store / 关闭弹层;记最近使用已由本组件处理。 */
  onSelect: (channel: PlacedImageChannel) => void
  /** 挂载时把焦点放到当前渠道上(点击打开的弹层用)。 */
  autoFocus?: boolean
  className?: string
}

export function ImageChannelPanel({
  options,
  selectedId,
  onSelect,
  autoFocus = false,
  className,
}: ImageChannelPanelProps) {
  const uid = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const hoverTimerRef = useRef<number | null>(null)
  const pendingFocusRef = useRef<'first' | 'selected' | null>(autoFocus ? 'selected' : null)
  const pinnedIds = useImageChannelPrefsStore((s) => s.pinned)
  const recentIds = useImageChannelPrefsStore((s) => s.recent)
  const togglePin = useImageChannelPrefsStore((s) => s.togglePin)
  const recordUse = useImageChannelPrefsStore((s) => s.recordUse)
  const layout = useMemo(
    () => arrangeChannelMenu(options, { pinnedIds, recentIds }),
    [options, pinnedIds, recentIds],
  )

  const sections = useMemo<PanelSection[]>(() => {
    const list: PanelSection[] = []
    if (layout.recent.length) {
      list.push({ key: 'recent', kind: 'recent', label: '最近使用', caption: SECTION_CAPTION.recent, options: layout.recent })
    }
    if (layout.featured.length) {
      list.push({ key: 'featured', kind: 'featured', label: '常用', caption: SECTION_CAPTION.featured, options: layout.featured })
    }
    if (layout.backup.length) {
      list.push({ key: 'backup', kind: 'backup', label: '备用渠道', caption: SECTION_CAPTION.backup, options: layout.backup })
    }
    for (const group of layout.moreGroups) {
      list.push({ key: `more:${group.key}`, kind: 'more', label: group.label, caption: SECTION_CAPTION.more, options: group.options })
    }
    return list
  }, [layout])

  // 打开时停在当前渠道所在的分区(「最近使用」只是副本,不算);没选或不在清单里就停在「常用」。
  const [activeKey, setActiveKey] = useState<string>(() => {
    const home = sections.find((section) => section.kind !== 'recent' && section.options.some((o) => o.id === selectedId))
    return (home ?? sections.find((section) => section.kind === 'featured') ?? sections[0])?.key ?? 'featured'
  })
  // 钉 / 取消钉会让分区变化(某个分组被钉空了):当前分区不存在时退回「常用」。
  const active =
    sections.find((section) => section.key === activeKey) ??
    sections.find((section) => section.kind === 'featured') ??
    sections[0]

  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return undefined
    const measure = () => {
      const width = el.clientWidth
      if (width > 0) setNarrow(width < NARROW_WIDTH)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const [focusId, setFocusId] = useState<string | undefined>(undefined)

  const cancelHover = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])
  useEffect(() => cancelHover, [cancelHover])

  // 切分区 / 首次挂载后按需把焦点放进右栏(键盘 ←→ 切分区、autoFocus)。
  useEffect(() => {
    const want = pendingFocusRef.current
    const root = rootRef.current
    if (!want || !root) return
    pendingFocusRef.current = null
    const optionEls = Array.from(root.querySelectorAll<HTMLElement>(`[role="tabpanel"] ${OPTION_SELECTOR}`))
    const target =
      (want === 'selected' && optionEls.find((el) => el.getAttribute('aria-current') === 'true')) || optionEls[0]
    target?.focus()
  }, [active?.key])

  if (!active) return null

  const tabId = (key: string) => `${uid}-tab-${key}`
  const panelId = `${uid}-panel`
  const pinnedSet = new Set(layout.pinnedIds)
  const hasPriceHint = active.options.some((option) => option.placement.priceHint)
  const rovingId = active.options.some((o) => o.id === focusId)
    ? focusId
    : (active.options.find((o) => o.id === selectedId) ?? active.options[0])?.id

  const activate = (key: string, focus: 'first' | 'selected' | null = null) => {
    cancelHover()
    pendingFocusRef.current = focus
    setActiveKey(key)
  }

  const choose = (option: PlacedImageChannel) => {
    recordUse(option.id)
    onSelect(option)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const root = rootRef.current
    const target = event.target as HTMLElement
    if (!root) return
    const index = sections.findIndex((section) => section.key === active.key)
    const handled = () => {
      event.preventDefault()
      event.stopPropagation()
    }

    if (target.getAttribute('role') === 'tab') {
      const [nextKey, prevKey, enterKey] = narrow
        ? ['ArrowRight', 'ArrowLeft', 'ArrowDown']
        : ['ArrowDown', 'ArrowUp', 'ArrowRight']
      let to: number | null = null
      if (event.key === nextKey) to = (index + 1) % sections.length
      else if (event.key === prevKey) to = (index - 1 + sections.length) % sections.length
      else if (event.key === 'Home') to = 0
      else if (event.key === 'End') to = sections.length - 1
      if (to !== null) {
        handled()
        activate(sections[to].key)
        document.getElementById(tabId(sections[to].key))?.focus()
      } else if (event.key === enterKey) {
        handled()
        const optionEls = Array.from(root.querySelectorAll<HTMLElement>(`[role="tabpanel"] ${OPTION_SELECTOR}`))
        ;(optionEls.find((el) => el.getAttribute('aria-current') === 'true') ?? optionEls[0])?.focus()
      }
      return
    }

    if (!target.closest('[role="tabpanel"]')) return
    const optionEls = Array.from(root.querySelectorAll<HTMLElement>(`[role="tabpanel"] ${OPTION_SELECTOR}`))
    const row = target.closest('.icp-row')
    const at = optionEls.findIndex((el) => el.closest('.icp-row') === row)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      handled()
      const next = event.key === 'ArrowDown' ? Math.min(at + 1, optionEls.length - 1) : Math.max(at - 1, 0)
      optionEls[next]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      handled()
      optionEls[event.key === 'Home' ? 0 : optionEls.length - 1]?.focus()
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && sections.length > 1) {
      handled()
      const to = event.key === 'ArrowRight' ? (index + 1) % sections.length : (index - 1 + sections.length) % sections.length
      activate(sections[to].key, 'first')
    }
  }

  return (
    <div
      ref={rootRef}
      className={`icp${narrow ? ' icp--narrow' : ''}${className ? ` ${className}` : ''}`}
      data-testid="image-channel-panel"
      onKeyDown={onKeyDown}
    >
      <div className="icp-rail" role="tablist" aria-label="出图渠道分区" aria-orientation={narrow ? 'horizontal' : 'vertical'}>
        {sections.map((section, i) => {
          const on = section.key === active.key
          const hasSelected = section.kind !== 'recent' && section.options.some((o) => o.id === selectedId)
          const firstMore = section.kind === 'more' && sections[i - 1]?.kind !== 'more'
          return (
            <Fragment key={section.key}>
              {firstMore ? (
                <div className="icp-rail__label" role="presentation">
                  更多模型
                </div>
              ) : null}
              <button
                type="button"
                role="tab"
                id={tabId(section.key)}
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                className={`icp-tab${on ? ' is-on' : ''}${section.kind === 'more' ? ' icp-tab--sub' : ''}`}
                title={hasSelected ? `${section.label}（当前渠道在这里）` : section.label}
                onClick={() => activate(section.key)}
                onFocus={() => {
                  if (!on) activate(section.key)
                }}
                onPointerEnter={() => {
                  cancelHover()
                  if (on) return
                  hoverTimerRef.current = window.setTimeout(() => {
                    hoverTimerRef.current = null
                    setActiveKey(section.key)
                  }, HOVER_SWITCH_DELAY_MS)
                }}
                onPointerLeave={cancelHover}
              >
                <span className="icp-tab__name">{section.label}</span>
                {hasSelected ? <span className="icp-tab__dot" data-testid="image-channel-current-dot" aria-hidden="true" /> : null}
                <span className="icp-tab__count">{section.options.length}</span>
              </button>
            </Fragment>
          )
        })}
      </div>

      <div className="icp-list" role="tabpanel" id={panelId} aria-labelledby={tabId(active.key)} onPointerEnter={cancelHover}>
        <div className="icp-head">
          <span className="icp-head__title">{active.kind === 'more' ? `更多模型 · ${active.label}` : active.label}</span>
          <span className="icp-head__caption">{active.caption}</span>
        </div>
        <div className="icp-rows">
          {active.options.map((option) => {
            const pinned = pinnedSet.has(option.id)
            return (
              <ChannelRow
                key={option.id}
                option={option}
                selected={option.id === selectedId}
                pinned={pinned}
                pinnable={active.kind === 'backup' || active.kind === 'more' || (active.kind === 'featured' && pinned)}
                canPinMore={layout.canPinMore}
                focusable={option.id === rovingId}
                onFocus={() => setFocusId(option.id)}
                onChoose={() => choose(option)}
                onTogglePin={() => togglePin(option.id)}
              />
            )
          })}
        </div>
        {hasPriceHint ? <div className="icp-note">价格为参考量级，随规格浮动，以实际计费为准</div> : null}
      </div>
    </div>
  )
}

interface ChannelRowProps {
  option: PlacedImageChannel
  selected: boolean
  pinned: boolean
  /** 这一行能不能出现「固定」按钮(团队常用 / 最近使用里的条目不出)。 */
  pinnable: boolean
  canPinMore: boolean
  /** roving tabindex:整个右栏只有一行可被 Tab 到,其余靠方向键。 */
  focusable: boolean
  onFocus: () => void
  onChoose: () => void
  onTogglePin: () => void
}

function ChannelRow({
  option,
  selected,
  pinned,
  pinnable,
  canPinMore,
  focusable,
  onFocus,
  onChoose,
  onTogglePin,
}: ChannelRowProps) {
  const { placement } = option
  const name = option.fullLabel
  const hint = placement.hint
  // 完整说明放 tooltip:行内只有一句话,而注册表里的 description 带着渠道细节(计费、后台渠道名)
  const tooltip = [option.description, option.id].filter(Boolean).join(' · ')
  const pinBlocked = !pinned && !canPinMore

  return (
    <div className={`icp-row${selected ? ' is-on' : ''}${pinned ? ' is-pinned' : ''}${pinnable ? ' icp-row--pinnable' : ''}`}>
      <button
        type="button"
        className="icp-opt"
        data-icp-option=""
        data-model-id={option.id}
        aria-current={selected ? 'true' : undefined}
        tabIndex={focusable ? 0 : -1}
        title={tooltip}
        onFocus={onFocus}
        onClick={onChoose}
      >
        <span className="icp-opt__head">
          <span className="icp-opt__name">{name}</span>
          {placement.channelLabel ? <span className="icp-chip">{placement.channelLabel}</span> : null}
          {placement.priceHint ? <span className="icp-opt__price">{placement.priceHint}</span> : null}
        </span>
        {hint ? <span className="icp-opt__desc">{hint}</span> : null}
      </button>
      {pinnable ? (
        <button
          type="button"
          className="icp-pin"
          aria-pressed={pinned}
          aria-label={pinned ? `取消固定：${name}` : `固定到常用：${name}`}
          title={pinBlocked ? `常用最多 ${MAX_FEATURED_TOTAL} 个，先取消一个再固定` : pinned ? '取消固定' : '固定到常用'}
          disabled={pinBlocked}
          tabIndex={focusable ? 0 : -1}
          onClick={onTogglePin}
        >
          {pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      ) : null}
    </div>
  )
}
