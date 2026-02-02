// src/renderer/src/utils/url-validator.ts
/**
 * URL 验证工具函数
 * 用于统一验证图片 URL 的有效性
 */

/**
 * 检查 URL 是否是有效的图片 URL
 * @param url 待验证的 URL
 * @returns 是否有效
 */
export function isValidImageUrl(url: string | null | undefined): boolean {
  if (!url) return false
  
  // 排除占位符和无效 URL
  if (url.startsWith('pending:')) return false
  if (url.startsWith('electron:')) return false
  if (url.startsWith('[')) return false  // [base64-removed], [local-removed] 等
  
  // 允许的 URL 类型
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:image/') ||
    url.startsWith('blob:')
  )
}

/**
 * 检查 URL 是否是 base64 数据 URL
 * @param url 待验证的 URL
 * @returns 是否是 base64 数据
 */
export function isBase64DataUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return url.startsWith('data:image/')
}

/**
 * 检查 URL 是否是外部 HTTP(S) URL
 * @param url 待验证的 URL
 * @returns 是否是外部 URL
 */
export function isExternalUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return url.startsWith('http://') || url.startsWith('https://')
}

/**
 * 检查 URL 是否是上传中的占位符
 * @param url 待验证的 URL
 * @returns 是否是占位符
 */
export function isPendingUrl(url: string | null | undefined): boolean {
  if (!url) return false
  return url.startsWith('pending:')
}

/**
 * 检查 URL 是否是被移除的占位符
 * @param url 待验证的 URL
 * @returns 是否是被移除的占位符
 */
export function isRemovedPlaceholder(url: string | null | undefined): boolean {
  if (!url) return false
  return url.startsWith('[') && url.endsWith(']')
}

/**
 * 过滤有效的图片 URL
 * @param urls URL 数组
 * @returns 有效的 URL 数组
 */
export function filterValidImageUrls(urls: (string | null | undefined)[]): string[] {
  return urls.filter((url): url is string => isValidImageUrl(url))
}

/**
 * 获取第一个有效的缩略图 URL
 * @param urls URL 数组
 * @returns 第一个有效的 URL 或 null
 */
export function getFirstValidThumbnail(urls: (string | null | undefined)[]): string | null {
  return urls.find((url): url is string => isValidImageUrl(url)) || null
}
