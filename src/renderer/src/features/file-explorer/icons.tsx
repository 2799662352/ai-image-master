const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none',
}

export const FileTreeIcon = (p: { className?: string }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M3 5h7l2 2h9v11a2 2 0 0 1-2 2H3z" />
    <path d="M8 12h8M8 16h5" />
  </svg>
)

export const FolderIcon = (p: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H3z" />
  </svg>
)

export const FolderOpenIcon = (p: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M3 6h6l2 2h10" />
    <path d="M3 8h17l-2 10a2 2 0 0 1-2 2H3z" />
  </svg>
)

export const FileIcon = (p: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <path d="M14 3v6h6" />
  </svg>
)

export const ImageFileIcon = (p: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="11" r="1.5" />
    <path d="M3 17l5-4 5 4 4-3 4 3" />
  </svg>
)

export const ChevronRightIcon = (p: { className?: string }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M9 6l6 6-6 6" />
  </svg>
)

export const ChevronLeftIcon = (p: { className?: string }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M15 6l-6 6 6 6" />
  </svg>
)

export const CloseIcon = (p: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} className={p.className}>
    <path d="M6 6l12 12M6 18L18 6" />
  </svg>
)

export const DotIcon = (p: { className?: string }) => (
  <svg width="8" height="8" viewBox="0 0 8 8" className={p.className}>
    <circle cx="4" cy="4" r="3" fill="currentColor" />
  </svg>
)
