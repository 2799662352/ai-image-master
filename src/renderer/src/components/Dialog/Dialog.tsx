import { useDialogStore } from '../../stores'

export function DialogModal() {
  const { isOpen, config, closeDialog, confirm } = useDialogStore()

  if (!isOpen || !config) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-cyberpunk-dark border border-cyberpunk-yellow/30 rounded-xl p-6 max-w-md w-full mx-4 shadow-2xl">
        <h3 className="text-lg font-orbitron text-cyberpunk-yellow mb-2">{config.title}</h3>
        <p className="text-gray-300 text-sm mb-6">{config.message}</p>
        <div className="flex justify-end gap-3">
          {config.type !== 'alert' && (
            <button
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              onClick={closeDialog}
            >
              {config.cancelText ?? 'Cancel'}
            </button>
          )}
          <button
            className="px-4 py-2 text-sm bg-cyberpunk-yellow text-cyberpunk-black rounded-md font-semibold hover:opacity-90 transition-opacity"
            onClick={confirm}
          >
            {config.confirmText ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
