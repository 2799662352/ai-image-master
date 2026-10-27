import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ImageParamControls } from '../ImageParamControls'

afterEach(() => cleanup())
import type { ImageParamModelConfig } from '../../../services/api/imageParamControls'

const GPT_IMAGE_2: ImageParamModelConfig = {
  ratios: [{ key: 'auto', label: '自适应' }, { key: '16:9', label: '宽屏' }],
  resolutions: [{ key: '1K' }, { key: '2K' }, { key: '4K' }],
  qualities: [
    { key: 'auto', label: '自动' },
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
  ],
  defaultResolution: '1K',
  defaultQuality: 'auto',
  capabilities: { resolutionControl: true, qualityControl: true },
}

const VIP: ImageParamModelConfig = {
  ratios: [{ key: 'auto' }, { key: '16:9' }],
  resolutions: [{ key: '2K' }, { key: '4K' }],
  defaultResolution: '2K',
  capabilities: { resolutionControl: true },
}

/** 支持图层分离的模型 —— 参数区不该因此长出任何东西 */
const SEEDREAM_5_PRO: ImageParamModelConfig = {
  ratios: [{ key: 'auto' }, { key: '16:9' }],
  resolutions: [{ key: '1K' }, { key: '2K' }],
  defaultResolution: '2K',
  capabilities: { resolutionControl: true },
}

/** 2.5 flare / sunburst:五档 quality + 透明底轴 */
const GPT_IMAGE_25_FLARE: ImageParamModelConfig = {
  ratios: [{ key: 'auto' }, { key: '1:1' }],
  resolutions: [{ key: '1K' }, { key: '2K' }, { key: '4K' }],
  qualities: [
    { key: 'low', label: '低' },
    { key: 'medium', label: '中' },
    { key: 'high', label: '高' },
    { key: 'xhigh', label: '超高' },
    { key: 'max', label: '最高' },
  ],
  defaultResolution: '2K',
  defaultQuality: 'high',
  capabilities: {
    resolutionControl: true,
    qualityControl: true,
    transparentBackgroundControl: true,
    multipleImages: true,
    nativeBatch: true,
    maxOutputs: 4,
  },
}

/** 万相:组图数量轴,不是「原生支持」 */
const WAN_27: ImageParamModelConfig = {
  ratios: [{ key: '1:1' }, { key: '16:9' }],
  resolutions: [{ key: '1K' }, { key: '2K' }, { key: '4K' }],
  defaultResolution: '2K',
  capabilities: { resolutionControl: true, multipleImages: true, maxOutputs: 12 },
}

const noop = () => {}

describe('ImageParamControls', () => {
  it('gpt-image-2.5-flare: 多出「透明背景」开关, 清晰度是五档', () => {
    const onTransparentBackgroundChange = vi.fn()
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_25_FLARE}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        quality="high"
        onQualityChange={noop}
        transparentBackground={false}
        onTransparentBackgroundChange={onTransparentBackgroundChange}
      />,
    )
    const toggle = screen.getByLabelText<HTMLSelectElement>('透明背景')
    expect([...toggle.options].map((o) => o.value)).toEqual(['off', 'on'])
    expect(toggle.value).toBe('off')
    fireEvent.change(toggle, { target: { value: 'on' } })
    expect(onTransparentBackgroundChange).toHaveBeenCalledWith(true)

    const quality = screen.getByLabelText<HTMLSelectElement>('清晰度')
    expect([...quality.options].map((o) => o.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('原生多图(flare): 数量轴标「数量（原生支持）」、1-4 张、带倍数计费提示', () => {
    const onCountChange = vi.fn()
    const { rerender } = render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_25_FLARE}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        quality="high"
        onQualityChange={noop}
        count={1}
        onCountChange={onCountChange}
      />,
    )
    expect(screen.getByText('// 数量（原生支持）')).toBeTruthy()
    const count = screen.getByLabelText<HTMLSelectElement>('数量')
    expect([...count.options].map((o) => o.value)).toEqual(['1', '2', '3', '4'])
    // 选 1 张时只是告知能力 + 计费口径
    expect(screen.getByTestId('native-batch-billing-note').textContent).toMatch(/1-4 张.*倍数计费/)

    fireEvent.change(count, { target: { value: '3' } })
    expect(onCountChange).toHaveBeenCalledWith(3)

    rerender(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_25_FLARE}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        quality="high"
        onQualityChange={noop}
        count={3}
        onCountChange={onCountChange}
      />,
    )
    // 选了 >1 张:醒目地说清这次是 3 倍钱
    expect(screen.getByTestId('native-batch-billing-note').textContent).toMatch(/⚠️.*3 张倍数计费/)
  })

  it('万相组图: 数量轴还是「数量」, 没有原生多图计费提示', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={WAN_27}
        ratio="1:1"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        count={4}
        onCountChange={noop}
      />,
    )
    expect(screen.getByText('// 数量')).toBeTruthy()
    expect(screen.queryByText(/原生支持/)).toBeNull()
    expect(screen.queryByTestId('native-batch-billing-note')).toBeNull()
    expect(screen.getByLabelText<HTMLSelectElement>('数量').options).toHaveLength(12)
  })

  it('从 flare(选了 4 张)切到单图渠道: 数量轴消失且 count 自动归 1', () => {
    const onCountChange = vi.fn()
    const { rerender } = render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_25_FLARE}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        quality="high"
        onQualityChange={noop}
        count={4}
        onCountChange={onCountChange}
      />,
    )
    expect(onCountChange).not.toHaveBeenCalled()
    rerender(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_2}
        ratio="auto"
        onRatioChange={noop}
        resolution="1K"
        onResolutionChange={noop}
        quality="auto"
        onQualityChange={noop}
        count={4}
        onCountChange={onCountChange}
      />,
    )
    expect(screen.queryByLabelText('数量')).toBeNull()
    expect(onCountChange).toHaveBeenCalledWith(1)
  })

  it('不支持透明底的模型不渲染开关, 即便页面把 props 传下来了', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_2}
        ratio="auto"
        onRatioChange={noop}
        resolution="1K"
        onResolutionChange={noop}
        quality="auto"
        onQualityChange={noop}
        transparentBackground={false}
        onTransparentBackgroundChange={noop}
      />,
    )
    expect(screen.queryByLabelText('透明背景')).toBeNull()
  })

  it('开着透明底切到不支持的模型 → 自动复位 false(别让下一张腾讯图带着隐藏的透明底状态)', () => {
    const onTransparentBackgroundChange = vi.fn()
    const { rerender } = render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_25_FLARE}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        quality="high"
        onQualityChange={noop}
        transparentBackground={true}
        onTransparentBackgroundChange={onTransparentBackgroundChange}
      />,
    )
    expect(onTransparentBackgroundChange).not.toHaveBeenCalled()
    rerender(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={GPT_IMAGE_2}
        ratio="auto"
        onRatioChange={noop}
        resolution="1K"
        onResolutionChange={noop}
        quality="auto"
        onQualityChange={noop}
        transparentBackground={true}
        onTransparentBackgroundChange={onTransparentBackgroundChange}
      />,
    )
    expect(onTransparentBackgroundChange).toHaveBeenCalledWith(false)
  })

  it('gpt-image-2: 渲染 比例 / 分辨率 / 清晰度 三个下拉', () => {
    render(
      <ImageParamControls
        variant="director"
        modelConfig={GPT_IMAGE_2}
        ratio="auto"
        onRatioChange={noop}
        resolution="1K"
        onResolutionChange={noop}
        quality="auto"
        onQualityChange={noop}
      />,
    )
    expect(screen.getByLabelText('比例')).toBeTruthy()
    expect(screen.getByLabelText('分辨率')).toBeTruthy()
    expect(screen.getByLabelText('清晰度')).toBeTruthy()
  })

  it('VIP(无 quality): 只渲染 比例 / 分辨率, 不渲染清晰度', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={VIP}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
      />,
    )
    expect(screen.getByLabelText('比例')).toBeTruthy()
    expect(screen.getByLabelText('分辨率')).toBeTruthy()
    expect(screen.queryByLabelText('清晰度')).toBeNull()
  })

  it('不支持分辨率: 显示「按模型默认」占位, 无分辨率下拉', () => {
    render(
      <ImageParamControls
        variant="director"
        modelConfig={{ ratios: [{ key: '16:9' }], capabilities: { resolutionControl: false } }}
        ratio="16:9"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
      />,
    )
    expect(screen.queryByLabelText('分辨率')).toBeNull()
    expect(screen.getByText('按模型默认')).toBeTruthy()
  })

  it('当前比例不在选项内: 自动归位调用 onRatioChange', () => {
    const onRatioChange = vi.fn()
    render(
      <ImageParamControls
        variant="director"
        modelConfig={GPT_IMAGE_2}
        ratio="3:2"
        onRatioChange={onRatioChange}
        resolution="1K"
        onResolutionChange={noop}
        quality="auto"
        onQualityChange={noop}
      />,
    )
    expect(onRatioChange).toHaveBeenCalledWith('auto')
  })

  it('参数区不掺图层分离 —— 它是 VisualPromptBar 上的独立动作，不是改变「生成」语义的模式开关', () => {
    // 曾经这里有个开关，勾上之后「生成」按钮就变成拆图，还连带把比例/数量灰掉、
    // 切模型要自动关 —— 正常出图和图层分离焊死在一起。这条守住它别回来。
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={SEEDREAM_5_PRO}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        count={1}
        onCountChange={noop}
      />,
    )
    expect(screen.queryByLabelText('图层分离')).toBeNull()
    // 即便选了支持拆分的模型，比例/数量/分辨率也照常可用，不被任何拆分状态影响
    expect(screen.getByLabelText('比例')).toBeTruthy()
    expect(screen.getByLabelText('分辨率')).toBeTruthy()
    const opts = [...screen.getByLabelText<HTMLSelectElement>('分辨率').options].map((o) => o.value)
    expect(opts).toEqual(['1K', '2K'])
  })

  it('sizeStrategy=prompt: 显示尺寸自适应提示, 不渲染任何下拉', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={{ sizeStrategy: 'prompt' }}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
      />,
    )
    expect(screen.queryByLabelText('比例')).toBeNull()
    expect(screen.getByText(/尺寸自适应/)).toBeTruthy()
  })
})
