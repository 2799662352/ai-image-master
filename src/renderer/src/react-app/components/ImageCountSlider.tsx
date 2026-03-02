import { useDirectorStore } from '../stores/useDirectorStore'

export function ImageCountSlider() {
  const imageCount = useDirectorStore((s) => s.imageCount)
  const setImageCount = useDirectorStore((s) => s.setImageCount)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-semibold flex items-center">
          <i className="fas fa-copy text-yellow-400 mr-2" />
          生成数量（抽卡张数）
        </h3>
        <span className="text-green-300 font-bold text-xl">{imageCount}张</span>
      </div>

      <input
        type="range"
        min={1}
        max={10}
        value={imageCount}
        onChange={(e) => setImageCount(Number(e.target.value))}
        className="w-full h-2 bg-white bg-opacity-20 rounded-none appearance-none cursor-pointer"
      />

      <div className="flex justify-between mt-2">
        <span className="text-white opacity-50 text-xs">1张</span>
        <span className="text-white opacity-50 text-xs">10张</span>
      </div>

      <p className="text-white opacity-50 text-xs mt-2">
        同一场景生成多张，挑选最佳效果
      </p>
    </div>
  )
}
