import { useState } from 'react'
import type React from 'react'

import { BulkImportModal } from './BulkImportModal'
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
        <BulkImportModal onClose={() => setImportOpen(false)} />
      )}
    </div>
  )
}
