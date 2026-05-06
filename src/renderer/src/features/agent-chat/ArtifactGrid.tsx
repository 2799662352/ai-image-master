import type { AgentArtifact } from '../../../../types/agent'

type ArtifactGridProps = {
  artifacts: AgentArtifact[]
  onError?: (message: string) => void
}

const SAFE_IMAGE_URI_PATTERN = /^(https?:\/\/|file:\/\/\/|blob:|data:image\/(?:png|jpeg|jpg|webp|gif);base64,)/i

export function ArtifactGrid({ artifacts, onError }: ArtifactGridProps) {
  const images = artifacts.filter((item) => item.type === 'image')
  if (images.length === 0) return null

  const open = async (artifact: AgentArtifact) => {
    const urls = images.map((item) => item.uri)
    if (!urls.every((uri) => SAFE_IMAGE_URI_PATTERN.test(uri))) {
      onError?.('Blocked unsafe artifact URI.')
      return
    }

    const index = images.findIndex((item) => item.id === artifact.id)
    const { ServiceRegistry, SERVICE_KEYS } = await import('../../services/ServiceBridge')
    const viewer = ServiceRegistry.get<{ open: (urls: string[], startIndex: number) => void }>(SERVICE_KEYS.IMAGE_VIEWER)
    if (!viewer) {
      onError?.('Image viewer is not ready yet.')
      return
    }
    viewer.open(urls, index)
  }

  return (
    <div className="mt-3 grid grid-cols-3 gap-2">
      {images.map((artifact) => (
        <button
          key={artifact.id}
          className="group overflow-hidden rounded-xl border border-cyan-400/25 bg-black/30 focus:outline-none focus:ring-2 focus:ring-cyan-300"
          onDoubleClick={() => void open(artifact)}
          title="Double-click to preview"
          type="button"
        >
          <img
            alt="Agent artifact"
            className="h-24 w-full object-cover opacity-90 transition group-hover:scale-105 group-hover:opacity-100"
            src={artifact.uri}
          />
        </button>
      ))}
    </div>
  )
}
