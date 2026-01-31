// src/renderer/src/utils/format.ts
/**
 * 格式化工具函数
 */

/**
 * 格式化文件大小
 * @param bytes 字节数
 * @param decimals 小数位数 (可选，默认自动)
 */
export function formatFileSize(bytes: number, decimals?: number): string {
  if (bytes === 0) return '0 Bytes'
  
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const k = 1024
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  
  const value = bytes / Math.pow(k, i)
  
  // 如果指定了小数位，使用指定的；否则整数不显示小数
  if (decimals !== undefined) {
    return `${parseFloat(value.toFixed(decimals))} ${units[i]}`
  }
  
  // 整数不显示小数
  const formatted = value % 1 === 0 ? value.toString() : value.toFixed(2)
  return `${parseFloat(formatted)} ${units[i]}`
}

/**
 * 格式化日期
 */
export function formatDate(date: Date | string | number, format = 'YYYY-MM-DD'): string {
  const d = new Date(date)
  
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  
  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
    .replace('ss', seconds)
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(date: Date | string | number): string {
  const now = new Date()
  const d = new Date(date)
  const diff = now.getTime() - d.getTime()
  
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  
  if (seconds < 60) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (hours < 24) return `${hours} 小时前`
  if (days < 7) return `${days} 天前`
  
  return formatDate(d)
}

/**
 * 格式化数字（添加千分位分隔符）
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('en-US')
}

/**
 * 截断文本
 */
export function truncateText(text: string, maxLength: number, suffix = '...'): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - suffix.length) + suffix
}

/**
 * 格式化持续时间 (中文格式)
 * @param seconds 秒数
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  
  if (h > 0) {
    return `${h}小时${m}分${s}秒`
  }
  if (m > 0) {
    return `${m}分${s}秒`
  }
  return `${s}秒`
}

/**
 * 格式化百分比
 * @param value 小数值 (0.5 = 50%)
 * @param decimals 小数位数 (可选，默认智能处理)
 */
export function formatPercentage(value: number, decimals?: number): string {
  const percent = value * 100
  
  // 如果指定了小数位，使用指定的
  if (decimals !== undefined) {
    return `${percent.toFixed(decimals)}%`
  }
  
  // 否则：整数不显示小数，非整数显示1位
  return percent % 1 === 0 ? `${percent}%` : `${percent.toFixed(1)}%`
}

// 保留旧别名以保持向后兼容
export const formatPercent = formatPercentage
