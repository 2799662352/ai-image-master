// src/renderer/src/utils/toast.ts
/**
 * Toast 通知工具
 */

export type ToastType = 'success' | 'error' | 'info' | 'warning'

const icons: Record<ToastType, string> = {
  success: '<i class="fas fa-check-circle text-green-500 text-xl"></i>',
  error: '<i class="fas fa-exclamation-circle text-red-500 text-xl"></i>',
  info: '<i class="fas fa-info-circle text-blue-500 text-xl"></i>',
  warning: '<i class="fas fa-exclamation-triangle text-yellow-500 text-xl"></i>'
}

/**
 * 显示 Toast 通知
 */
export function showToast(message: string, type: ToastType = 'info', duration = 3000): void {
  const toast = document.getElementById('toast')
  const toastIcon = document.getElementById('toastIcon')
  const toastMessage = document.getElementById('toastMessage')

  if (!toast || !toastIcon || !toastMessage) {
    console.warn('Toast 元素未找到，使用 console 输出:', message)
    console.log(`[${type.toUpperCase()}] ${message}`)
    return
  }

  toastIcon.innerHTML = icons[type] || icons.info
  toastMessage.textContent = message

  toast.classList.remove('hidden')

  setTimeout(() => {
    toast.classList.add('hidden')
  }, duration)
}

/**
 * 创建自定义 Toast 元素（如果 DOM 中不存在）
 */
export function ensureToastElement(): void {
  if (document.getElementById('toast')) return

  const toast = document.createElement('div')
  toast.id = 'toast'
  toast.className = 'fixed bottom-4 right-4 z-[70000] hidden transition-all duration-300'
  toast.innerHTML = `
    <div class="flex items-center gap-3 bg-white rounded-lg shadow-xl px-4 py-3 border border-gray-200">
      <div id="toastIcon"></div>
      <span id="toastMessage" class="text-gray-800"></span>
    </div>
  `
  document.body.appendChild(toast)
}

/**
 * 成功提示
 */
export function toastSuccess(message: string): void {
  showToast(message, 'success')
}

/**
 * 错误提示
 */
export function toastError(message: string): void {
  showToast(message, 'error')
}

/**
 * 信息提示
 */
export function toastInfo(message: string): void {
  showToast(message, 'info')
}

/**
 * 警告提示
 */
export function toastWarning(message: string): void {
  showToast(message, 'warning')
}
