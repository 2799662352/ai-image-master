// 顶栏模型选择器 —— 「厂商 → 模型」两级面板(设计稿 D6 · 用户点名要 apiyi 生图页那种聚类)。
//
// 为什么不继续用 Choices.js:它只能渲染一列带分组抬头的平铺列表,做不出左侧厂商轨 +
// 右侧模型卡的两栏布局。这里是一个零依赖的原生 DOM 组件,挂在隐藏的 `<select#modelSelector>`
// 旁边:`<select>` 仍是选项与当前值的唯一真源(populateSelectOptions 往里写 optgroup),
// 面板只读它、点选时写回它并派发 `change`,所以 ModelSelectorManager 原有的 change 监听 /
// handleModelSwitch 一条不改。
//
// 对外故意长得像 Choices 实例(setChoiceByValue / setChoices / clearStore / getValue /
// destroy),manager 里 `this.desktopChoice` 那些调用点不用区分。
//
// 交互照 apiyi:悬停 / 点击左侧厂商切换右侧列表;当前模型所在厂商默认激活并带黄点;
// ↑↓ 在模型间移动、←→ 换厂商、Enter 选中、Esc 关闭;点面板外收起。

import { MODEL_VENDORS, groupModelsByVendor, type VendorGroup } from '../../services/api/modelVendors'

export interface PanelModel {
  name: string
  displayName?: string
  time?: string
  isNew?: boolean
  vendor?: string
}

export interface VendorModelPanelOptions {
  /** 隐藏的原生 select:选项 + 当前值的真源。 */
  select: HTMLSelectElement
  /** 每次打开 / 重绘时取一遍模型表(自定义站点会改它)。 */
  getModels: () => Record<string, PanelModel>
  /** i18n 后的说明文案;缺省用 model.displayName。 */
  getDisplayName?: (modelKey: string) => string
  /** 用户点选后回调;由调用方决定是否真的切换(manager.handleModelSwitch)。 */
  onSelect: (modelKey: string) => void
}

type VendorKey = VendorGroup<PanelModel>['vendorKey']

const CARET_SVG =
  '<svg class="model-selected-caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 模型名若以厂商名开头(「腾讯 Image 2」)就去掉前缀,免得小标签和正文重复。 */
export function stripVendorPrefix(modelName: string, vendorName: string): string {
  if (!vendorName || !modelName.startsWith(vendorName)) return modelName
  return modelName.slice(vendorName.length).trim() || modelName
}

export class VendorModelPanel {
  private readonly select: HTMLSelectElement
  private readonly opts: VendorModelPanelOptions
  private readonly host: HTMLDivElement
  private readonly trigger: HTMLButtonElement
  private readonly panel: HTMLDivElement
  private readonly rail: HTMLDivElement
  private readonly list: HTMLDivElement
  private value: string
  private activeVendor: VendorKey | null = null
  private isOpen = false
  private groups: VendorGroup<PanelModel>[] = []

  constructor(opts: VendorModelPanelOptions) {
    this.opts = opts
    this.select = opts.select
    this.value = opts.select.value

    this.host = el('div', 'model-picker')
    this.trigger = el('button', 'model-trigger')
    this.trigger.type = 'button'
    this.trigger.setAttribute('aria-haspopup', 'dialog')
    this.trigger.setAttribute('aria-expanded', 'false')
    this.trigger.dataset.testid = 'model-trigger'

    this.panel = el('div', 'model-panel')
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-label', '选择模型')
    this.panel.hidden = true
    this.rail = el('div', 'model-panel__rail')
    this.rail.setAttribute('role', 'tablist')
    this.rail.setAttribute('aria-label', '模型厂商')
    this.list = el('div', 'model-panel__list')
    this.list.setAttribute('role', 'listbox')
    this.list.setAttribute('aria-label', '模型')
    this.panel.append(this.rail, this.list)
    this.host.append(this.trigger, this.panel)

    // 紧挨着 select 放,沿用 .model-selector-wrapper 的 position: relative 做定位锚点。
    this.select.insertAdjacentElement('afterend', this.host)

    this.trigger.addEventListener('click', this.onTriggerClick)
    this.panel.addEventListener('keydown', this.onPanelKeyDown)
    this.trigger.addEventListener('keydown', this.onTriggerKeyDown)

    this.renderTrigger()
  }

  // ---------------------------------------------------------------- Choices-compatible surface

  setChoiceByValue(value: string): void {
    this.value = value
    if (this.select.value !== value) this.select.value = value
    this.renderTrigger()
    if (this.isOpen) this.renderPanel()
  }

  /** 语言切换后 manager 会先改 select 的 option 文案再调这个 —— 直接按 select 重绘。 */
  setChoices(): void {
    this.renderTrigger()
    if (this.isOpen) this.renderPanel()
  }

  clearStore(): void {
    /* 没有自己的 store,真源是 <select> */
  }

  getValue(): { value: string } {
    return { value: this.value }
  }

  destroy(): void {
    this.close()
    this.trigger.removeEventListener('click', this.onTriggerClick)
    this.panel.removeEventListener('keydown', this.onPanelKeyDown)
    this.trigger.removeEventListener('keydown', this.onTriggerKeyDown)
    this.host.remove()
  }

  // ---------------------------------------------------------------- open / close

  open(): void {
    if (this.isOpen) return
    this.isOpen = true
    this.activeVendor = this.vendorOf(this.value) ?? this.groupsNow()[0]?.vendorKey ?? null
    this.renderPanel()
    this.panel.hidden = false
    this.trigger.setAttribute('aria-expanded', 'true')
    document.addEventListener('mousedown', this.onDocMouseDown, true)
    document.addEventListener('keydown', this.onDocKeyDown)
    const selected = this.list.querySelector<HTMLElement>('.model-panel__card.is-selected')
    ;(selected ?? this.list.querySelector<HTMLElement>('.model-panel__card'))?.focus()
  }

  close(): void {
    if (!this.isOpen) return
    this.isOpen = false
    this.panel.hidden = true
    this.trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('mousedown', this.onDocMouseDown, true)
    document.removeEventListener('keydown', this.onDocKeyDown)
  }

  toggle(): void {
    if (this.isOpen) this.close()
    else this.open()
  }

  // ---------------------------------------------------------------- rendering

  private groupsNow(): VendorGroup<PanelModel>[] {
    this.groups = groupModelsByVendor(this.opts.getModels() ?? {})
    return this.groups
  }

  private vendorOf(modelKey: string): VendorKey | null {
    for (const g of this.groupsNow()) {
      if (g.models.some((m) => m.key === modelKey)) return g.vendorKey
    }
    return null
  }

  private renderTrigger(): void {
    const models = this.opts.getModels() ?? {}
    const model = models[this.value]
    const vendorRaw = model?.vendor
    const vendorName =
      typeof vendorRaw === 'string' && vendorRaw in MODEL_VENDORS
        ? MODEL_VENDORS[vendorRaw as keyof typeof MODEL_VENDORS].name
        : ''
    const fullName = model?.name ?? this.value ?? ''
    this.trigger.replaceChildren()
    if (vendorName) this.trigger.append(el('span', 'model-vendor-chip', vendorName))
    this.trigger.append(el('span', 'model-selected-name', stripVendorPrefix(fullName, vendorName)))
    this.trigger.insertAdjacentHTML('beforeend', CARET_SVG)
    this.trigger.title = fullName ? `当前模型:${fullName}` : '选择模型'
  }

  private renderPanel(): void {
    const groups = this.groupsNow()
    if (this.activeVendor === null || !groups.some((g) => g.vendorKey === this.activeVendor)) {
      this.activeVendor = this.vendorOf(this.value) ?? groups[0]?.vendorKey ?? null
    }
    const currentVendor = this.vendorOf(this.value)

    this.rail.replaceChildren()
    for (const g of groups) {
      const btn = el('button', 'model-panel__vendor')
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.dataset.vendor = g.vendorKey
      const active = g.vendorKey === this.activeVendor
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-selected', active ? 'true' : 'false')
      btn.tabIndex = active ? 0 : -1
      const name = el('span', 'model-panel__vendor-name', g.meta.name)
      if (g.vendorKey === currentVendor) {
        const dot = el('span', 'model-panel__vendor-dot')
        dot.title = '当前模型所在厂商'
        name.append(dot)
      }
      btn.append(name, el('span', 'model-panel__vendor-count', String(g.models.length)))
      const activate = (): void => {
        if (this.activeVendor === g.vendorKey) return
        this.activeVendor = g.vendorKey
        this.renderPanel()
      }
      btn.addEventListener('mouseenter', activate)
      btn.addEventListener('focus', activate)
      btn.addEventListener('click', activate)
      this.rail.append(btn)
    }

    this.list.replaceChildren()
    const group = groups.find((g) => g.vendorKey === this.activeVendor)
    if (!group) return
    for (const { key, model } of group.models) {
      const card = el('button', 'model-panel__card')
      card.type = 'button'
      card.setAttribute('role', 'option')
      card.dataset.value = key
      const selected = key === this.value
      card.classList.toggle('is-selected', selected)
      card.setAttribute('aria-selected', selected ? 'true' : 'false')
      card.tabIndex = -1

      const head = el('div', 'model-panel__card-head')
      head.append(el('span', 'model-panel__card-name', model.name))
      if (model.time) head.append(el('span', 'model-badge model-badge-time', `⏱ ${model.time}`))
      card.append(head)

      const tags = el('div', 'model-panel__card-tags')
      if (selected) tags.append(el('span', 'model-panel__tag model-panel__tag--current', '✓ 当前'))
      if (model.isNew) tags.append(el('span', 'model-badge model-badge-new', 'NEW'))
      if (tags.childElementCount) card.append(tags)

      const desc = this.opts.getDisplayName ? this.opts.getDisplayName(key) : model.displayName
      if (desc) {
        const d = el('div', 'model-panel__card-desc', desc)
        d.title = desc
        card.append(d)
      }

      card.addEventListener('click', () => this.pick(key))
      this.list.append(card)
    }
  }

  private pick(modelKey: string): void {
    this.close()
    if (modelKey === this.value) return
    this.value = modelKey
    this.select.value = modelKey
    this.renderTrigger()
    // 让 manager 既有的 change 监听拿到它(与 Choices 时代同一条路),再直接回调一次做保险。
    this.select.dispatchEvent(new Event('change', { bubbles: true }))
    this.opts.onSelect(modelKey)
  }

  // ---------------------------------------------------------------- events

  private readonly onTriggerClick = (): void => {
    this.toggle()
  }

  private readonly onTriggerKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      this.open()
    }
  }

  private readonly onDocMouseDown = (e: MouseEvent): void => {
    if (!this.host.contains(e.target as Node)) this.close()
  }

  private readonly onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      this.trigger.focus()
    }
  }

  private readonly onPanelKeyDown = (e: KeyboardEvent): void => {
    const cards = Array.from(this.list.querySelectorAll<HTMLElement>('.model-panel__card'))
    const focused = document.activeElement as HTMLElement | null
    const idx = cards.findIndex((c) => c === focused)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!cards.length) return
      const next = idx < 0 ? 0 : (idx + (e.key === 'ArrowDown' ? 1 : cards.length - 1)) % cards.length
      cards[next].focus()
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const groups = this.groups
      if (!groups.length) return
      const gi = Math.max(0, groups.findIndex((g) => g.vendorKey === this.activeVendor))
      const ni = (gi + (e.key === 'ArrowRight' ? 1 : groups.length - 1)) % groups.length
      this.activeVendor = groups[ni].vendorKey
      this.renderPanel()
      this.list.querySelector<HTMLElement>('.model-panel__card')?.focus()
    } else if (e.key === 'Enter' && idx >= 0) {
      e.preventDefault()
      const key = cards[idx].dataset.value
      if (key) this.pick(key)
    }
  }
}
