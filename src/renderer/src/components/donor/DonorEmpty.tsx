export default function DonorEmpty({ hasFilter }: { hasFilter: boolean }) {
  return (
    <div className="d-neon-frame--soft d-clip-tag mt-6 py-10 md:py-12 px-6 text-center">
      <div className="d-mono text-[60px] text-[color:var(--donor-magenta)] leading-none d-glitch">∅</div>
      <div className="mt-4 d-chromatic font-bold text-[28px]" data-text={hasFilter ? 'NO_MATCH' : 'EMPTY_BUFFER'}>
        {hasFilter ? 'NO_MATCH' : 'EMPTY_BUFFER'}
      </div>
      <p className="mt-3 d-mono text-[12px] text-[color:var(--donor-ink-dim)] tracking-widest">
        {hasFilter
          ? '// 検索条件に一致なし / adjust filters and retry'
          : '// まだ履歴はない / generate images to fill the archive'}
      </p>
      <div className="mt-4 d-mono text-[10px] text-[color:var(--donor-cyan)] opacity-70">
        [ waiting_for_input <span className="d-caret" /> ]
      </div>
    </div>
  )
}
