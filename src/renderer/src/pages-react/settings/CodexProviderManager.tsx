import React from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import type {
  CodexCustomProviderInput,
  CodexProvider,
} from '../../stores/useSettingsStore'
import { useToastStore } from '../../stores/useToastStore'
import { ApiKeyInput } from './ApiKeyInput'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Codex provider switcher + custom provider editor.
 *
 * Renders the built-in (apiyi / rightcode) and user-defined provider tiles,
 * plus an "+ Add custom" button that opens a modal mirroring `right.codes`'s
 * config.toml schema. Used inside SettingsPage to replace the old single-key
 * input.
 */
export function CodexProviderManager() {
  const providers = useSettingsStore((s) => s.providers)
  const codexApiKey = useSettingsStore((s) => s.codexApiKey)
  const setCodexApiKey = useSettingsStore((s) => s.setCodexApiKey)
  const selectProvider = useSettingsStore((s) => s.selectProvider)
  const saveProviderKey = useSettingsStore((s) => s.saveProviderKey)
  const addProvider = useSettingsStore((s) => s.addProvider)
  const updateProvider = useSettingsStore((s) => s.updateProvider)
  const removeProvider = useSettingsStore((s) => s.removeProvider)
  const addToast = useToastStore((s) => s.addToast)

  const [editing, setEditing] = React.useState<CodexProvider | null>(null)
  const [showAdd, setShowAdd] = React.useState(false)

  const all: CodexProvider[] = React.useMemo(
    () => [...providers.builtins, ...providers.custom],
    [providers.builtins, providers.custom],
  )

  const active = all.find((p) => p.id === providers.activeId)

  const handleSelect = async (id: string) => {
    if (id === providers.activeId || id === providers.pendingProviderId) return
    try {
      await selectProvider(id)
    } catch (error) {
      addToast({ message: errorMessage(error), type: 'error' })
    }
  }

  const handleSaveKey = async () => {
    if (!active || providers.pendingProviderId !== null) return
    try {
      await saveProviderKey(active.id, codexApiKey)
      addToast({ message: `${active.name} key saved`, type: 'success' })
    } catch (error) {
      addToast({ message: errorMessage(error), type: 'error' })
    }
  }

  const handleAdd = async (input: CodexCustomProviderInput) => {
    const created = await addProvider(input)
    if (!created) {
      addToast({ message: '添加失败（请检查 baseUrl/name 是否合法）', type: 'error' })
      return
    }
    addToast({ message: `已添加 ${created.name}`, type: 'success' })
    setShowAdd(false)
  }

  const handleUpdate = async (id: string, patch: Partial<CodexCustomProviderInput>) => {
    if (providers.pendingProviderId !== null) return
    try {
      await updateProvider(id, patch)
      addToast({ message: '已更新', type: 'success' })
      setEditing(null)
    } catch (error) {
      addToast({ message: errorMessage(error), type: 'error' })
    }
  }

  const handleRemove = async (provider: CodexProvider) => {
    if (!provider.isCustom || providers.pendingProviderId !== null) return
    if (!confirm(`确定删除自定义 provider "${provider.name}"？`)) return
    try {
      await removeProvider(provider.id)
      addToast({ message: `已删除 ${provider.name}`, type: 'success' })
    } catch (error) {
      addToast({ message: errorMessage(error), type: 'error' })
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        {all.map((p) => {
          const isActive = p.id === providers.activeId
          const isPending = p.id === providers.pendingProviderId
          return (
            <div
              key={p.id}
              className={`relative p-3 border-2 rounded text-left transition-all text-sm ${
                isActive
                  ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
                  : 'border-zinc-700 bg-zinc-900 text-gray-400 hover:border-zinc-500'
              }`}
            >
              <button
                onClick={() => handleSelect(p.id)}
                disabled={isPending}
                aria-pressed={isActive}
                className="block w-full text-left disabled:cursor-wait"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="font-semibold truncate">{p.name}</div>
                  {isPending ? (
                    <span className="text-[10px] px-1 py-0.5 bg-zinc-800 text-cyberpunk-yellow rounded">
                      切换中…
                    </span>
                  ) : p.isCustom ? (
                    <span className="text-[10px] px-1 py-0.5 bg-zinc-800 text-zinc-400 rounded uppercase tracking-wider">
                      custom
                    </span>
                  ) : null}
                </div>
                {p.description ? (
                  <div className="text-xs mt-1 opacity-70 truncate">{p.description}</div>
                ) : (
                  <div className="text-xs mt-1 opacity-50 truncate">{p.baseUrl}</div>
                )}
                {p.model && (
                  <div className="text-[11px] mt-1 opacity-60">
                    {p.model}
                    {p.reasoningEffort ? ` · ${p.reasoningEffort}` : ''}
                  </div>
                )}
              </button>
              {p.isCustom && (
                <div className="absolute top-1 right-1 flex gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(p)}
                    disabled={providers.pendingProviderId !== null}
                    aria-disabled={providers.pendingProviderId !== null}
                    className="text-[10px] px-1 py-0.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                    title="编辑"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(p)}
                    disabled={providers.pendingProviderId !== null}
                    aria-disabled={providers.pendingProviderId !== null}
                    className="text-[10px] px-1 py-0.5 bg-red-900/40 hover:bg-red-900 text-red-300 rounded disabled:opacity-50 disabled:cursor-not-allowed"
                    title="删除"
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          )
        })}
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="p-3 border-2 border-dashed border-zinc-700 hover:border-cyberpunk-yellow text-zinc-500 hover:text-cyberpunk-yellow rounded text-sm transition-colors"
        >
          + 添加自定义 Provider
        </button>
      </div>

      {active && (
        <fieldset
          disabled={providers.pendingProviderId !== null}
          className="space-y-2 disabled:opacity-60"
        >
          <div className="text-xs text-zinc-500">
            当前 provider: <span className="text-cyberpunk-yellow">{active.name}</span> · base_url:{' '}
            <code className="text-zinc-400">{active.baseUrl}</code>
          </div>
          <ApiKeyInput
            value={codexApiKey}
            onChange={setCodexApiKey}
            placeholder={`${active.envKey || 'OPENAI_API_KEY'} (sk-...)`}
          />
          <button
            type="button"
            onClick={handleSaveKey}
            className="w-full py-1.5 px-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs uppercase tracking-tight rounded transition-colors"
          >
            💾 保存 {active.name} 的 Key
          </button>
        </fieldset>
      )}

      {showAdd && (
        <ProviderEditModal
          title="添加自定义 Provider"
          initial={null}
          onClose={() => setShowAdd(false)}
          onSubmit={(input) => handleAdd(input)}
        />
      )}

      {editing && (
        <ProviderEditModal
          title={`编辑 ${editing.name}`}
          initial={editing}
          onClose={() => setEditing(null)}
          onSubmit={(input) =>
            handleUpdate(editing.id, {
              name: input.name,
              baseUrl: input.baseUrl,
              envKey: input.envKey,
              model: input.model,
              reasoningEffort: input.reasoningEffort,
              verbosity: input.verbosity,
              requiresOpenaiAuth: input.requiresOpenaiAuth,
              extraTopLevelConfig: input.extraTopLevelConfig,
              description: input.description,
            })
          }
        />
      )}
    </div>
  )
}

interface ProviderEditModalProps {
  title: string
  initial: CodexProvider | null
  onClose: () => void
  onSubmit: (input: CodexCustomProviderInput) => Promise<void> | void
}

function ProviderEditModal({ title, initial, onClose, onSubmit }: ProviderEditModalProps) {
  const [name, setName] = React.useState(initial?.name ?? '')
  const [baseUrl, setBaseUrl] = React.useState(initial?.baseUrl ?? '')
  const [envKey, setEnvKey] = React.useState(initial?.envKey ?? 'OPENAI_API_KEY')
  const [model, setModel] = React.useState(initial?.model ?? '')
  const [reasoningEffort, setReasoningEffort] = React.useState(initial?.reasoningEffort ?? '')
  const [verbosity, setVerbosity] = React.useState(initial?.verbosity ?? '')
  const [requiresOpenaiAuth, setRequiresOpenaiAuth] = React.useState(
    initial?.requiresOpenaiAuth ?? true,
  )
  const [description, setDescription] = React.useState(initial?.description ?? '')
  const [extraJson, setExtraJson] = React.useState(
    initial?.extraTopLevelConfig
      ? JSON.stringify(initial.extraTopLevelConfig, null, 2)
      : '',
  )
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('请填写 Provider 名称')
      return
    }
    if (!baseUrl.trim()) {
      setError('请填写 base_url')
      return
    }
    let extraTopLevelConfig: Record<string, string | boolean | number> | undefined
    if (extraJson.trim()) {
      try {
        const parsed = JSON.parse(extraJson)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('必须是 JSON 对象')
        }
        for (const v of Object.values(parsed)) {
          if (typeof v !== 'string' && typeof v !== 'boolean' && typeof v !== 'number') {
            throw new Error('值只能是 string / boolean / number')
          }
        }
        extraTopLevelConfig = parsed as Record<string, string | boolean | number>
      } catch (err) {
        setError(`额外 TOML 配置 JSON 解析失败: ${err instanceof Error ? err.message : err}`)
        return
      }
    }

    setSubmitting(true)
    setError(null)
    try {
      await onSubmit({
        name: name.trim(),
        baseUrl: baseUrl.trim(),
        envKey: envKey.trim() || 'OPENAI_API_KEY',
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(reasoningEffort.trim() ? { reasoningEffort: reasoningEffort.trim() } : {}),
        ...(verbosity.trim() ? { verbosity: verbosity.trim() } : {}),
        requiresOpenaiAuth,
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(extraTopLevelConfig ? { extraTopLevelConfig } : {}),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <form
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-[480px] max-h-[85vh] overflow-y-auto bg-zinc-900 border-2 border-cyberpunk-yellow/40 rounded-lg p-5 space-y-3 text-sm"
      >
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-white text-base">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-white text-lg leading-none"
            aria-label="close"
          >
            ×
          </button>
        </div>

        <Field label="名称*">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My Gateway"
            className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
            required
          />
        </Field>

        <Field label="base_url*">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-gateway.example.com/v1"
            className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
            required
          />
        </Field>

        <Field label="env_key">
          <input
            value={envKey}
            onChange={(e) => setEnvKey(e.target.value)}
            placeholder="OPENAI_API_KEY"
            className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-5.2"
              className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
            />
          </Field>
          <Field label="reasoning_effort">
            <input
              value={reasoningEffort}
              onChange={(e) => setReasoningEffort(e.target.value)}
              placeholder="xhigh"
              className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
            />
          </Field>
          <Field label="verbosity">
            <input
              value={verbosity}
              onChange={(e) => setVerbosity(e.target.value)}
              placeholder="high"
              className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
            />
          </Field>
          <Field label="requires_openai_auth">
            <label className="flex items-center gap-2 h-[38px] px-2">
              <input
                type="checkbox"
                checked={requiresOpenaiAuth}
                onChange={(e) => setRequiresOpenaiAuth(e.target.checked)}
              />
              <span className="text-zinc-400 text-xs">写入 -c 标志位</span>
            </label>
          </Field>
        </div>

        <Field label="描述（可选）">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="自家 Codex 网关"
            className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded"
          />
        </Field>

        <Field label="额外 TOML 顶层键值（JSON，可选）">
          <textarea
            value={extraJson}
            onChange={(e) => setExtraJson(e.target.value)}
            placeholder={'{\n  "disable_response_storage": true,\n  "windows_wsl_setup_acknowledged": true\n}'}
            className="w-full bg-zinc-800 border border-zinc-600 text-white px-3 py-2 rounded font-mono text-xs"
            rows={4}
          />
        </Field>

        {error && (
          <div className="text-red-400 text-xs px-2 py-1 bg-red-900/20 border border-red-900/50 rounded">
            {error}
          </div>
        )}

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded uppercase tracking-tight text-xs"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="flex-1 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold rounded uppercase tracking-tight text-xs disabled:opacity-50"
          >
            {submitting ? '保存中…' : initial ? '保存' : '添加'}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-zinc-400 mb-1">{label}</span>
      {children}
    </label>
  )
}
