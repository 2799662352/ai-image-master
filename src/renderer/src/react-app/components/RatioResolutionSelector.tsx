import { useDirectorStore } from '../stores/useDirectorStore'

const RATIO_OPTIONS = [
  { value: 'auto', label: '自动' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
  { value: '3:4', label: '3:4' },
  { value: '3:2', label: '3:2' },
  { value: '2:3', label: '2:3' },
  { value: '21:9', label: '21:9' },
  { value: '5:4', label: '5:4' },
  { value: '4:5', label: '4:5' },
]

const RESOLUTION_OPTIONS = [
  { value: 'SD', label: '标清 SD' },
  { value: 'HD', label: '高清 HD' },
  { value: '2K', label: '2K 高清' },
  { value: '4K', label: '4K 超清' },
]

const selectClass =
  'w-full px-3 py-2 bg-white bg-opacity-90 border border-white border-opacity-30 rounded-none text-gray-800 font-medium focus:outline-none focus:ring-2 focus:ring-purple-400'

export default function RatioResolutionSelector() {
  const currentRatio = useDirectorStore((s) => s.currentRatio)
  const setRatio = useDirectorStore((s) => s.setRatio)
  const currentResolution = useDirectorStore((s) => s.currentResolution)
  const setResolution = useDirectorStore((s) => s.setResolution)

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="bg-[#27272A] rounded-none p-4">
        <h3 className="text-white font-semibold flex items-center mb-3">
          <i className="fas fa-crop-alt text-yellow-400 mr-2" />
          图片尺寸
        </h3>
        <select
          value={currentRatio}
          onChange={(e) => setRatio(e.target.value)}
          className={selectClass}
        >
          {RATIO_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="bg-[#27272A] rounded-none p-4">
        <h3 className="text-white font-semibold flex items-center mb-3">
          <i className="fas fa-expand-arrows-alt text-yellow-400 mr-2" />
          清晰度
        </h3>
        <select
          value={currentResolution}
          onChange={(e) => setResolution(e.target.value)}
          className={selectClass}
        >
          {RESOLUTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
