import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectorApp } from '../DirectorApp'
import { useDirectorStore } from '../stores/useDirectorStore'

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
    startGeneration: vi.fn().mockResolvedValue(undefined),
  }),
}))
vi.mock('@/services/pipeline/prompt-loader', () => ({
  reloadDirectorSkills: vi.fn().mockResolvedValue(undefined),
  getDirectorSkillsFromConfig: vi.fn(() => []),
  getDirectorSkillLoadStats: vi.fn(() => ({
    builtinCount: 0,
    userCount: 0,
    mergedCount: 0,
    addedCount: 0,
    overriddenCount: 0,
  })),
}))

describe('DirectorApp skip-stage toggles', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useDirectorStore.getState().reset()
  })
  afterEach(() => {
    cleanup()
  })

  it('should render skip toggles for analyzeScene, characterAnchors, and verifyConsistency', () => {
    render(<DirectorApp />)
    expect(screen.getByLabelText('跳过场景分析')).toBeTruthy()
    expect(screen.getByLabelText('跳过角色锚定')).toBeTruthy()
    expect(screen.getByLabelText('跳过一致性校验')).toBeTruthy()
  })

  it('should not render a skip toggle for designAndAssemble', () => {
    render(<DirectorApp />)
    expect(screen.queryByLabelText('跳过分镜+Prompt')).toBeNull()
  })

  it('should toggle skipAnalyzeScene in store when clicked', () => {
    render(<DirectorApp />)
    const toggle = screen.getByLabelText('跳过场景分析')
    fireEvent.click(toggle)
    expect(useDirectorStore.getState().skipAnalyzeScene).toBe(true)
    fireEvent.click(toggle)
    expect(useDirectorStore.getState().skipAnalyzeScene).toBe(false)
  })

  it('should toggle skipCharacterAnchors in store when clicked', () => {
    render(<DirectorApp />)
    const toggle = screen.getByLabelText('跳过角色锚定')
    fireEvent.click(toggle)
    expect(useDirectorStore.getState().skipCharacterAnchors).toBe(true)
    fireEvent.click(toggle)
    expect(useDirectorStore.getState().skipCharacterAnchors).toBe(false)
  })
})
