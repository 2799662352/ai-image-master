import { useState, useEffect, useRef } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

interface VisionModelConfig {
  id: string
  shortName: string
  icon: string
  description: string
  features: string[]
  price: string
  recommended: boolean
}

interface VisionModelsData {
  models: VisionModelConfig[]
  defaultModel: string
}

export function VisionModelSelector() {
  const visionModel = useDirectorStore((s) => s.visionModel)
  const setVisionModel = useDirectorStore((s) => s.setVisionModel)
  const [open, setOpen] = useState(false)
  const [modelsData, setModelsData] = useState<VisionModelsData | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('data/vision-models.json?v=' + Date.now())
      .then((r) => r.json())
      .then((data: VisionModelsData) => {
        setModelsData(data)
        if (!useDirectorStore.getState().visionModel) {
          setVisionModel(data.defaultModel)
        }
      })
      .catch(() => {})
  }, [setVisionModel])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open])

  const currentModel = modelsData?.models.find((m) => m.id === visionModel)
  const label = currentModel ? `${currentModel.icon} ${currentModel.shortName}` : '选择模型'

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="bg-purple-500 hover:bg-purple-600 text-white px-3 py-1.5 rounded-none text-sm flex items-center gap-1.5 transition-colors"
      >
        <span>{label}</span>
        <i className="fas fa-chevron-down text-[10px] opacity-70" />
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false)
          }}
        >
          <div ref={panelRef} className="bg-[#27272A] rounded-none p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-white font-semibold text-lg">选择视觉模型</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-white opacity-50 hover:opacity-100 transition-opacity"
              >
                <i className="fas fa-times" />
              </button>
            </div>

            <div className="space-y-3">
              {modelsData?.models.map((model) => {
                const selected = model.id === visionModel
                return (
                  <div
                    key={model.id}
                    onClick={() => {
                      setVisionModel(model.id)
                      setOpen(false)
                    }}
                    className={`bg-[#09090B] border rounded-none p-4 cursor-pointer hover:bg-white hover:bg-opacity-5 transition-all ${
                      selected ? 'border-blue-500 bg-blue-500 bg-opacity-10' : 'border-[#3F3F46]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <span className="text-2xl leading-none mt-0.5">{model.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-white font-medium">{model.shortName}</span>
                          {model.recommended && (
                            <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-none">
                              推荐
                            </span>
                          )}
                          {selected && (
                            <i className="fas fa-check text-blue-400 text-xs ml-auto" />
                          )}
                        </div>
                        <p className="text-white opacity-50 text-sm mb-2">{model.description}</p>
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          {model.features.map((f) => (
                            <span
                              key={f}
                              className="text-[11px] bg-white/5 text-white/60 px-2 py-0.5 rounded-none"
                            >
                              {f}
                            </span>
                          ))}
                        </div>
                        <p className="text-white opacity-30 text-xs">{model.price}</p>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
