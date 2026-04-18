import type { ApiSite } from '../../services/api/ApiService'

interface SiteGridProps {
  sites: Record<string, ApiSite>
  activeSiteKey: string
  onSelect: (key: string) => void
}

export function SiteGrid({ sites, activeSiteKey, onSelect }: SiteGridProps) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {Object.entries(sites).map(([key, site]) => {
        const isActive = key === activeSiteKey
        return (
          <button
            key={key}
            onClick={() => onSelect(key)}
            className={`p-3 border-2 rounded text-left transition-all text-sm ${
              isActive
                ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
                : 'border-zinc-700 bg-zinc-900 text-gray-400 hover:border-zinc-500'
            }`}
          >
            <div className="font-semibold truncate">{site.name}</div>
            {site.description && (
              <div className="text-xs mt-1 opacity-70 truncate">{site.description}</div>
            )}
          </button>
        )
      })}
    </div>
  )
}
