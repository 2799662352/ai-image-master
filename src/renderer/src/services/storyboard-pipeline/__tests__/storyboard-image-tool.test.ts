import { describe, it, expect } from 'vitest'
import { createViewImagesTool } from '../storyboard-image-tool'

describe('createViewImagesTool', () => {
  it('should return a tool with name view_images', () => {
    const images = [{ data: 'base64data', mimeType: 'image/png' }]
    const viewTool = createViewImagesTool(images)
    expect(viewTool.name).toBe('view_images')
  })

  it('should return multimodal content blocks when invoked', async () => {
    const images = [
      { data: 'aGVsbG8=', mimeType: 'image/png' },
      { data: 'd29ybGQ=', mimeType: 'image/jpeg' },
    ]
    const viewTool = createViewImagesTool(images)
    const result = await viewTool.invoke({})
    expect(result).toContain('data:image/png;base64,aGVsbG8=')
    expect(result).toContain('data:image/jpeg;base64,d29ybGQ=')
  })

  it('should return descriptive message when no images', async () => {
    const viewTool = createViewImagesTool([])
    const result = await viewTool.invoke({})
    expect(result).toContain('No images')
  })
})
