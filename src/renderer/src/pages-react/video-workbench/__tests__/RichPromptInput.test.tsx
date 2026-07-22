// RichPromptInput 单测:纯文本↔chip HTML 互转 + @ 建议弹层 + 人像库建议回填。

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SeedanceAssetItem } from '../../../../../types/seedance'
import { RichPromptInput, extractPlainText, textToHtml, type PromptMediaRef } from '../RichPromptInput'

const REFS: PromptMediaRef[] = [
  { kind: 'image', index1: 1, name: '猫.png', thumbSrc: 'data:image/png;base64,AAA' },
  { kind: 'video', index1: 1, name: '走路.mp4' },
]

afterEach(() => {
  cleanup()
})

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
