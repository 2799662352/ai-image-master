import React from 'react'
import { useMcpStore } from './useMcpStore'

export function AutoFixToast(): React.JSX.Element | null {
  const last = useMcpStore((s) => s.lastAutoFix)
  const dismiss = useMcpStore((s) => s.dismissLastAutoFix)

  if (!last) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9999,
        padding: '12px 20px',
        background: 'rgba(34, 197, 94, 0.12)',
        border: '1px solid rgba(34, 197, 94, 0.4)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 13,
        color: '#86efac',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
      }}
    >
      <span>
        已自动将 {last.count} 个 Docker MCP 转换为 Gateway HTTP 模式（:{last.port}）
      </span>
      <button
        type="button"
        onClick={dismiss}
        style={{
          background: 'none',
          border: 'none',
          color: '#86efac',
          cursor: 'pointer',
          fontSize: 16,
          lineHeight: 1,
          padding: '0 4px',
        }}
      >
        ×
      </button>
    </div>
  )
}
