import { useCallback, useState } from 'react'
import type React from 'react'

import { useMcpStore } from './useMcpStore'

interface ParsedServer {
  name: string
  config: Record<string, unknown>
}

interface ParseResult {
  ok: boolean
  servers?: ParsedServer[]
  error?: string
}

export function parseMcpImportJson(raw: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'JSON 解析失败，请检查格式' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '输入必须是一个 JSON 对象' }
  }

  const obj = parsed as Record<string, unknown>

  // Detect Cursor format: has a `mcpServers` key containing the server map
  const serverMap: Record<string, unknown> =
    obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, unknown>)
      : obj

  const servers: ParsedServer[] = []
  for (const [name, value] of Object.entries(serverMap)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>

    const config: Record<string, unknown> = {}
    if (typeof entry.command === 'string') config.command = entry.command
    if (Array.isArray(entry.args)) config.args = entry.args
    if (typeof entry.url === 'string') config.url = entry.url
    if (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
      config.env = entry.env
    }
    if (typeof entry.enabled === 'boolean') config.enabled = entry.enabled
    if (Array.isArray(entry.disabled_tools)) config.disabled_tools = entry.disabled_tools

    servers.push({ name, config })
  }

  if (servers.length === 0) {
    return { ok: false, error: '未找到有效的 MCP 服务器配置' }
  }

  return { ok: true, servers }
}

interface BulkImportModalProps {
  onClose: () => void
}

export function BulkImportModal({ onClose }: BulkImportModalProps): React.JSX.Element {
  const [step, setStep] = useState<'paste' | 'preview'>('paste')
  const [rawJson, setRawJson] = useState('')
  const [parseError, setParseError] = useState<string | null>(null)
  const [servers, setServers] = useState<ParsedServer[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fetchServers = useMcpStore((s) => s.fetchServers)

  const handleParse = useCallback(() => {
    const result = parseMcpImportJson(rawJson)
    if (!result.ok) {
      setParseError(result.error ?? '解析失败')
      return
    }
    setParseError(null)
    setServers(result.servers!)
    setSelected(new Set(result.servers!.map((s) => s.name)))
    setStep('preview')
  }, [rawJson])

  const handleImport = useCallback(async () => {
    const api = (window as any).electronAPI?.agent
    if (!api?.batchWriteConfig) return

    setImporting(true)
    setImportError(null)
    try {
      const edits = servers
        .filter((s) => selected.has(s.name))
        .map((s) => ({ keyPath: `mcp_servers.${s.name}`, value: s.config }))

      if (edits.length === 0) {
        setImportError('请至少选择一个服务器')
        setImporting(false)
        return
      }

      const res = await api.batchWriteConfig(edits, true)
      if (res && !res.ok) throw new Error(res.error ?? '导入失败')

      await fetchServers()
      onClose()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }, [servers, selected, fetchServers, onClose])

  const toggleSelect = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-700 bg-zinc-900/80 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">
          {step === 'paste' ? '批量导入 MCP 服务器' : `预览 (${selected.size}/${servers.length} 已选)`}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          取消
        </button>
      </div>

      {step === 'paste' && (
        <>
          <p className="text-xs text-zinc-500">
            粘贴 Cursor 的 mcp.json 内容或 Codex 格式的 JSON 配置。支持自动识别格式。
          </p>
          <textarea
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            placeholder={'{\n  "mcpServers": {\n    "server-name": {\n      "command": "npx",\n      "args": ["-y", "package-name"]\n    }\n  }\n}'}
            className="h-[200px] w-full resize-none rounded border border-zinc-700 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 placeholder:text-zinc-700 focus:border-cyan-600/50 focus:outline-none"
          />
          {parseError && (
            <p className="text-xs text-red-400">{parseError}</p>
          )}
          <button
            type="button"
            onClick={handleParse}
            disabled={!rawJson.trim()}
            className="self-end rounded-md bg-cyan-600/80 px-4 py-1.5 text-xs text-white hover:bg-cyan-600 disabled:opacity-40"
          >
            解析并预览
          </button>
        </>
      )}

      {step === 'preview' && (
        <>
          <div className="max-h-[300px] overflow-y-auto">
            {servers.map((s) => (
              <label
                key={s.name}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-zinc-800/60"
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.name)}
                  onChange={() => toggleSelect(s.name)}
                  className="accent-cyan-500"
                />
                <span className="flex-1 text-sm text-zinc-200">{s.name}</span>
                <span className="text-[11px] text-zinc-500">
                  {s.config.url ? 'HTTP' : (s.config.command as string) ?? ''}
                </span>
              </label>
            ))}
          </div>
          {importError && (
            <p className="text-xs text-red-400">{importError}</p>
          )}
          <div className="flex items-center gap-2 self-end">
            <button
              type="button"
              onClick={() => setStep('paste')}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200"
            >
              返回
            </button>
            <button
              type="button"
              onClick={handleImport}
              disabled={importing || selected.size === 0}
              className="rounded-md bg-cyan-600/80 px-4 py-1.5 text-xs text-white hover:bg-cyan-600 disabled:opacity-40"
            >
              {importing ? '导入中...' : `导入 ${selected.size} 个服务器`}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
