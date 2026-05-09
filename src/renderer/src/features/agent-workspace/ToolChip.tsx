import { useCallback, useState } from 'react'
import type React from 'react'

import { useMcpStore } from './useMcpStore'

interface ToolChipProps {
  serverName: string
  toolName: string
  description?: string
  disabled?: boolean
}

export function ToolChip({ serverName, toolName, description, disabled }: ToolChipProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const disableTool = useMcpStore((s) => s.disableTool)
  const enableTool = useMcpStore((s) => s.enableTool)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
    setMenuOpen(true)
  }, [])

  const handleToggle = useCallback(async () => {
    setMenuOpen(false)
    if (disabled) {
      await enableTool(serverName, toolName)
    } else {
      await disableTool(serverName, toolName)
    }
  }, [disabled, serverName, toolName, disableTool, enableTool])

  return (
    <>
      <span
        onContextMenu={handleContextMenu}
        title={description ?? toolName}
        className={
          'inline-flex cursor-context-menu items-center rounded-full px-2 py-0.5 text-xs transition-colors ' +
          (disabled
            ? 'bg-zinc-800/40 text-zinc-500 line-through'
            : 'bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20')
        }
      >
        {toolName}
      </span>

      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div
            className="fixed z-50 min-w-[140px] rounded-md border border-zinc-700 bg-zinc-900 py-1 shadow-xl"
            style={{ left: menuPos.x, top: menuPos.y }}
          >
            <button
              type="button"
              onClick={handleToggle}
              className="w-full cursor-pointer px-3 py-1.5 text-left text-xs text-zinc-200 hover:bg-zinc-800"
            >
              {disabled ? '启用此工具' : '禁用此工具'}
            </button>
          </div>
        </>
      )}
    </>
  )
}
