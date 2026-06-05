import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
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

const noop = () => {}

describe('ImageParamControls', () => {
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
