import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModelSelectorManager, type ModelSelectorManager } from '../ModelSelectorManager'

/**
 * 顶栏模型选择器按厂商聚合(腾讯 image 单开一档)。
 *
 * 分组用原生 `<optgroup>`,Choices.js 据此渲染分组抬头;这里断言的是喂给 Choices 的
 * `<select>` 结构 —— 它是唯一的真源。`tests/features/ModelSelectorManager.test.ts` 是
 * 不在 vitest include 里的旧套件,所以新断言放这里让 CI 真跑到。
 */

class MockChoices {
  element: HTMLElement
  options: any
  passedElement: { element: HTMLElement }
  static instances: MockChoices[] = []

  constructor(element: HTMLElement | string, options?: any) {
    this.element =
      typeof element === 'string' ? (document.querySelector(element) as HTMLElement) : element
    this.options = options
    this.passedElement = { element: this.element }
    MockChoices.instances.push(this)
    options?.callbackOnInit?.()
  }

  setChoices = vi.fn()
  clearChoices = vi.fn()
  clearStore = vi.fn()
  setChoiceByValue = vi.fn()
  getValue = vi.fn(() => ({ value: 'test' }))
  destroy = vi.fn()
  init = vi.fn()
  enable = vi.fn()
  disable = vi.fn()

  static clearInstances(): void {
    MockChoices.instances = []
  }
}

const vendorModels = {
  'doubao-seedream-5-0-pro-260628': { name: 'Seedream 5.0 Pro', displayName: '火山', vendor: 'bytedance' },
  'custom-imagemodel-gt': { name: '腾讯 Image 2', displayName: '腾讯', vendor: 'tencent' },
  'custom-model-og-v2': { name: '腾讯 Image 2 Fast', displayName: '腾讯快', vendor: 'tencent' },
  'gemini-3.1-flash-image': { name: 'Nano Banana 2', displayName: '谷歌', vendor: 'google' },
  'gpt-image-2.5-flare': { name: 'GPT Image 2.5 Flare', displayName: 'OpenAI', vendor: 'openai' },
  'gpt-image-2.5-sunburst': { name: 'GPT Image 2.5 Sunburst', displayName: 'OpenAI', vendor: 'openai' },
  sora_image: { name: 'Sora Image', displayName: '无厂商' },
}

const flatModels = {
  'model-1': { name: 'Model 1', displayName: 'Test Model 1' },
  'model-2': { name: 'Model 2', displayName: 'Test Model 2' },
}

function makeApi(models: Record<string, unknown>, current: string) {
  return {
    getAllModels: vi.fn(() => models),
    model: current,
    getCurrentModel: vi.fn(() => ({
      name: 'x',
      displayName: 'x',
      capabilities: { multipleImages: true, customSize: true },
    })),
    saveModel: vi.fn(() => true),
    models,
  }
}

describe('ModelSelectorManager vendor grouping', () => {
  let manager: ModelSelectorManager

  function mount(models: Record<string, unknown>, current: string): void {
    document.body.innerHTML = `
      <select id="modelSelector"></select>
      <select id="modelSelectorMobile"></select>
      <div id="ratioButtons"></div>
      <div id="resolutionContainer" class="hidden"><div id="resolutionButtons"></div></div>
      <select id="batchRatio"></select>
      <label id="batchCountLabel"></label>
    `
    const api = makeApi(models, current)
    vi.stubGlobal('Choices', MockChoices)
    vi.stubGlobal('aiImageAPI', api)
    vi.stubGlobal('i18n', {
      translations: { 'zh-CN': { aspectRatios: {}, resolutions: {} } },
      currentLang: 'zh-CN',
    })
    ;(window as any).aiImageAPI = api
    MockChoices.clearInstances()
    manager = createModelSelectorManager({ showToast: vi.fn() })
    manager.init()
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    manager.destroy()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    delete (window as any).aiImageAPI
  })

  it('wraps options in <optgroup> per vendor, vendor order fixed, 腾讯 gets its own group', () => {
    mount(vendorModels, 'custom-imagemodel-gt')

    const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
    const groups = Array.from(desktopSelect.querySelectorAll('optgroup'))
    expect(groups.map((g) => g.label)).toEqual(['Seedream', '腾讯', 'Google', 'OpenAI', '其他'])
    expect(groups.map((g) => g.dataset.vendor)).toEqual(['bytedance', 'tencent', 'google', 'openai', 'other'])

    const tencent = groups[1]
    expect(Array.from(tencent.querySelectorAll('option')).map((o) => o.value)).toEqual([
      'custom-imagemodel-gt',
      'custom-model-og-v2',
    ])
    // 没标 vendor 的落到「其他」,不丢
    expect(Array.from(groups[4].querySelectorAll('option')).map((o) => o.value)).toEqual(['sora_image'])
    // 每个模型只出现一次,总数不变;当前模型仍被选中
    expect(desktopSelect.options.length).toBe(Object.keys(vendorModels).length)
    expect(desktopSelect.value).toBe('custom-imagemodel-gt')
  })

  it('desktop uses the two-level VendorModelPanel (Choices only stays on mobile)', () => {
    mount(vendorModels, 'custom-imagemodel-gt')
    expect(MockChoices.instances).toHaveLength(1)
    expect(MockChoices.instances[0].element.id).toBe('modelSelectorMobile')
    const trigger = document.querySelector('.model-selector-wrapper .model-trigger, .model-trigger') as HTMLButtonElement
    expect(trigger).not.toBeNull()
    expect(trigger.querySelector('.model-vendor-chip')?.textContent).toBe('腾讯')
    expect(trigger.querySelector('.model-selected-name')?.textContent).toBe('Image 2')

    // 面板点选 → manager.handleModelSwitch → api.saveModel
    trigger.click()
    document.querySelector<HTMLButtonElement>('.model-panel__vendor[data-vendor="openai"]')!.click()
    document.querySelector<HTMLButtonElement>('.model-panel__card[data-value="gpt-image-2.5-flare"]')!.click()
    expect((window as any).aiImageAPI.saveModel).toHaveBeenCalledWith('gpt-image-2.5-flare')
    expect(manager.getCurrentModelKey()).toBe('gpt-image-2.5-flare')
  })

  it('mobile selector gets the same grouping', () => {
    mount(vendorModels, 'custom-imagemodel-gt')

    const mobileSelect = document.getElementById('modelSelectorMobile') as HTMLSelectElement
    expect(Array.from(mobileSelect.querySelectorAll('optgroup')).map((g) => g.label)).toEqual([
      'Seedream',
      '腾讯',
      'Google',
      'OpenAI',
      '其他',
    ])
  })

  it('renders a flat list (no optgroup) when every model lands in a single group', () => {
    mount(flatModels, 'model-1')

    const desktopSelect = document.getElementById('modelSelector') as HTMLSelectElement
    expect(desktopSelect.querySelectorAll('optgroup')).toHaveLength(0)
    expect(Array.from(desktopSelect.options).map((o) => o.value)).toEqual(['model-1', 'model-2'])
  })

  it('renders a group heading with vendor name + model count via the choiceGroup template', () => {
    mount(vendorModels, 'custom-imagemodel-gt')

    const templates = MockChoices.instances[0].options.callbackOnCreateTemplates((html: string) => {
      const wrapper = document.createElement('div')
      wrapper.innerHTML = html.trim()
      return wrapper.firstElementChild as HTMLElement
    })
    const heading = templates.choiceGroup(
      { classNames: { group: 'choices__group', groupHeading: 'choices__heading' } },
      { id: 3, label: 'OpenAI', choices: [{}, {}, {}, {}, {}] },
    ) as HTMLElement

    expect(heading.getAttribute('role')).toBe('group')
    expect(heading.querySelector('.model-group-name')?.textContent).toBe('OpenAI')
    expect(heading.querySelector('.model-group-count')?.textContent).toBe('5')
  })

  // 顶栏选中态(设计稿 D6):36px 单行 = 厂商小标签 + 模型名 + ▾。
  describe('selected item template (vendor chip)', () => {
    function renderItem(value: string, label: string): HTMLElement {
      const templates = MockChoices.instances[0].options.callbackOnCreateTemplates((html: string) => {
        const wrapper = document.createElement('div')
        wrapper.innerHTML = html.trim()
        return wrapper.firstElementChild as HTMLElement
      })
      return templates.item({ classNames: { item: 'choices__item' } }, { value, label }) as HTMLElement
    }

    it('shows the vendor as a chip and strips it from a model name that already starts with it', () => {
      mount(vendorModels, 'custom-imagemodel-gt')
      const item = renderItem('custom-imagemodel-gt', '腾讯 Image 2 - 腾讯')
      expect(item.querySelector('.model-vendor-chip')?.textContent).toBe('腾讯')
      expect(item.querySelector('.model-selected-name')?.textContent).toBe('Image 2')
      expect(item.querySelector('.model-selected-caret')).not.toBeNull()
      // 完整名留在 title 里,truncate 后仍可悬停查看
      expect(item.getAttribute('title')).toBe('腾讯 Image 2')
    })

    it('keeps the full model name when it does not repeat the vendor', () => {
      mount(vendorModels, 'gpt-image-2.5-flare')
      const item = renderItem('gpt-image-2.5-flare', 'GPT Image 2.5 Flare - OpenAI')
      expect(item.querySelector('.model-vendor-chip')?.textContent).toBe('OpenAI')
      expect(item.querySelector('.model-selected-name')?.textContent).toBe('GPT Image 2.5 Flare')
    })

    it('omits the chip for a model without a known vendor', () => {
      mount(vendorModels, 'sora_image')
      const item = renderItem('sora_image', 'Sora Image - 无厂商')
      expect(item.querySelector('.model-vendor-chip')).toBeNull()
      expect(item.querySelector('.model-selected-name')?.textContent).toBe('Sora Image')
    })

    it('escapes markup in names instead of injecting it', () => {
      mount({ evil: { name: '<img src=x onerror=alert(1)> Model', displayName: 'x', vendor: 'openai' } }, 'evil')
      const item = renderItem('evil', '<img src=x onerror=alert(1)> Model - x')
      expect(item.querySelector('img')).toBeNull()
      expect(item.querySelector('.model-selected-name')?.textContent).toContain('<img')
    })
  })
})
