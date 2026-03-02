import { useDirectorStore } from '../stores/useDirectorStore'

export function SceneInput() {
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const setSceneDescription = useDirectorStore((s) => s.setSceneDescription)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-pen-fancy mr-2 text-purple-400" />
        场景描述
      </h3>
      <textarea
        value={sceneDescription}
        onChange={(e) => setSceneDescription(e.target.value)}
        placeholder="描述你想要的漫画场景…（可选）"
        rows={4}
        className="w-full bg-[#09090B] border border-[#3F3F46] rounded-none px-3 py-2 text-sm text-white placeholder-white placeholder-opacity-30 resize-none focus:outline-none focus:border-purple-400 transition-colors"
      />
    </div>
  )
}
