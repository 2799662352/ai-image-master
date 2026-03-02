import { describe, it, expect, beforeEach } from 'vitest'
import { useDirectorStore } from '../useDirectorStore'

describe('useDirectorStore', () => {
  beforeEach(() => {
    useDirectorStore.getState().reset()
  })

  it('should have correct initial state', () => {
    const state = useDirectorStore.getState()
    expect(state.referenceImages).toEqual([])
    expect(state.isGenerating).toBe(false)
    expect(state.currentLayout).toBe('6grid')
    expect(state.currentRatio).toBe('3:2')
    expect(state.currentResolution).toBe('2K')
    expect(state.currentTemplate).toBeNull()
    expect(state.visionModel).toBe('')
    expect(state.sceneDescription).toBe('')
  })

  it('should add reference image', () => {
    const image = { data: 'base64data', mimeType: 'image/jpeg', name: 'test.jpg' }
    useDirectorStore.getState().addReferenceImage(image)
    expect(useDirectorStore.getState().referenceImages).toHaveLength(1)
    expect(useDirectorStore.getState().referenceImages[0]).toEqual(image)
  })

  it('should remove reference image by index', () => {
    const img1 = { data: 'a', mimeType: 'image/jpeg', name: '1.jpg' }
    const img2 = { data: 'b', mimeType: 'image/jpeg', name: '2.jpg' }
    useDirectorStore.getState().addReferenceImage(img1)
    useDirectorStore.getState().addReferenceImage(img2)
    useDirectorStore.getState().removeReferenceImage(0)
    expect(useDirectorStore.getState().referenceImages).toHaveLength(1)
    expect(useDirectorStore.getState().referenceImages[0].name).toBe('2.jpg')
  })

  it('should clear all reference images', () => {
    useDirectorStore.getState().addReferenceImage({ data: 'a', mimeType: 'image/jpeg', name: '1.jpg' })
    useDirectorStore.getState().clearReferenceImages()
    expect(useDirectorStore.getState().referenceImages).toEqual([])
  })

  it('should set layout', () => {
    useDirectorStore.getState().setLayout('4grid')
    expect(useDirectorStore.getState().currentLayout).toBe('4grid')
  })

  it('should set generation state', () => {
    useDirectorStore.getState().setIsGenerating(true)
    expect(useDirectorStore.getState().isGenerating).toBe(true)
  })

  it('should enforce max 8 reference images', () => {
    for (let i = 0; i < 10; i++) {
      useDirectorStore.getState().addReferenceImage({
        data: `img${i}`, mimeType: 'image/jpeg', name: `${i}.jpg`
      })
    }
    expect(useDirectorStore.getState().referenceImages).toHaveLength(8)
  })

  it('should set template', () => {
    useDirectorStore.getState().setTemplate('anime')
    expect(useDirectorStore.getState().currentTemplate).toBe('anime')
  })

  it('should set ratio and resolution', () => {
    useDirectorStore.getState().setRatio('16:9')
    useDirectorStore.getState().setResolution('4K')
    expect(useDirectorStore.getState().currentRatio).toBe('16:9')
    expect(useDirectorStore.getState().currentResolution).toBe('4K')
  })

  it('should set scene description', () => {
    useDirectorStore.getState().setSceneDescription('A cyberpunk city')
    expect(useDirectorStore.getState().sceneDescription).toBe('A cyberpunk city')
  })

  it('should reset to initial state', () => {
    useDirectorStore.getState().addReferenceImage({ data: 'x', mimeType: 'image/jpeg', name: 'x.jpg' })
    useDirectorStore.getState().setLayout('4grid')
    useDirectorStore.getState().setIsGenerating(true)
    useDirectorStore.getState().reset()
    const state = useDirectorStore.getState()
    expect(state.referenceImages).toEqual([])
    expect(state.currentLayout).toBe('6grid')
    expect(state.isGenerating).toBe(false)
  })

  it('should set imageCount', () => {
    useDirectorStore.getState().setImageCount(5)
    expect(useDirectorStore.getState().imageCount).toBe(5)
  })

  it('should reset imageCount to 1', () => {
    useDirectorStore.getState().setImageCount(8)
    useDirectorStore.getState().reset()
    expect(useDirectorStore.getState().imageCount).toBe(1)
  })
})
