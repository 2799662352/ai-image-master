import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectorApp } from '../DirectorApp'
import { reloadDirectorSkills } from '@/services/pipeline/prompt-loader'
import { useDirectorStore } from '../stores/useDirectorStore'

const startGenerationMock = vi.fn()

vi.mock('../components/ReferenceImageUpload', () => ({
  ReferenceImageUpload: () => <div data-testid="ReferenceImageUpload" />,
}))
vi.mock('../components/ModeSelector', () => ({
  ModeSelector: () => <div data-testid="ModeSelector" />,
}))
vi.mock('../components/TemplateSelector', () => ({
  TemplateSelector: () => <div data-testid="TemplateSelector" />,
}))
vi.mock('../components/SceneInput', () => ({
  SceneInput: () => <div data-testid="SceneInput" />,
}))
vi.mock('../components/LayoutSelector', () => ({
  LayoutSelector: () => <div data-testid="LayoutSelector" />,
}))
vi.mock('../components/ImageCountSlider', () => ({
  ImageCountSlider: () => <div data-testid="ImageCountSlider" />,
}))
vi.mock('../components/RatioResolutionSelector', () => ({
  RatioResolutionSelector: () => <div data-testid="RatioResolutionSelector" />,
}))
vi.mock('../components/GenerateButton', () => ({
  GenerateButton: ({ onGenerate }: { onGenerate: () => void }) => (
    <button onClick={onGenerate}>Generate</button>
  ),
}))
vi.mock('../components/GenerationProgress', () => ({
  GenerationProgress: () => <div data-testid="GenerationProgress" />,
}))
vi.mock('../components/ResultsGallery', () => ({
  ResultsGallery: () => <div data-testid="ResultsGallery" />,
}))
vi.mock('../hooks/useDirectorGeneration', () => ({
  useDirectorGeneration: () => ({
    startGeneration: startGenerationMock,
  }),
}))

vi.mock('@/services/pipeline/prompt-loader', () => ({
  reloadDirectorSkills: vi.fn(),
  getDirectorSkillsFromConfig: vi.fn(() => []),
  getDirectorSkillLoadStats: vi.fn(() => ({
    builtinCount: 17,
    userCount: 1,
    mergedCount: 17,
    addedCount: 0,
    overriddenCount: 1,
  })),
}))

describe('DirectorApp refresh skills', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useDirectorStore.getState().reset()
    startGenerationMock.mockResolvedValue(undefined)
    ;(reloadDirectorSkills as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(window as any).electronAPI = {
      openSkillsFolder: vi.fn().mockResolvedValue({ success: true, path: 'C:/skills' }),
    }
    ;(window as any).toastManagerTS = {
      show: vi.fn(),
    }
  })
  afterEach(() => {
    cleanup()
  })

  it('显示刷新 Skills 按钮', () => {
    render(<DirectorApp />)
    expect(screen.getByRole('button', { name: '刷新 Skills' })).toBeTruthy()
  })

  it('显示打开 Skills 文件夹按钮', () => {
    render(<DirectorApp />)
    expect(screen.getByRole('button', { name: '打开 Skills 文件夹' })).toBeTruthy()
  })

  it('点击后调用 reloadDirectorSkills', async () => {
    render(<DirectorApp />)
    fireEvent.click(screen.getByRole('button', { name: '刷新 Skills' }))
    await waitFor(() => {
      expect(reloadDirectorSkills).toHaveBeenCalledTimes(1)
    })
  })

  it('刷新成功时调用 success toast', async () => {
    render(<DirectorApp />)
    fireEvent.click(screen.getByRole('button', { name: '刷新 Skills' }))
    await waitFor(() => {
      expect((window as any).toastManagerTS.show).toHaveBeenCalledWith(
        expect.stringContaining('Skills 已刷新'),
        'success',
      )
    })
  })

  it('刷新失败时调用 error toast', async () => {
    ;(reloadDirectorSkills as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('boom'),
    )
    render(<DirectorApp />)
    fireEvent.click(screen.getByRole('button', { name: '刷新 Skills' }))
    await waitFor(() => {
      expect((window as any).toastManagerTS.show).toHaveBeenCalledWith('boom', 'error')
    })
  })

  it('刷新后不影响 generate 流程触发', async () => {
    render(<DirectorApp />)
    fireEvent.click(screen.getByRole('button', { name: '刷新 Skills' }))
    await waitFor(() => {
      expect(reloadDirectorSkills).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await waitFor(() => {
      expect(startGenerationMock).toHaveBeenCalledTimes(1)
    })
  })

  it('快速重复点击仅触发一次刷新', async () => {
    let resolveReload: (() => void) | undefined
    ;(reloadDirectorSkills as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveReload = resolve
        }),
    )

    render(<DirectorApp />)
    const refreshBtn = screen.getByRole('button', { name: '刷新 Skills' })
    fireEvent.click(refreshBtn)
    fireEvent.click(refreshBtn)

    await waitFor(() => {
      expect(reloadDirectorSkills).toHaveBeenCalledTimes(1)
    })

    if (resolveReload) resolveReload()
  })

  it('点击打开 Skills 文件夹时调用 electronAPI 并提示成功', async () => {
    render(<DirectorApp />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Skills 文件夹' }))

    await waitFor(() => {
      expect((window as any).electronAPI.openSkillsFolder).toHaveBeenCalledTimes(1)
      expect((window as any).toastManagerTS.show).toHaveBeenCalledWith(
        expect.stringContaining('已打开 Skills 文件夹'),
        'success',
      )
    })
  })

  it('流式回调同 URL 不应被去重吞掉', async () => {
    startGenerationMock.mockImplementation(async (onProgress?: (p: any) => void) => {
      onProgress?.({ data: { type: 'image_generated', url: 'https://example.com/same.png', prompt: 'p1' } })
      onProgress?.({ data: { type: 'image_generated', url: 'https://example.com/same.png', prompt: 'p2' } })
    })

    render(<DirectorApp />)
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => {
      expect(startGenerationMock).toHaveBeenCalledTimes(1)
      expect(useDirectorStore.getState().generatedResults.length).toBe(2)
    })
  })

  it('预设按钮应显示 aria-pressed 激活态', async () => {
    render(<DirectorApp />)

    const speedBtn = screen.getByRole('button', { name: '一键预设：省时' })
    const qualityBtn = screen.getByRole('button', { name: '一键预设：质量' })

    expect(speedBtn.getAttribute('aria-pressed')).toBe('true')
    expect(qualityBtn.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(qualityBtn)

    await waitFor(() => {
      expect(speedBtn.getAttribute('aria-pressed')).toBe('false')
      expect(qualityBtn.getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('看图质量区块应支持折叠与展开', async () => {
    render(<DirectorApp />)

    const toggleBtn = screen.getByRole('button', { name: '收起看图质量设置' })
    expect(toggleBtn.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('场景分析')).toBeTruthy()

    fireEvent.click(toggleBtn)
    await waitFor(() => {
      const collapsedBtn = screen.getByRole('button', { name: '展开看图质量设置' })
      expect(collapsedBtn.getAttribute('aria-expanded')).toBe('false')
      expect(screen.queryByText('场景分析')).toBeNull()
    })

    fireEvent.click(screen.getByRole('button', { name: '展开看图质量设置' }))
    await waitFor(() => {
      expect(screen.getByText('场景分析')).toBeTruthy()
    })
  })
})
