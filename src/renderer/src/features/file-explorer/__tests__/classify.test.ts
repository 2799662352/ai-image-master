import { describe, it, expect } from 'vitest'
import { classify, TEXT_EDIT_LIMIT } from '../classify'

describe('classify', () => {
  it('classifies png as image regardless of mime', () => {
    expect(classify('a.PNG', 100)).toBe('image')
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
