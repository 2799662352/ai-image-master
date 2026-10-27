import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorModelPanel, stripVendorPrefix } from '../VendorModelPanel'

/**
 * 顶栏「厂商 → 模型」两级面板(设计稿 D6,照 apiyi 生图页的聚类)。
 * 真源是隐藏的 <select>:面板读它渲染、点选写回它并派发 change。
 */

const models = {
  'doubao-seedream-5-0-pro-260628': { name: 'Seedream 5.0 Pro', displayName: '火山即梦', vendor: 'bytedance', time: '20s' },
  'custom-imagemodel-gt': { name: '腾讯 Image 2', displayName: '腾讯 Image 2 说明', vendor: 'tencent', time: '30s', isNew: true },
  'custom-model-og-v2': { name: '腾讯 Image 2 Fast', displayName: '腾讯快', vendor: 'tencent', time: '15s' },
  'gpt-image-2.5-flare': { name: 'GPT Image 2.5 Flare', displayName: 'OpenAI 2.5', vendor: 'openai', time: '20s' },
  sora_image: { name: 'Sora Image', displayName: '无厂商' },
}

function mountSelect(current: string): HTMLSelectElement {
  document.body.innerHTML = '<div class="model-selector-wrapper"><select id="modelSelector"></select></div>'
  const select = document.getElementById('modelSelector') as HTMLSelectElement
  for (const [key, m] of Object.entries(models)) {
    const opt = document.createElement('option')
    opt.value = key
    opt.textContent = `${m.name} - ${m.displayName}`
    opt.selected = key === current
    select.appendChild(opt)
  }
  return select
}

describe('stripVendorPrefix', () => {
  it('drops a leading vendor name and keeps everything else', () => {
    expect(stripVendorPrefix('腾讯 Image 2', '腾讯')).toBe('Image 2')
    expect(stripVendorPrefix('GPT Image 2.5 Flare', 'OpenAI')).toBe('GPT Image 2.5 Flare')
    expect(stripVendorPrefix('腾讯', '腾讯')).toBe('腾讯')
    expect(stripVendorPrefix('Sora Image', '')).toBe('Sora Image')
  })
})

describe('VendorModelPanel', () => {
  let panel: VendorModelPanel
  let select: HTMLSelectElement
  let onSelect: ReturnType<typeof vi.fn>

  beforeEach(() => {
    select = mountSelect('custom-imagemodel-gt')
    onSelect = vi.fn()
    panel = new VendorModelPanel({ select, getModels: () => models, onSelect })
  })

  afterEach(() => {
    panel.destroy()
    document.body.innerHTML = ''
  })

  it('renders the trigger as vendor chip + model name (vendor prefix stripped) next to the select', () => {
    const trigger = document.querySelector('.model-trigger') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.previousElementSibling).toBeNull() // host sits right after the select
    expect((trigger.parentElement as HTMLElement).previousElementSibling).toBe(select)
    expect(trigger.querySelector('.model-vendor-chip')?.textContent).toBe('腾讯')
    expect(trigger.querySelector('.model-selected-name')?.textContent).toBe('Image 2')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect((document.querySelector('.model-panel') as HTMLElement).hidden).toBe(true)
  })

  it('opens with the vendor rail in fixed order, counts, and the current model\'s vendor active', () => {
    ;(document.querySelector('.model-trigger') as HTMLButtonElement).click()
    const rail = Array.from(document.querySelectorAll<HTMLButtonElement>('.model-panel__vendor'))
    expect(rail.map((b) => b.querySelector('.model-panel__vendor-name')?.textContent)).toEqual([
      'Seedream',
      '腾讯',
      'OpenAI',
      '其他',
    ])
    expect(rail.map((b) => b.querySelector('.model-panel__vendor-count')?.textContent)).toEqual(['1', '2', '1', '1'])
    expect(rail[1].classList.contains('is-active')).toBe(true)
    expect(rail[1].querySelector('.model-panel__vendor-dot')).not.toBeNull()
    expect(rail[0].querySelector('.model-panel__vendor-dot')).toBeNull()

    // 右侧只列激活厂商的模型,当前模型带 ✓ 当前 + NEW 徽章
    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('.model-panel__card'))
    expect(cards.map((c) => c.dataset.value)).toEqual(['custom-imagemodel-gt', 'custom-model-og-v2'])
    expect(cards[0].classList.contains('is-selected')).toBe(true)
    expect(cards[0].textContent).toContain('✓ 当前')
    expect(cards[0].textContent).toContain('NEW')
    expect(cards[0].textContent).toContain('⏱ 30s')
    expect(cards[0].querySelector('.model-panel__card-desc')?.textContent).toBe('腾讯 Image 2 说明')
    expect((document.querySelector('.model-trigger') as HTMLButtonElement).getAttribute('aria-expanded')).toBe('true')
  })

  it('hovering another vendor switches the list without changing the selection', () => {
    panel.open()
    const openai = document.querySelector<HTMLButtonElement>('.model-panel__vendor[data-vendor="openai"]')!
    openai.dispatchEvent(new Event('mouseenter'))
    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('.model-panel__card'))
    expect(cards.map((c) => c.dataset.value)).toEqual(['gpt-image-2.5-flare'])
    expect(cards[0].classList.contains('is-selected')).toBe(false)
    expect(select.value).toBe('custom-imagemodel-gt')
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('clicking a card writes the select, dispatches change, calls onSelect and closes', () => {
    const changed = vi.fn()
    select.addEventListener('change', changed)
    panel.open()
    document.querySelector<HTMLButtonElement>('.model-panel__vendor[data-vendor="openai"]')!.click()
    document.querySelector<HTMLButtonElement>('.model-panel__card[data-value="gpt-image-2.5-flare"]')!.click()

    expect(select.value).toBe('gpt-image-2.5-flare')
    expect(changed).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith('gpt-image-2.5-flare')
    expect((document.querySelector('.model-panel') as HTMLElement).hidden).toBe(true)
    const trigger = document.querySelector('.model-trigger') as HTMLButtonElement
    expect(trigger.querySelector('.model-vendor-chip')?.textContent).toBe('OpenAI')
    expect(trigger.querySelector('.model-selected-name')?.textContent).toBe('GPT Image 2.5 Flare')
  })

  it('re-picking the current model is a no-op (no change event, no onSelect)', () => {
    const changed = vi.fn()
    select.addEventListener('change', changed)
    panel.open()
    document.querySelector<HTMLButtonElement>('.model-panel__card[data-value="custom-imagemodel-gt"]')!.click()
    expect(changed).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('setChoiceByValue (Choices-compatible) updates select + trigger, e.g. after an agent-side switch', () => {
    panel.setChoiceByValue('sora_image')
    expect(select.value).toBe('sora_image')
    const trigger = document.querySelector('.model-trigger') as HTMLButtonElement
    expect(trigger.querySelector('.model-vendor-chip')).toBeNull()
    expect(trigger.querySelector('.model-selected-name')?.textContent).toBe('Sora Image')
    expect(panel.getValue()).toEqual({ value: 'sora_image' })
  })

  it('Escape and outside mousedown close the panel', () => {
    panel.open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect((document.querySelector('.model-panel') as HTMLElement).hidden).toBe(true)

    panel.open()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect((document.querySelector('.model-panel') as HTMLElement).hidden).toBe(true)
  })

  it('arrow keys move between models and vendors, Enter picks', () => {
    panel.open()
    const list = document.querySelector('.model-panel') as HTMLElement
    const firstCard = document.querySelector<HTMLButtonElement>('.model-panel__card')!
    firstCard.focus()
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect((document.activeElement as HTMLElement).dataset.value).toBe('custom-model-og-v2')
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(document.querySelector('.model-panel__vendor.is-active')?.getAttribute('data-vendor')).toBe('openai')
    list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(select.value).toBe('gpt-image-2.5-flare')
    expect(onSelect).toHaveBeenCalledWith('gpt-image-2.5-flare')
  })

  it('destroy removes its DOM and listeners', () => {
    panel.open()
    panel.destroy()
    expect(document.querySelector('.model-picker')).toBeNull()
    // 再派发 Escape 不应报错(监听已摘)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    // 重新建一个占位,避免 afterEach 二次 destroy 出错
    panel = new VendorModelPanel({ select, getModels: () => models, onSelect })
  })
})
