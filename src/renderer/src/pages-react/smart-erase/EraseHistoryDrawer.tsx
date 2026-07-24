import { useEffect } from 'react'
import { useEraseSessionStore } from '../../stores/useEraseSessionStore'
import { useErasePersistStore } from '../../stores/useErasePersistStore'
import type { EraseHistoryItem } from '../../../../types/smartErase'

const api = (window as any).electronAPI

/**
 * Right-side drawer showing recent processed videos. Critical: gates rendering
 * on `_hasHydrated` to avoid showing the empty default before idb-keyval
 * finishes loading the persisted state.
 *
 * Visual language: 「ドーナドーナ」neon cyberpunk — magenta×cyan double-layer
 * border, scanlines + grain (provided by `.donor-theme`), chromatic title,
 * blinking ▶ arrow on selection, sticker-style status tags with clip-path.
 */
export function EraseHistoryDrawer() {
  const open = useErasePersistStore((s) => s.drawer.open)
  const toggle = useErasePersistStore((s) => s.toggleHistoryDrawer)
  const hydrated = useErasePersistStore((s) => s._hasHydrated)
  const history = useErasePersistStore((s) => s.history)
  const clearHistory = useErasePersistStore((s) => s.clearHistory)
  const removeHistory = useErasePersistStore((s) => s.removeHistory)

  const selectedId = useEraseSessionStore((s) => s.selectedHistoryId)
  const setModalItemId = useEraseSessionStore((s) => s.setModalItemId)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, toggle])

  // I1 fix: best-effort remote cleanup whenever the user removes a history
  // entry, so storage doesn't leak before the autoCleanupRemoteAfterDays
  // sweeper catches up. Mirrors storyboard-split's handleDelete pattern.
  const removeWithRemote = (item: EraseHistoryItem) => {
    const cosKeys = [item.outputCosKey, item.inputCosKey].filter(Boolean) as string[]
    if (cosKeys.length > 0) {
      api?.smartEraseDeleteRemote?.(cosKeys)?.catch((err: unknown) => {
        console.warn('[smart-erase] remote delete failed:', err)
      })
    }
    removeHistory(item.id)
  }

  const clearAllWithRemote = () => {
    const allKeys = history
      .flatMap((h) => [h.outputCosKey, h.inputCosKey])
      .filter(Boolean) as string[]
    if (allKeys.length > 0) {
      api?.smartEraseDeleteRemote?.(allKeys)?.catch((err: unknown) => {
        console.warn('[smart-erase] remote delete failed:', err)
      })
    }
    clearHistory()
  }

  const countLabel = hydrated ? String(history.length).padStart(3, '0') : '...'

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-label={open ? '关闭历史抽屉' : '打开历史抽屉'}
        className="d-mono text-[10px] tracking-[0.2em] uppercase px-3 py-1.5 d-hover-invert-cyan"
      >
        [ {open ? '× CLOSE' : `履歴 ${countLabel}`} ]
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 bg-black/75 z-40"
            style={{ backdropFilter: 'blur(2px)' }}
            onClick={toggle}
            aria-hidden="true"
          />
          <aside
            role="complementary"
            aria-label="智能去字幕历史"
            className="donor-theme fixed inset-y-0 right-0 w-[380px] z-50 flex flex-col bg-[color:var(--donor-bg-0)]"
            style={{
              borderLeft: '2px solid var(--donor-magenta)',
              boxShadow:
                '-1px 0 0 0 var(--donor-cyan), -16px 0 32px -8px rgba(255, 45, 122, 0.4), -36px 0 64px -16px rgba(0, 229, 255, 0.28)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <DrawerHeader onClose={toggle} count={countLabel} />

            <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-2 d-mono">
              {!hydrated ? (
                <EmptyPanel text="LOADING" sub="// データ読込中…" scan />
              ) : history.length === 0 ? (
                <EmptyPanel text="NO_RECORDS" sub="// 履歴なし · 暂无字幕清除记录" />
              ) : (
                <ul className="space-y-2">
                  {history.map((h) => (
                    <HistoryRow
                      key={h.id}
                      item={h}
                      selected={h.id === selectedId}
                      onSelect={() => {
                        setModalItemId(h.id)
                        toggle()
                      }}
                      onRemove={(item) => removeWithRemote(item)}
                    />
                  ))}
                </ul>
              )}
            </div>

            <DrawerFooter
              count={countLabel}
              canPurge={hydrated && history.length > 0}
              onPurge={() => {
                if (window.confirm('確認清空全部历史? (同时尝试删除云端文件)')) {
                  clearAllWithRemote()
                }
              }}
            />
          </aside>
        </>
      )}
    </>
  )
}

/* ============================================================================
 * Header — chromatic title + REC ● indicator + close button
 * ==========================================================================*/
function DrawerHeader({ onClose, count }: { onClose: () => void; count: string }) {
  return (
    <header className="flex items-center justify-between gap-3 px-4 pt-3.5 pb-2.5 border-b border-[color:var(--donor-magenta-dim)]">
      <div className="flex flex-col leading-tight">
        <h3
          className="d-mono d-chromatic text-[14px] tracking-[0.22em] uppercase font-bold"
          data-text="ARCHIVE"
        >
          ARCHIVE
        </h3>
        <span className="d-mono text-[9px] text-[color:var(--donor-ink-mute)] tracking-[0.28em] mt-0.5">
          // 履歴 _ ERASE.0x{count}
        </span>
      </div>
      <div className="flex items-center gap-2.5 flex-shrink-0">
        <span className="d-mono text-[9px] tracking-[0.2em] text-[color:var(--donor-red)] inline-flex items-center gap-1.5 uppercase">
          <span
            className="w-1.5 h-1.5 rounded-full bg-[color:var(--donor-red)]"
            style={{
              boxShadow: '0 0 6px var(--donor-red), 0 0 12px rgba(255, 45, 74, 0.6)',
              animation: 'd-pulse 1.2s ease-in-out infinite',
            }}
            aria-hidden="true"
          />
          REC
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭历史"
          className="d-hover-invert px-2 py-0.5 d-mono text-[10px] tracking-[0.2em]"
        >
          [×]
        </button>
      </div>
    </header>
  )
}

/* ============================================================================
 * Footer — HUD digit count + purge action
 * ==========================================================================*/
function DrawerFooter({
  count,
  canPurge,
  onPurge,
}: {
  count: string
  canPurge: boolean
  onPurge: () => void
}) {
  return (
    <footer className="flex items-center justify-between gap-2 px-4 py-2.5 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px]">
      <span className="text-[color:var(--donor-ink-mute)] tracking-[0.18em]">
        // SMART_ERASE.archive
      </span>
      <div className="flex items-center gap-2">
        <span className="d-hud-digit text-[11px]">[ {count} ]</span>
        {canPurge && (
          <button
            type="button"
            onClick={onPurge}
            className="d-mono text-[9px] tracking-[0.2em] uppercase px-2 py-0.5 text-[color:var(--donor-red)] border border-[color:var(--donor-red)]/40 hover:bg-[color:var(--donor-red)] hover:text-[color:var(--donor-bg-0)] transition-colors duration-150"
          >
            PURGE
          </button>
        )}
      </div>
    </footer>
  )
}

/* ============================================================================
 * Empty / loading panel
 * ==========================================================================*/
function EmptyPanel({ text, sub, scan }: { text: string; sub: string; scan?: boolean }) {
  return (
    <div
      className={`d-neon-frame--soft px-4 py-8 text-center space-y-2 ${scan ? 'd-scan-bar' : ''}`}
    >
      <div className="d-mono text-[12px] text-[color:var(--donor-magenta)] tracking-[0.3em]">
        {text}
      </div>
      <div className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] tracking-[0.18em]">
        {sub}
      </div>
    </div>
  )
}

/* ============================================================================
 * History row — selected = full neon frame + ▶ blinking arrow + clip corner
 * ==========================================================================*/
function HistoryRow({
  item,
  selected,
  onSelect,
  onRemove,
}: {
  item: EraseHistoryItem
  selected: boolean
  onSelect: () => void
  onRemove: (item: EraseHistoryItem) => void
}) {
  // videoExpiresAt === 0 ⇒ 结果已转存历史桶(公开读),URL 永不过期。
  const permanent = item.videoExpiresAt === 0
  const expired = item.videoExpiresAt > 0 && item.videoExpiresAt < Date.now()
  const expiryMs = item.videoExpiresAt - Date.now()

  const expiryBadge = permanent
    ? { text: 'PERM', cls: 'd-status-tag--ok' }
    : expired
      ? { text: 'EXP', cls: 'd-status-tag--fail' }
      : expiryMs < 24 * 60 * 60 * 1000
        ? { text: `${Math.ceil(expiryMs / 3_600_000)}H`, cls: 'd-status-tag--pending' }
        : { text: `${Math.ceil(expiryMs / 86_400_000)}D`, cls: 'd-status-tag--ok' }

  return (
    <li
      className={`relative cursor-pointer transition-colors duration-150 ${
        selected
          ? 'd-neon-frame p-2.5'
          : 'p-2.5 border border-[color:var(--donor-ink-mute)]/30 hover:border-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)]/[0.04]'
      }`}
      style={
        selected
          ? {
              clipPath:
                'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
            }
          : undefined
      }
      onClick={onSelect}
    >
      {selected && (
        <span
          aria-hidden="true"
          className="absolute -left-3 top-1/2 -translate-y-1/2 d-mono text-[14px] text-[color:var(--donor-magenta)] leading-none"
          style={{
            textShadow: '0 0 6px var(--donor-magenta), 0 0 12px rgba(255, 45, 122, 0.6)',
            animation: 'd-blink 1.4s steps(2, end) infinite',
          }}
        >
          ▶
        </span>
      )}

      <div className="flex gap-2.5 items-start">
        <Thumbnail item={item} expired={expired} />

        <div className="flex-1 min-w-0 space-y-1">
          <div className="d-mono text-[11px] truncate text-[color:var(--donor-ink)] flex items-center gap-1">
            <span className="truncate">{item.filename}</span>
            {selected && (
              <span
                aria-hidden="true"
                className="d-mono text-[10px] text-[color:var(--donor-cyan)] flex-shrink-0"
                style={{ animation: 'd-blink 1s steps(2, end) infinite' }}
              >
                _
              </span>
            )}
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <span
              className={`d-status-tag ${expiryBadge.cls}`}
              style={{ fontSize: '8px', padding: '1px 6px', letterSpacing: '0.16em' }}
            >
              {expiryBadge.text}
            </span>
            <span className="d-mono text-[9px] text-[color:var(--donor-ink-mute)] tracking-[0.16em] uppercase">
              {formatRel(item.finishedAt ?? item.createdAt)}
            </span>
            {item.mpsTaskId && (
              <span className="d-mono text-[8px] text-[color:var(--donor-cyan)]/70 tracking-[0.18em]">
                #{item.mpsTaskId.slice(-6)}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(item)
          }}
          className="d-mono text-[10px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-red)] flex-shrink-0 self-start px-1 leading-none transition-colors"
          title="移除"
          aria-label={`移除 ${item.filename}`}
        >
          [×]
        </button>
      </div>
    </li>
  )
}

/* ============================================================================
 * Thumbnail with scanline overlay and EXP wash-out treatment
 * ==========================================================================*/
function Thumbnail({ item, expired }: { item: EraseHistoryItem; expired: boolean }) {
  return (
    <div
      className="relative w-[68px] h-[40px] bg-black flex-shrink-0 overflow-hidden"
      style={{
        clipPath: 'polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px)',
        boxShadow: 'inset 0 0 0 1px rgba(0, 229, 255, 0.35)',
      }}
    >
      {item.posterDataUrl ? (
        <img
          src={item.posterDataUrl}
          alt=""
          className={`w-full h-full object-cover transition-all ${expired ? 'opacity-30 grayscale' : ''}`}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <span className="d-mono text-[11px] text-[color:var(--donor-ink-mute)]">▶</span>
        </div>
      )}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'repeating-linear-gradient(to bottom, transparent 0, transparent 2px, rgba(0,0,0,0.22) 3px)',
        }}
      />
      {expired && (
        <span
          className="absolute bottom-0.5 right-0.5 d-mono text-[7px] text-[color:var(--donor-red)] tracking-[0.12em] px-0.5 bg-black/70"
          style={{ animation: 'd-pulse 1.2s ease-in-out infinite' }}
        >
          EXP
        </span>
      )}
    </div>
  )
}

/* ============================================================================
 * Relative time formatter - "JUST NOW" / "5M AGO" / "2H AGO" / "3D AGO"
 * ==========================================================================*/
function formatRel(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 0) return 'NOW'
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'JUST NOW'
  if (min < 60) return `${min}M AGO`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}H AGO`
  const d = Math.floor(h / 24)
  return `${d}D AGO`
}
