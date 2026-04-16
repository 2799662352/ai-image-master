import { useToastStore, type ToastItem } from '../../stores'

const TYPE_STYLES: Record<ToastItem['type'], string> = {
  success: 'bg-green-600/90 border-green-400',
  error: 'bg-red-600/90 border-red-400',
  info: 'bg-blue-600/90 border-blue-400',
  warning: 'bg-yellow-600/90 border-yellow-400',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded-lg border text-white text-sm shadow-lg
            animate-[slideIn_0.2s_ease-out] ${TYPE_STYLES[toast.type]}`}
        >
          <div className="flex items-center justify-between gap-2">
            <span>{toast.message}</span>
            <button
              className="text-white/70 hover:text-white text-lg leading-none"
              onClick={() => removeToast(toast.id)}
            >
              &times;
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
