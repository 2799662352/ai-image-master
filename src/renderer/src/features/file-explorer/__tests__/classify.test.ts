import { describe, it, expect } from 'vitest'
import { classify, TEXT_EDIT_LIMIT } from '../classify'

describe('classify', () => {
  it('classifies png as image regardless of mime', () => {
    expect(classify('a.PNG', 100)).toBe('image')
  })

  it('classifies avif and ico as images', () => {
    expect(classify('a.avif', 100)).toBe('image')
    expect(classify('favicon.ico', 100)).toBe('image')
  })

  it('classifies video files as video', () => {
    expect(classify('clip.mp4', 100)).toBe('video')
    expect(classify('clip.webm', 100)).toBe('video')
    expect(classify('clip.mov', 100)).toBe('video')
  })

  it('uses mime when given to classify video', () => {
    expect(classify('weirdname', 100, 'video/mp4')).toBe('video')
  })

  it('classifies pdf as pdf', () => {
    expect(classify('a.pdf', 100)).toBe('pdf')
  })

  it('classifies ts as text', () => {
    expect(classify('foo.ts', 100)).toBe('text')
  })

  it('classifies extensionless as text', () => {
    expect(classify('Makefile', 100)).toBe('text')
  })

  it('classifies file > TEXT_EDIT_LIMIT as binary even if extension is text', () => {
    expect(classify('big.log', TEXT_EDIT_LIMIT + 1)).toBe('binary')
  })

  it('classifies unknown extension as binary', () => {
    expect(classify('a.dat', 100)).toBe('binary')
  })

  it('uses mime when given to classify image', () => {
    expect(classify('weirdname', 100, 'image/jpeg')).toBe('image')
  })
})
