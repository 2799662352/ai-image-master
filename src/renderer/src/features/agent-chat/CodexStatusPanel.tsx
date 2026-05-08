import type { CodexSessionStatus } from '../../../../types/agent'

export function CodexStatusPanel({ status }: { status?: CodexSessionStatus }) {
  if (!status) {
    return <div className="text-[11px] text-zinc-500">Codex status unavailable</div>
  }

  const unsafe = status.sandboxMode === 'danger-full-access' || status.approvalPolicy === 'never'

  return (
    <div
      className={[
        'rounded-lg border px-2 py-1.5 text-[11px]',
        unsafe
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-100'
          : 'border-cyan-500/25 bg-cyan-500/10 text-cyan-100',
      ].join(' ')}
    >
      <div className="font-medium">Codex {status.model}</div>
      <div className="mt-0.5 opacity-80">
        {status.sandboxMode} · {status.approvalPolicy} · search {status.webSearch}
      </div>
      {status.writableRoots.length > 0 ? (
        <div className="mt-0.5 truncate opacity-60">{status.writableRoots.length} root(s)</div>
      ) : null}
    </div>
  )
}
