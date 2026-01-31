// tests/utils/format.test.ts
import { describe, it, expect } from 'vitest'
import {
  formatFileSize,
  formatDate,
  formatNumber,
  truncateText,
  formatDuration,
  formatPercentage
} from '../../src/renderer/src/utils/format'

describe('format utilities', () => {
  describe('formatFileSize', () => {
    it('应该格式化字节', () => {
      expect(formatFileSize(0)).toBe('0 Bytes')
      expect(formatFileSize(500)).toBe('500 Bytes')
    })

    it('应该格式化 KB', () => {
      expect(formatFileSize(1024)).toBe('1 KB')
      expect(formatFileSize(2048)).toBe('2 KB')
    })

    it('应该格式化 MB', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1 MB')
      expect(formatFileSize(5 * 1024 * 1024)).toBe('5 MB')
    })

    it('应该格式化 GB', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB')
    })

    it('应该支持指定小数位数', () => {
      expect(formatFileSize(1536, 1)).toBe('1.5 KB')
    })
  })

  describe('formatDate', () => {
    it('应该格式化日期对象', () => {
      const date = new Date('2024-01-15T10:30:00')
      const result = formatDate(date)
      
      expect(result).toContain('2024')
      expect(result).toContain('01')
      expect(result).toContain('15')
    })

    it('应该格式化时间戳', () => {
      const timestamp = new Date('2024-01-15').getTime()
      const result = formatDate(timestamp)
      
      expect(result).toContain('2024')
    })

    it('应该格式化日期字符串', () => {
      const result = formatDate('2024-01-15')
      
      expect(result).toContain('2024')
    })
  })

  describe('formatNumber', () => {
    it('应该格式化整数', () => {
      expect(formatNumber(1000)).toBe('1,000')
      expect(formatNumber(1000000)).toBe('1,000,000')
    })

    it('应该格式化小数', () => {
      expect(formatNumber(1234.56)).toBe('1,234.56')
    })

    it('应该处理负数', () => {
      expect(formatNumber(-1000)).toBe('-1,000')
    })
  })

  describe('truncateText', () => {
    it('应该截断长文本', () => {
      const text = 'This is a very long text that needs to be truncated'
      const result = truncateText(text, 20)
      
      expect(result.length).toBeLessThanOrEqual(23) // 20 + '...'
      expect(result).toContain('...')
    })

    it('应该保持短文本不变', () => {
      const text = 'Short text'
      const result = truncateText(text, 20)
      
      expect(result).toBe(text)
    })

    it('应该支持自定义省略符', () => {
      const text = 'Long text that needs truncation'
      const result = truncateText(text, 10, '…')
      
      expect(result).toContain('…')
    })
  })

  describe('formatDuration', () => {
    it('应该格式化秒', () => {
      expect(formatDuration(30)).toBe('30秒')
    })

    it('应该格式化分钟和秒', () => {
      expect(formatDuration(90)).toBe('1分30秒')
    })

    it('应该格式化小时', () => {
      expect(formatDuration(3661)).toBe('1小时1分1秒')
    })
  })

  describe('formatPercentage', () => {
    it('应该格式化百分比', () => {
      expect(formatPercentage(0.5)).toBe('50%')
      expect(formatPercentage(0.123)).toBe('12.3%')
    })

    it('应该支持指定小数位数', () => {
      expect(formatPercentage(0.1234, 2)).toBe('12.34%')
    })
  })
})
