// 视频工作台卡片的「渠道 → 模型」两级选择器(取代原来那个把所有模型排成一列的 <select>)。
//
//   [ Seedance 2.0 满血 ▾ ]            ← 卡片规格排里的按钮,位置与原下拉相同
//   ┌ 渠道 ──────────┬ 模型 ──────────────────────────────────────┐
//   │ 火山方舟   •  5 │ 火山方舟 · Seedance 官方线路…                │
//   │ Roneyun-cn    4 │ Seedance 2.0 满血                           │
//   │ 阿里万相      2 │ 4–15 秒 · 最高 4k · 参考 9 图 / 3 视频 / 3 音频 │
//   │ 可灵          2 │ …                                           │
//   └────────────────┴─────────────────────────────────────────────┘
//
// 结构与交互照「出图渠道」面板(features/agent-chat/ImageChannelPanel)和图片页的厂商面板:
// 左栏是 tablist(数量 + 当前模型所在渠道的圆点),右栏是 tabpanel;悬停(短延迟,斜着划向右栏
// 不会误切)/ 点击 / 键盘聚焦切换渠道。键盘:左栏 ↑↓ 切渠道、→ 进右栏;右栏 ↑↓ 移动、←→ 切到
// 上 / 下一个渠道、Enter 选择;Esc 关闭并把焦点还给按钮。
//
// 弹层渲染到 document.body(portal):卡片在滚动列表里,留在卡片内会被裁掉 / 盖在下一张卡下面
// (与 ContextMenu 同一个理由)。关闭条件也与它一致:Esc / 面板外按下鼠标 / 窗口失焦 / 缩放 /
// 面板以外的任何滚动。
//
// 分组、叫法、每行说明都在 features/video-workbench/modelChannels(纯函数,读能力表);
// 这里只负责画和交互。配色走工作台现有的那一套(黄 #FCE300 是唯一强调色,直角,不加新颜色)。

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react'
import { createPortal } from 'react-dom'
import type { SeedanceModelAlias, VideoBillingSource, VideoModelChannel } from '../../../../types/seedance'
import {
  channelGroupOf,
  groupModelsByChannel,
  modelHint,
  modelLabel,
  modelNameInChannel,
} from '../../features/video-workbench/modelChannels'

/** 悬停切渠道的延迟:斜着从左栏划向右栏时,路过别的渠道不该把右栏换掉。与出图渠道面板同值。 */
export const MODEL_PICKER_HOVER_DELAY_MS = 90
/** 弹层离视口边缘的最小距离 / 离按钮的间距。 */
const EDGE = 8
const GAP = 4
const OPTION_SELECTOR = '[data-vw-mp-option]'

export interface VideoModelPickerProps {
  /** 卡片当前的模型。 */
  value: SeedanceModelAlias
  /** 可选模型(工作台开放的那些,顺序 = 能力表键序)。 */
  models: readonly SeedanceModelAlias[]
  /** 当前计费来源 —— 只用来算每行说明里的「最高分辨率」。 */
  billing: VideoBillingSource
  disabled?: boolean
  onSelect: (model: SeedanceModelAlias) => void
}

export function VideoModelPicker({
  value,
  models,
  billing,
  disabled = false,
  onSelect,
}: VideoModelPickerProps): ReactElement {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const label = modelLabel(value)

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }, [])

  // 卡片开始生成后按钮被禁用:已经开着的面板一并收起,别让人在「不能改」的状态下还能选。
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="vw-model-picker"
        // 读屏与测试都靠这个名字找它:「模型：<当前模型>」。
        aria-label={`模型：${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        title="选择渠道与模型"
        className={`vw-mp-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen((cur) => !cur)}
      >
        <span className="vw-mp-trigger__name">{label}</span>
        <span className="vw-mp-trigger__caret" aria-hidden="true">▾</span>
      </button>
      {open && !disabled ? (
        <ModelPanel
          anchor={triggerRef.current}
          value={value}
          models={models}
          billing={billing}
          onClose={close}
          onSelect={(model) => {
            close(true)
            // 选的就是当前模型:只关面板。别发一次「换模型」—— 那会触发一轮分辨率 / 时长收敛,
            // 而用户什么都没换。
            if (model !== value) onSelect(model)
          }}
        />
      ) : null}
    </>
  )
}

interface ModelPanelProps {
  anchor: HTMLElement | null
  value: SeedanceModelAlias
  models: readonly SeedanceModelAlias[]
  billing: VideoBillingSource
  onClose: (restoreFocus: boolean) => void
  onSelect: (model: SeedanceModelAlias) => void
}

function ModelPanel({ anchor, value, models, billing, onClose, onSelect }: ModelPanelProps): ReactElement | null {
  const uid = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const hoverTimerRef = useRef<number | null>(null)
  // 打开 / 键盘切渠道之后要把焦点放进右栏哪一行;悬停与点击切渠道不抢焦点。
  const pendingFocusRef = useRef<'first' | 'selected' | null>('selected')

  const groups = useMemo(() => groupModelsByChannel(models), [models])
  // 打开时停在当前模型所在的渠道;当前模型不在清单里(旧存档的别名)就停在第一栏。
  const [activeId, setActiveId] = useState(() => (channelGroupOf(groups, value) ?? groups[0])?.id)
  const active = groups.find((group) => group.id === activeId) ?? groups[0]
  const [focusModel, setFocusModel] = useState<SeedanceModelAlias | undefined>(undefined)

  const cancelHover = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current)
      hoverTimerRef.current = null
    }
  }, [])
  useEffect(() => cancelHover, [cancelHover])

  // 先按按钮左下角渲染一帧,再量面板尺寸:下方放不下就翻到按钮上方,左右贴边就往回挪。
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const p = el.getBoundingClientRect()
    const below = a.bottom + GAP
    const above = a.top - GAP - p.height
    const fitsBelow = below + p.height <= window.innerHeight - EDGE
    const top = fitsBelow || above < EDGE ? below : above
    const left = Math.max(EDGE, Math.min(a.left, window.innerWidth - p.width - EDGE))
    setPos((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }))
    // 换渠道后右栏行数变了,面板高度跟着变,要重新判一次「下方放不放得下」。
  }, [anchor, active?.id])

  useEffect(() => {
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (rootRef.current?.contains(target) === true || anchor?.contains(target) === true)
    const onMouseDown = (e: MouseEvent): void => {
      // 按钮自己的点击由它的 onClick 切换开关;这里再关一次会变成「关了又开」。
      if (!inside(e.target)) onClose(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    }
    const onScroll = (e: Event): void => {
      // 面板自己的右栏可以滚;别的任何滚动都会让面板和按钮脱开,直接关掉。
      if (!(e.target instanceof Node && rootRef.current?.contains(e.target))) onClose(false)
    }
    const onBlurOrResize = (): void => onClose(false)
    // 捕获阶段:页面里别的组件(右键菜单等)会在冒泡阶段 stopPropagation,不能指望事件冒到 window。
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlurOrResize)
    window.addEventListener('resize', onBlurOrResize)
    return () => {
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlurOrResize)
      window.removeEventListener('resize', onBlurOrResize)
    }
  }, [anchor, onClose])

  // 打开后 / 键盘切渠道后,把焦点放到右栏(当前模型那一行,没有就第一行)。
  // 要等位置量好(`placed`)再放:量好之前面板是 visibility:hidden,浏览器不让隐藏的元素拿焦点
  // —— 那一次 focus() 会悄悄落空,而「待放焦点」的标记已经被清掉了。
  const placed = pos !== null
  useEffect(() => {
    const want = pendingFocusRef.current
    const root = rootRef.current
    if (!placed || !want || !root) return
    pendingFocusRef.current = null
    const optionEls = Array.from(root.querySelectorAll<HTMLElement>(OPTION_SELECTOR))
    const target =
      (want === 'selected' && optionEls.find((el) => el.getAttribute('aria-current') === 'true')) || optionEls[0]
    target?.focus()
  }, [active?.id, placed])

  if (!active) return null

  const tabId = (id: string): string => `${uid}-tab-${id}`
  const panelId = `${uid}-panel`
  const rovingModel = focusModel && active.models.includes(focusModel)
    ? focusModel
    : (active.models.find((model) => model === value) ?? active.models[0])

  const activate = (id: VideoModelChannel, focus: 'first' | 'selected' | null = null): void => {
    cancelHover()
    pendingFocusRef.current = focus
    setActiveId(id)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const root = rootRef.current
    const target = event.target as HTMLElement
    if (!root) return
    const index = groups.findIndex((group) => group.id === active.id)
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const optionEls = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(OPTION_SELECTOR))

    if (target.getAttribute('role') === 'tab') {
      let to: number | null = null
      if (event.key === 'ArrowDown') to = (index + 1) % groups.length
      else if (event.key === 'ArrowUp') to = (index - 1 + groups.length) % groups.length
      else if (event.key === 'Home') to = 0
      else if (event.key === 'End') to = groups.length - 1
      if (to !== null) {
        handled()
        activate(groups[to].id)
        document.getElementById(tabId(groups[to].id))?.focus()
      } else if (event.key === 'ArrowRight') {
        handled()
        const els = optionEls()
        ;(els.find((el) => el.getAttribute('aria-current') === 'true') ?? els[0])?.focus()
      }
      return
    }

    if (!target.closest('[role="tabpanel"]')) return
    const els = optionEls()
    const at = els.indexOf(target.closest<HTMLElement>(OPTION_SELECTOR) as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      handled()
      const next = event.key === 'ArrowDown' ? Math.min(at + 1, els.length - 1) : Math.max(at - 1, 0)
      els[next]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      handled()
      els[event.key === 'Home' ? 0 : els.length - 1]?.focus()
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && groups.length > 1) {
      handled()
      const to = event.key === 'ArrowRight' ? (index + 1) % groups.length : (index - 1 + groups.length) % groups.length
      activate(groups[to].id, 'first')
    }
  }

  return createPortal(
    <div
      ref={rootRef}
      className="vw-mp"
      role="dialog"
      aria-label="选择视频模型"
      data-testid="vw-model-panel"
      // 量好位置之前先藏着(占位但不可见),免得在按钮左下角闪一帧再跳到上方。
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
    >
      <div className="vw-mp-rail" role="tablist" aria-label="视频渠道" aria-orientation="vertical">
        {groups.map((group) => {
          const on = group.id === active.id
          const hasSelected = group.models.includes(value)
          return (
            <button
              key={group.id}
              type="button"
              role="tab"
              id={tabId(group.id)}
              data-channel={group.id}
              aria-selected={on}
              aria-controls={panelId}
              tabIndex={on ? 0 : -1}
              className={`vw-mp-tab${on ? ' is-on' : ''}`}
              title={hasSelected ? `${group.label}（当前模型在这里）` : group.label}
              onClick={() => activate(group.id)}
              onFocus={() => {
                if (!on) activate(group.id)
              }}
              onPointerEnter={() => {
                cancelHover()
                if (on) return
                hoverTimerRef.current = window.setTimeout(() => {
                  hoverTimerRef.current = null
                  setActiveId(group.id)
                }, MODEL_PICKER_HOVER_DELAY_MS)
              }}
              onPointerLeave={cancelHover}
            >
              <span className="vw-mp-tab__name">{group.label}</span>
              {hasSelected ? (
                <span className="vw-mp-tab__dot" data-testid="vw-model-current-dot" aria-hidden="true" />
              ) : null}
              <span className="vw-mp-tab__count">{group.models.length}</span>
            </button>
          )
        })}
      </div>

      <div
        className="vw-mp-list"
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId(active.id)}
        onPointerEnter={cancelHover}
      >
        <div className="vw-mp-head">
          <span className="vw-mp-head__title">{active.label}</span>
          <span className="vw-mp-head__caption">{active.caption}</span>
        </div>
        <div className="vw-mp-rows">
          {active.models.map((model) => {
            const selected = model === value
            const hint = modelHint(model, billing)
            return (
              <button
                key={model}
                type="button"
                className={`vw-mp-opt${selected ? ' is-on' : ''}`}
                data-vw-mp-option=""
                data-model={model}
                aria-current={selected ? 'true' : undefined}
                tabIndex={model === rovingModel ? 0 : -1}
                // 别名放 tooltip:agent / 任务详情 / 导出文件里写的是这个字,不是界面上的叫法
                // (Roneyun-cn 的别名同时就是网关上的模型名)。
                title={model}
                onFocus={() => setFocusModel(model)}
                onClick={() => onSelect(model)}
              >
                <span className="vw-mp-opt__name">{modelNameInChannel(model)}</span>
                {hint ? <span className="vw-mp-opt__desc">{hint}</span> : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
