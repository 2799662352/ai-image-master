import type { CredentialState } from '../../../../types/storyboardSplit'

type GridCols = 2 | 3 | 4 | 6
const GRID_OPTIONS: GridCols[] = [2, 3, 4, 6]

const CRED_SOURCE_LABEL: Record<string, string> = {
  env: 'ENV',
  store: 'USER',
  builtin: 'BUILTIN',
  none: 'NONE',
}

interface Props {
  credentialState: CredentialState | null
  gridCols: GridCols
  historyCount: number
  onGridColsChange: (n: GridCols) => void
  onToggleHistory: () => void
}

export default function SplitHeader({ credentialState, gridCols, historyCount, onGridColsChange, onToggleHistory }: Props) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
      <div className="flex items-center gap-3">
        <h1 className="d-mono text-lg text-[color:var(--donor-magenta)] tracking-widest uppercase">
          宫格拆图 <span className="text-[color:var(--donor-cyan)]">/ GRID.SPLIT</span>
        </h1>
        {credentialState && (
          <span className={`d-status-tag ${credentialState.hasCredentials ? 'd-status-tag--ok' : 'd-status-tag--fail'}`}>
            <span>{credentialState.hasCredentials ? '◆' : '✕'}</span>
            <span>{CRED_SOURCE_LABEL[credentialState.credentialSource] || 'N/A'}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <div className="flex d-mono text-[11px]">
          {GRID_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onGridColsChange(n)}
              className={`px-2 py-1 border border-[color:var(--donor-magenta-dim)] transition-colors ${n === gridCols ? 'bg-[color:var(--donor-cyan)] text-[color:var(--donor-bg-0)]' : 'text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-cyan)]'}`}
            >
              {n}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onToggleHistory}
          className="d-hover-invert-cyan px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
        >
          [ HISTORY ({historyCount}) ]
        </button>
      </div>
    </div>
  )
}
