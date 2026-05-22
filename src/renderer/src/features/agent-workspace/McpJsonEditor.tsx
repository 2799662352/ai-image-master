import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import { registerSingleton } from 'monaco-editor/esm/vs/platform/instantiation/common/extensions'
import { IProductService } from 'monaco-editor/esm/vs/platform/product/common/productService'

self.MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new jsonWorker()
    return new editorWorker()
  },
}

// ---------------------------------------------------------------------------
// Monaco standalone (0.55.1) registers ~24 services but NOT IProductService,
// so the built-in clipboard paste implementation
// (monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js:238)
// throws `unknown service 'productService'` at every Ctrl+V — Monaco catches
// it and downgrades to console.warn, but the noise is constant and confusing.
//
// We register a minimal stub. The only field the paste path reads is
// `productService.quality !== 'stable'` to gate a telemetry call (clipboard.js
// line 257). With `quality = 'stable'`, the branch short-circuits and no
// downstream method is invoked, so the empty stub is sufficient.
//
// Side effect runs once at module-load (before any <Editor> mounts). Vite HMR
// may re-execute this module; double-registration is harmless because the
// last entry in Monaco's singleton registry wins.
// ---------------------------------------------------------------------------
class MonacoProductServiceStub {
  quality = 'stable'
}
registerSingleton(IProductService, MonacoProductServiceStub, 0)

loader.config({ monaco })

import { mcpConfigSchema } from './mcpSchemaJson'
import { stripNullDeep } from './mcpConfigSanitizer'
import { useMcpStore } from './useMcpStore'

interface McpJsonEditorProps {
  serverName?: string | null
  onClose: () => void
}

function getApi() {
  return (window as any).electronAPI?.agent
}

export function McpJsonEditor({ serverName, onClose }: McpJsonEditorProps): React.JSX.Element {
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const editorRef = useRef<any>(null)
  const fetchServers = useMcpStore((s) => s.fetchServers)

  useEffect(() => {
    async function loadConfig() {
      const api = getApi()
      if (!api?.readConfig) {
        setLoadError('MCP API 不可用')
        return
      }
      try {
        const res = await api.readConfig()
        if (!res.ok) {
          setLoadError(res.error ?? '读取配置失败')
          return
        }
        const mcpServers = (res.config as any)?.mcp_servers ?? {}
        if (serverName && serverName !== '__new__') {
          const serverConfig = mcpServers[serverName]
          setValue(JSON.stringify(serverConfig ? { [serverName]: serverConfig } : { [serverName]: {} }, null, 2))
        } else {
          setValue(JSON.stringify(mcpServers, null, 2))
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err))
      }
    }
    loadConfig()
  }, [serverName])

  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    editorRef.current = editor

    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: [
        {
          uri: 'https://codex.internal/mcp-config-schema.json',
          fileMatch: ['*'],
          schema: mcpConfigSchema,
        },
      ],
    })
  }, [])

  const handleSave = useCallback(async () => {
    setError(null)
    setSaving(true)
    try {
      const parsed = JSON.parse(value)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('配置必须是一个 JSON 对象')
      }

      const api = getApi()
      if (!api?.batchWriteConfig) throw new Error('MCP API 不可用')

      const edits = Object.entries(parsed).map(([name, config]) => ({
        keyPath: `mcp_servers.${name}`,
        value: stripNullDeep(config),
        mergeStrategy: 'replace',
      }))

      const res = await api.batchWriteConfig(edits, true)
      if (res && !res.ok) {
        throw new Error(res.error ?? '保存失败')
      }

      await fetchServers()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [value, fetchServers, onClose])

  if (loadError) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4">
        <p className="text-sm text-red-300">{loadError}</p>
        <button type="button" onClick={onClose} className="mt-2 text-xs text-zinc-400 hover:text-zinc-200">
          关闭
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-700 bg-zinc-900/80 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">
          {serverName && serverName !== '__new__' ? `编辑: ${serverName}` : 'MCP 服务器配置 (JSON)'}
        </h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md bg-cyan-600/80 px-3 py-1.5 text-xs text-white hover:bg-cyan-600 disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
          >
            取消
          </button>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <p className="rounded bg-red-500/10 px-3 py-1.5 text-xs text-red-300">{error}</p>
      )}

      {/* Monaco Editor */}
      <div className="h-[400px] overflow-hidden rounded border border-zinc-800">
        <Editor
          height="100%"
          language="json"
          theme="vs-dark"
          value={value}
          onChange={(v) => setValue(v ?? '')}
          onMount={handleEditorMount}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            formatOnPaste: true,
            automaticLayout: true,
          }}
        />
      </div>

      {/* Hint */}
      <p className="text-[11px] text-zinc-600">
        格式: {'{ "server-name": { "command": "...", "args": [...] } }'} 或 {'{ "server-name": { "url": "https://..." } }'}
      </p>
    </div>
  )
}
