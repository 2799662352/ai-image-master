import { useState } from 'react'
import type React from 'react'

import { McpJsonEditor } from './McpJsonEditor'
import { McpServerList } from './McpServerList'

export function McpSection(): React.JSX.Element {
  const [editorTarget, setEditorTarget] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4">
      <McpServerList
        onOpenEditor={(name) => setEditorTarget(name ?? '__new__')}
        onOpenImport={() => setImportOpen(true)}
      />

      {editorTarget && (
        <McpJsonEditor
          serverName={editorTarget}
          onClose={() => setEditorTarget(null)}
        />
      )}

      {importOpen && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/80 p-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-zinc-300">批量导入</span>
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              关闭
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">BulkImportModal 将在 Task 8 中实现。</p>
        </div>
      )}
    </div>
  )
}
