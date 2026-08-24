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

const SEEDREAM_5_PRO: ImageParamModelConfig = {
  ratios: [{ key: 'auto' }, { key: '16:9' }],
  resolutions: [{ key: '1K' }, { key: '2K' }],
  defaultResolution: '2K',
  capabilities: { resolutionControl: true, layerDecomposition: true },
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

  it('图层分离: 仅 capabilities.layerDecomposition 的模型渲染开关', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={SEEDREAM_5_PRO}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        layerDecomposition={false}
        onLayerDecompositionChange={noop}
      />,
    )
    expect(screen.getByLabelText('图层分离')).toBeTruthy()
  })

  it('图层分离: 模型不支持时不渲染开关(即便页面传了 props)', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={VIP}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        layerDecomposition={false}
        onLayerDecompositionChange={noop}
      />,
    )
    expect(screen.queryByLabelText('图层分离')).toBeNull()
  })

  it('图层分离: 页面没接这个字段时不渲染开关(即便模型支持)', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={SEEDREAM_5_PRO}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
      />,
    )
    expect(screen.queryByLabelText('图层分离')).toBeNull()
  })

  it('图层分离开启: 比例/数量灰掉(上游按图内容决定，留着下拉是骗人)', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={{ ...SEEDREAM_5_PRO, capabilities: { ...SEEDREAM_5_PRO.capabilities, multipleImages: true, maxOutputs: 4 } }}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        count={1}
        onCountChange={noop}
        layerDecomposition
        onLayerDecompositionChange={noop}
      />,
    )
    expect(screen.queryByLabelText('比例')).toBeNull()
    expect(screen.queryByLabelText('数量')).toBeNull()
    expect(screen.getByText('跟随原图')).toBeTruthy()
    expect(screen.getByText('按图层数')).toBeTruthy()
    // 分辨率在拆分下仍然有效(被当作档位用)，不能一起灰掉
    expect(screen.getByLabelText('分辨率')).toBeTruthy()
  })

  it('开启拆分: 分辨率换成拆分档位（auto / 1.5K 在普通出图那两档里根本选不到）', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={SEEDREAM_5_PRO}
        ratio="auto"
        onRatioChange={noop}
        resolution="auto"
        onResolutionChange={noop}
        layerDecomposition
        onLayerDecompositionChange={noop}
      />,
    )
    const opts = [...screen.getByLabelText<HTMLSelectElement>('分辨率').options].map((o) => o.value)
    expect(opts).toEqual(['auto', '1K', '1.5K', '2K'])
  })

  it('关闭拆分: 分辨率回到模型自带的档位', () => {
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={SEEDREAM_5_PRO}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        layerDecomposition={false}
        onLayerDecompositionChange={noop}
      />,
    )
    const opts = [...screen.getByLabelText<HTMLSelectElement>('分辨率').options].map((o) => o.value)
    expect(opts).toEqual(['1K', '2K'])
  })

  it('开关从关到开: 落到推荐的 auto（停在 2K 会把底图按 2K 档重出，与原图对不上）', () => {
    const onResolutionChange = vi.fn()
    const props = {
      variant: 'cyberpunk' as const,
      modelConfig: SEEDREAM_5_PRO,
      ratio: 'auto',
      onRatioChange: noop,
      resolution: '2K',
      onResolutionChange,
      onLayerDecompositionChange: noop,
    }
    const { rerender } = render(<ImageParamControls {...props} layerDecomposition={false} />)
    onResolutionChange.mockClear()

    rerender(<ImageParamControls {...props} layerDecomposition />)

    // 2K 凑巧也是合法拆分档位，靠归位不会动它 —— 必须显式落到 auto
    expect(onResolutionChange).toHaveBeenCalledWith('auto')
  })

  it('切到不支持拆分的模型: 自动把开关关掉', () => {
    // 开关此时已经不渲染，用户看不到也关不掉；留着 true 会一路发到 ApiService
    // 被能力守卫拒掉，表现为「换个模型就生成不了了」。
    const onLayerDecompositionChange = vi.fn()
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={VIP}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        layerDecomposition
        onLayerDecompositionChange={onLayerDecompositionChange}
      />,
    )
    expect(onLayerDecompositionChange).toHaveBeenCalledWith(false)
  })

  it('支持拆分的模型: 不会把开关自动关掉', () => {
    const onLayerDecompositionChange = vi.fn()
    render(
      <ImageParamControls
        variant="cyberpunk"
        modelConfig={SEEDREAM_5_PRO}
        ratio="auto"
        onRatioChange={noop}
        resolution="2K"
        onResolutionChange={noop}
        layerDecomposition
        onLayerDecompositionChange={onLayerDecompositionChange}
      />,
    )
    expect(onLayerDecompositionChange).not.toHaveBeenCalled()
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
