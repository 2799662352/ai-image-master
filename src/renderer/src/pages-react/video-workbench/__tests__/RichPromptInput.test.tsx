// RichPromptInput 单测:纯文本↔chip HTML 互转 + @ 建议弹层(分组/滚轮)+
// 人像库/跨卡素材建议回填。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceAssetItem } from '../../../../../types/seedance'
import {
  RichPromptInput,
  extractPlainText,
  textToHtml,
  type PageMaterialRef,
  type PromptMediaRef,
} from '../RichPromptInput'

const REFS: PromptMediaRef[] = [
  { kind: 'image', index1: 1, name: '猫.png', thumbSrc: 'data:image/png;base64,AAA' },
  { kind: 'video', index1: 1, name: '走路.mp4' },
]

afterEach(() => {
  cleanup()
})

/** 在编辑器里模拟输入文本并把光标落到末尾(jsdom 无真实输入法)。 */
async function typeInEditor(editor: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    editor.focus()
    editor.textContent = text
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    fireEvent.input(editor)
  })
}

describe('textToHtml / extractPlainText 互转', () => {
  it('token 渲染为不可编辑 chip(有缩略图用 img,无则 emoji)', () => {
    const html = textToHtml('一只【@图片1】和【@视频1】', REFS)
    expect(html).toContain('vw-token-node')
    expect(html).toContain('contenteditable="false"')
    expect(html).toContain('data-token="【@图片1】"')
    expect(html).toContain('<img src="data:image/png;base64,AAA"')
    expect(html).toContain('vw-token-emoji') // 视频无缩略图 → emoji
  })

  it('HTML 特殊字符被转义,换行转 br', () => {
    const html = textToHtml('<b>x</b>\ny', [])
    expect(html).toBe('&lt;b&gt;x&lt;/b&gt;<br>y')
  })

  it('extractPlainText 从 chip DOM 还原 token 文本(round-trip)', () => {
    const div = document.createElement('div')
    div.innerHTML = textToHtml('前【@图片1】后\n尾', REFS)
    expect(extractPlainText(div)).toBe('前【@图片1】后\n尾')
  })
})

describe('RichPromptInput @ 建议', () => {
  it('输入 @图 呼出建议弹层并列出已有素材;点击插入 token', async () => {
    const onChange = vi.fn()
    render(
      <RichPromptInput value="" mediaRefs={REFS} onChange={onChange} />,
    )
    const editor = screen.getByRole('textbox')
    // jsdom 没有真实输入法:直接改 DOM + 触发 input 事件
    await act(async () => {
      editor.focus()
      editor.textContent = '@图'
      // 光标落在文本末尾(detectAtTrigger 需要 selection)
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      fireEvent.input(editor)
    })
    const popup = await screen.findByTestId('vw-at-popup')
    expect(popup.textContent).toContain('图片1')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /图片1/ }))
    })
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('【@图片1】'))
  })

  it('人像库建议:选中先 onPickAsset 回填素材,再按返回序号插 token', async () => {
    const asset: SeedanceAssetItem = {
      id: 'row1',
      kind: 'image',
      name: '赛博猫',
      assetUrl: 'asset://abc',
      assetId: 'abc',
      previewUrl: 'https://cdn/x.jpg',
    }
    const onChange = vi.fn()
    const onPickAsset = vi.fn(() => ({ kind: 'image' as const, index1: 3 }))
    const searchAssets = vi.fn(async () => [asset])
    render(
      <RichPromptInput
        value=""
        mediaRefs={[]}
        onChange={onChange}
        onPickAsset={onPickAsset}
        searchAssets={searchAssets}
      />,
    )
    const editor = screen.getByRole('textbox')
    await act(async () => {
      editor.focus()
      editor.textContent = '@赛博'
      const range = document.createRange()
      range.selectNodeContents(editor)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      fireEvent.input(editor)
    })
    const item = await screen.findByRole('button', { name: /赛博猫/ })
    await act(async () => {
      fireEvent.click(item)
    })
    expect(onPickAsset).toHaveBeenCalledWith(asset)
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('【@图片3】'))
  })
})

describe('@ 建议分组(本页素材 / 人像库)', () => {
  const PAGE_MATERIAL: PageMaterialRef = {
    kind: 'image',
    material: { name: '别卡的图.png', src: 'data:image/png;base64,OTHER' },
    thumbSrc: 'data:image/png;base64,OTHER',
  }
  const ASSET: SeedanceAssetItem = {
    id: 'row1',
    kind: 'image',
    name: '赛博猫',
    assetUrl: 'asset://abc',
    assetId: 'abc',
    previewUrl: 'https://cdn/x.jpg',
  }

  it('本页素材(本卡+其他卡)排前带标题,人像库独立次分组排后', async () => {
    render(
      <RichPromptInput
        value=""
        mediaRefs={REFS}
        onChange={vi.fn()}
        getPageMaterials={() => [PAGE_MATERIAL]}
        searchAssets={async () => [ASSET]}
      />,
    )
    await typeInEditor(screen.getByRole('textbox'), '@')
    const popup = await screen.findByTestId('vw-at-popup')
    await screen.findByRole('button', { name: /赛博猫/ })

    const text = popup.textContent ?? ''
    const iPageHeader = text.indexOf('本页素材')
    const iExisting = text.indexOf('图片1')
    const iCross = text.indexOf('别卡的图.png')
    const iAssetHeader = text.indexOf('人像库')
    const iAsset = text.indexOf('赛博猫')
    expect(iPageHeader).toBeGreaterThanOrEqual(0)
    expect(iExisting).toBeGreaterThan(iPageHeader)
    expect(iCross).toBeGreaterThan(iExisting)
    expect(iAssetHeader).toBeGreaterThan(iCross)
    expect(iAsset).toBeGreaterThan(iAssetHeader)
    // 分组标题不是按钮(不参与键盘高亮)
    expect(popup.querySelectorAll('.vw-at-group-label')).toHaveLength(2)
  })

  it('键盘上下键跨组移动高亮,Enter 提交人像库项', async () => {
    const onChange = vi.fn()
    const onPickAsset = vi.fn(() => ({ kind: 'image' as const, index1: 2 }))
    render(
      <RichPromptInput
        value=""
        mediaRefs={[REFS[0]]}
        onChange={onChange}
        onPickAsset={onPickAsset}
        searchAssets={async () => [ASSET]}
      />,
    )
    const editor = screen.getByRole('textbox')
    await typeInEditor(editor, '@')
    await screen.findByRole('button', { name: /赛博猫/ })

    // 初始高亮在「本页素材」组第 1 项
    expect(screen.getByRole('button', { name: /图片1/ }).className).toContain('vw-at-active')
    // ↓ 跨过组边界移到「人像库」项
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'ArrowDown' })
    })
    expect(screen.getByRole('button', { name: /赛博猫/ }).className).toContain('vw-at-active')
    // ↑ 回到本页素材组
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'ArrowUp' })
    })
    expect(screen.getByRole('button', { name: /图片1/ }).className).toContain('vw-at-active')

    await act(async () => {
      fireEvent.keyDown(editor, { key: 'ArrowDown' })
    })
    await act(async () => {
      fireEvent.keyDown(editor, { key: 'Enter' })
    })
    expect(onPickAsset).toHaveBeenCalledWith(ASSET)
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('【@图片2】'))
  })

  it('选中其他卡片素材:onPickMaterial 入本卡并按返回序号插 token', async () => {
    const onChange = vi.fn()
    const onPickMaterial = vi.fn(() => ({ kind: 'image' as const, index1: 5 }))
    render(
      <RichPromptInput
        value=""
        mediaRefs={[]}
        onChange={onChange}
        getPageMaterials={() => [PAGE_MATERIAL]}
        onPickMaterial={onPickMaterial}
      />,
    )
    await typeInEditor(screen.getByRole('textbox'), '@')
    const item = await screen.findByRole('button', { name: /别卡的图/ })
    await act(async () => {
      fireEvent.click(item)
    })
    expect(onPickMaterial).toHaveBeenCalledWith(PAGE_MATERIAL)
    expect(onChange).toHaveBeenLastCalledWith(expect.stringContaining('【@图片5】'))
  })
})

describe('@ 弹层滚轮不穿透页面', () => {
  function defineScroll(el: HTMLElement, { top, height, client }: { top: number; height: number; client: number }) {
    Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { value: height, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: client, configurable: true })
  }

  async function openPopup(): Promise<HTMLElement> {
    render(<RichPromptInput value="" mediaRefs={REFS} onChange={vi.fn()} />)
    await typeInEditor(screen.getByRole('textbox'), '@')
    return await screen.findByTestId('vw-at-popup')
  }

  it('列表已到底继续下滚 → preventDefault(不带动页面)', async () => {
    const popup = await openPopup()
    defineScroll(popup, { top: 300, height: 500, client: 200 })
    const ev = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })
    popup.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('列表在顶部继续上滚 → preventDefault', async () => {
    const popup = await openPopup()
    defineScroll(popup, { top: 0, height: 500, client: 200 })
    const ev = new WheelEvent('wheel', { deltaY: -60, bubbles: true, cancelable: true })
    popup.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
  })

  it('列表中段可滚 → 不 preventDefault(列表自己滚),但一律不冒泡到页面', async () => {
    const popup = await openPopup()
    defineScroll(popup, { top: 100, height: 500, client: 200 })
    const bodySpy = vi.fn()
    document.body.addEventListener('wheel', bodySpy)
    const ev = new WheelEvent('wheel', { deltaY: 60, bubbles: true, cancelable: true })
    popup.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(bodySpy).not.toHaveBeenCalled()
    document.body.removeEventListener('wheel', bodySpy)
  })
})
