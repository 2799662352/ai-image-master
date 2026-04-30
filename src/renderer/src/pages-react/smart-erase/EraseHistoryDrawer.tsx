import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import type { EraseHistoryItem } from '../../../../types/smartErase'

/**
 * Right-side drawer showing recent processed videos. Critical: gates rendering
 * on `_hasHydrated` to avoid showing the empty default before idb-keyval
 * finishes loading the persisted state.
 */
export function EraseHistoryDrawer() {
  const open = useErasePersistStore((s) => s.drawer.open)
  const toggle = useErasePersistStore((s) => s.toggleHistoryDrawer)
  const hydrated = useErasePersistStore((s) => s._hasHydrated)
  const history = useErasePersistStore((s) => s.history)
  const clearHistory = useErasePersistStore((s) => s.clearHistory)
  const removeHistory = useErasePersistStore((s) => s.removeHistory)

  const selectedId = useEraseSessionStore((s) => s.selectedHistoryId)
  const setSelectedHistoryId = useEraseSessionStore((s) => s.setSelectedHistoryId)

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        className="d-mono text-[10px] tracking-widest px-3 py-1.5 border border-[color:var(--donor-ink-mute)] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-cyan)] hover:border-[color:var(--donor-cyan)]"
      >
        [ {open ? '关闭历史' : '历史'} ({hydrated ? history.length : '…'}) ]
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-40"
          onClick={toggle}
        >
          <aside
            className="absolute top-0 right-0 h-full w-[360px] bg-[color:var(--donor-bg-0)] border-l border-[color:var(--donor-cyan)]/40 shadow-2xl p-4 overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="d-mono text-xs tracking-widest text-[color:var(--donor-cyan)] uppercase">
                历史 / HISTORY
              </h3>
              <button
                type="button"
                onClick={toggle}
                className="d-mono text-xs text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)]"
              >
                [×]
              </button>
            </div>

            {!hydrated ? (
              <div className="d-mono text-[11px] text-[color:var(--donor-ink-mute)] tracking-widest">
                // 加载中…
              </div>
            ) : history.length === 0 ? (
              <div className="d-mono text-[11px] text-[color:var(--donor-ink-mute)] tracking-widest">
                // 暂无历史
              </div>
            ) : (
              <>
                <ul className="space-y-2">
                  {history.map((h) => (
                    <HistoryRow
                      key={h.id}
                      item={h}
                      selected={h.id === selectedId}
                      onSelect={() => {
                        setSelectedHistoryId(h.id)
                        toggle()
                      }}
                      onRemove={(id) => removeHistory(id)}
                    />
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm('确认清空全部历史？(本地数据，不影响云端)')) clearHistory()
                  }}
                  className="d-mono text-[10px] tracking-widest mt-4 px-3 py-1.5 border border-[color:var(--donor-red)]/60 text-[color:var(--donor-red)]/80 hover:bg-[color:var(--donor-red)]/10 w-full"
                >
                  [ 清空全部 ]
                </button>
              </>
            )}
          </aside>
        </div>
      )}
    </>
  )
}

function HistoryRow({
  item,
  selected,
  onSelect,
  onRemove,
}: {
  item: EraseHistoryItem
  selected: boolean
  onSelect: () => void
  onRemove: (id: string) => void
}) {
  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  return (
    <li
      className={`flex items-start gap-2 p-2 cursor-pointer border ${
        selected
          ? 'border-[color:var(--donor-cyan)]'
          : 'border-[color:var(--donor-ink-mute)]/30 hover:border-[color:var(--donor-cyan)]/50'
      }`}
      onClick={onSelect}
    >
      {item.posterDataUrl ? (
        <img
          src={item.posterDataUrl}
          alt=""
          className="w-16 h-9 object-cover bg-black flex-shrink-0"
        />
      ) : (
        <div className="w-16 h-9 bg-black flex items-center justify-center flex-shrink-0">
          <span className="d-mono text-[8px] text-[color:var(--donor-ink-mute)]">
            ▶
          </span>
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="d-mono text-[11px] truncate text-[color:var(--donor-ink)]">
          {item.filename}
        </div>
        <div className="d-mono text-[9px] text-[color:var(--donor-ink-mute)] tracking-widest mt-0.5">
          {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}
          {expired && (
            <span className="ml-2 text-[color:var(--donor-red)]">URL EXP</span>
          )}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove(item.id)
        }}
        className="d-mono text-[9px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)] flex-shrink-0"
        title="移除"
      >
        [×]
      </button>
    </li>
  )
}
