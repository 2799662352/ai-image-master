import { useDirectorStore } from '../stores/useDirectorStore'

export function SceneInput() {
  const sceneDescription = useDirectorStore((s) => s.sceneDescription)
  const setSceneDescription = useDirectorStore((s) => s.setSceneDescription)

  return (
    <div>
      <label className="text-sm font-medium text-zinc-300 mb-2 block">
        <i className="fas fa-pen-fancy mr-2 text-purple-400" />
        场景描述
      </label>
      <textarea
        value={sceneDescription}
        onChange={(e) => setSceneDescription(e.target.value)}
        placeholder="描述你想要的漫画场景…（可选）"
        rows={4}
        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-500 resize-none focus:outline-none focus:border-purple-400 transition-colors"
      />
    </div>
  )
}
