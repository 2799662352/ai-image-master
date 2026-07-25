import React, { useEffect } from 'react'
import { useToastStore } from '../stores'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useUIPrefsStore } from '../stores/useUIPrefsStore'
import { useApi } from '../hooks/useService'
import { SiteGrid } from './settings/SiteGrid'
import { ApiKeyInput } from './settings/ApiKeyInput'
import { CodexProviderManager } from './settings/CodexProviderManager'
import { getAgentApi } from '../utils/agentBridge'
import {
  CINEMATOGRAPHY_KB_MCP_PROVIDER_ID,
  DASHSCOPE_API_KEY_STORAGE,
  DASHVECTOR_MCP_PROVIDER_ID,
  DASHVECTOR_API_KEY_STORAGE,
} from '../services/api/ApiService'

function TencentCloudSection() {
  const addToast = useToastStore((s) => s.addToast)
  const [secretId, setSecretId] = React.useState('')
  const [secretKey, setSecretKey] = React.useState('')
  const [bucket, setBucket] = React.useState('')
  const [region, setRegion] = React.useState('ap-guangzhou')
  const [source, setSource] = React.useState('')
  const [saving, setSaving] = React.useState(false)

  const api = (window as any).electronAPI

  React.useEffect(() => {
    api?.storyboardSplitGetConfig?.().then((res: any) => {
      if (res?.success && res.credentials) {
        setSource(res.credentials.credentialSource || 'none')
        setBucket(res.credentials.bucket || '')
        setRegion(res.credentials.region || 'ap-guangzhou')
      }
    })
  }, [])

  const handleSave = async () => {
    // 腾讯云永久 SecretId 恒为 AKID 开头;别家 key 粘进来只会导致
    // InvalidAccessKeyId,提前拦下。
    if (secretId.trim() && !secretId.trim().startsWith('AKID')) {
      addToast({ message: 'SecretId 格式不对:腾讯云永久密钥以 AKID 开头。不填则自动走免密钥通道。', type: 'error' })
      return
    }
    setSaving(true)
    try {
      const res = await api?.storyboardSplitSetCredentials?.({ secretId, secretKey, bucket, region })
      if (res?.success) {
        addToast({ message: '腾讯云配置已保存', type: 'success' })
        setSecretId('')
        setSecretKey('')
      } else {
        addToast({ message: res?.error || '保存失败', type: 'error' })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      const res = await api?.storyboardSplitSetCredentials?.({ secretId: '', secretKey: '', bucket: '', region: '' })
      if (res?.success) {
        setSecretId('')
        setSecretKey('')
        setBucket('')
        setRegion('ap-guangzhou')
        setSource('sts')
        addToast({ message: '已清除密钥,切换到免密钥 · 云端临时授权', type: 'success' })
      } else {
        addToast({ message: res?.error || '清除失败', type: 'error' })
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-3 pt-4 border-t border-zinc-700">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">☁</span>
        <span className="font-bold text-white uppercase tracking-tight">腾讯云 COS / MPS</span>
        {source && source !== 'none' && (
          <span className={`text-xs ${source === 'sts' ? 'text-cyan-400' : 'text-green-400'}`}>
            ({source === 'env' ? '.env 已配置' : source === 'sts' ? '免密钥 · 云端临时授权' : '已保存'})
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        用于分镜切图 / 智能去字幕。不填也能用(自动走云端临时授权);填自己的密钥则优先生效,留空退回 .env 环境变量。
      </p>
      <div className="grid grid-cols-2 gap-3">
        <input
          value={secretId}
          onChange={(e) => setSecretId(e.target.value)}
          placeholder="SecretId"
          className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <input
          type="password"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          placeholder="SecretKey"
          className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="Bucket（含 APPID 后缀）"
          className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="Region"
          className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold text-sm uppercase tracking-tight transition-all disabled:opacity-50 rounded"
        >
          {saving ? '保存中...' : '💾 保存腾讯云配置'}
        </button>
        <button
          onClick={handleClear}
          disabled={saving}
          title="清空已保存的密钥,分镜切图 / 智能去字幕改走云端临时授权(免密钥)"
          className="px-4 py-2 border border-zinc-600 text-zinc-300 hover:border-cyan-400 hover:text-cyan-400 text-sm font-bold uppercase tracking-tight transition-all disabled:opacity-50 rounded"
        >
          清除密钥
        </button>
      </div>
    </section>
  )
}

function SeedanceSection() {
  const addToast = useToastStore((s) => s.addToast)
  const [apiKey, setApiKeyInput] = React.useState('')
  const [apiSecret, setApiSecretInput] = React.useState('')
  const [keyState, setKeyState] = React.useState<{
    hasKey: boolean
    keyMasked?: string
    source: 'store' | 'env' | 'none'
    hasSecret?: boolean
    secretMasked?: string
    region?: 'global' | 'cn'
  } | null>(null)
  const [saving, setSaving] = React.useState(false)

  const api = (window as any).electronAPI

  React.useEffect(() => {
    api?.seedance?.getConfig?.().then((state: any) => {
      if (state) setKeyState(state)
    })
    // 站点也可能在「生成视频」工作台被切换 —— 订阅广播保持两处 UI 一致
    const unsub = api?.seedance?.onConfigChanged?.((state: any) => {
      if (state) setKeyState(state)
    })
    return () => unsub?.()
  }, [])

  const handleSave = async (
    field: 'apiKey' | 'apiSecret' | 'region',
    value: string,
  ) => {
    setSaving(true)
    const label =
      field === 'apiKey' ? 'API Key' : field === 'apiSecret' ? 'API Secret' : '站点'
    try {
      // 防御：区分「preload 未注入 setConfig（旧窗口/旧实例，需重启 pnpm dev）」
      // 和「主进程返回异常」，否则两者都只显示笼统的「接口不可用」没法排查。
      if (typeof api?.seedance?.setConfig !== 'function') {
        addToast({
          message:
            '保存失败：当前窗口的 preload 缺少 Seedance 接口（可能是旧实例），请重启应用（pnpm dev）',
          type: 'error',
        })
        return
      }
      const state = await api.seedance.setConfig({ [field]: value })
      if (state) {
        setKeyState(state)
        if (field === 'apiKey') setApiKeyInput('')
        else if (field === 'apiSecret') setApiSecretInput('')
        addToast({
          message:
            field === 'region'
              ? `Seedance 站点已切换为 ${value === 'cn' ? '国内' : '海外 GLOBAL'}`
              : value
                ? `Seedance ${label} 已保存`
                : `Seedance ${label} 已清除`,
          type: 'success',
        })
      } else {
        addToast({ message: '保存失败：Seedance 接口不可用', type: 'error' })
      }
    } catch (e: any) {
      addToast({ message: `保存失败: ${e?.message ?? String(e)}`, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const sourceLabel =
    keyState?.source === 'env'
      ? '.env 已配置'
      : keyState?.source === 'store'
        ? `已保存 ${keyState.keyMasked ?? ''}`
        : null

  const region = keyState?.region ?? 'global'

  return (
    <section className="space-y-3 pt-4 border-t border-zinc-700">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">🎬</span>
        <span className="font-bold text-white uppercase tracking-tight">Seedance 视频生成</span>
        {sourceLabel && <span className="text-xs text-green-400">({sourceLabel})</span>}
      </div>
      <p className="text-xs text-zinc-500">
        直连 VVDance（默认海外 GLOBAL / vvdance.ai）。API Key = 视频任务 Bearer；API Secret =
        人像库 HMAC 签名。与 Miau / antigravity 出图 Key 无关。换站后请使用对应站点的开发者凭证。
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-zinc-400 shrink-0">站点</span>
        <div className="inline-flex rounded border border-zinc-600 overflow-hidden text-sm">
          <button
            type="button"
            disabled={saving || region === 'global'}
            onClick={() => handleSave('region', 'global')}
            className={`px-3 py-1.5 transition-all ${
              region === 'global'
                ? 'bg-cyberpunk-yellow text-cyberpunk-black font-bold'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50'
            }`}
          >
            海外 GLOBAL
          </button>
          <button
            type="button"
            disabled={saving || region === 'cn'}
            onClick={() => handleSave('region', 'cn')}
            className={`px-3 py-1.5 transition-all border-l border-zinc-600 ${
              region === 'cn'
                ? 'bg-cyberpunk-yellow text-cyberpunk-black font-bold'
                : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50'
            }`}
          >
            国内
          </button>
        </div>
        <span className="text-xs text-zinc-500">
          {region === 'cn' ? 'vvdance.yongmuai.com · doubao-*' : 'vvdance.ai · dreamina-*'}
        </span>
      </div>
      <div className="flex gap-3">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKeyInput(e.target.value)}
          placeholder={keyState?.hasKey ? '已配置，输入新 Key 可覆盖' : '请输入 VVDance 开发者 API Key'}
          className="flex-1 bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <button
          onClick={() => handleSave('apiKey', apiKey.trim())}
          disabled={saving || (!apiKey.trim() && !keyState?.hasKey)}
          className="px-4 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold text-sm uppercase tracking-tight transition-all disabled:opacity-50 rounded"
        >
          {saving ? '保存中...' : apiKey.trim() ? '💾 保存' : '🗑 清除'}
        </button>
      </div>
      <div className="flex gap-3">
        <input
          type="password"
          value={apiSecret}
          onChange={(e) => setApiSecretInput(e.target.value)}
          placeholder={
            keyState?.hasSecret
              ? `已配置 ${keyState.secretMasked ?? ''}，输入新 Secret 可覆盖`
              : '请输入 API Secret（人像库签名，可选）'
          }
          className="flex-1 bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <button
          onClick={() => handleSave('apiSecret', apiSecret.trim())}
          disabled={saving || (!apiSecret.trim() && !keyState?.hasSecret)}
          className="px-4 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold text-sm uppercase tracking-tight transition-all disabled:opacity-50 rounded"
        >
          {saving ? '保存中...' : apiSecret.trim() ? '💾 保存' : '🗑 清除'}
        </button>
      </div>
    </section>
  )
}

/** Mask a secret for display: keep the sk- prefix + last 4 chars. */
function maskKey(key: string): string {
  const k = key.trim()
  if (k.length <= 8) return '••••'
  return `${k.slice(0, 3)}••••${k.slice(-4)}`
}

/**
 * 设置 → 运镜知识库 DASHSCOPE key. Mirrors apiyi-mcp's runtime-injection model:
 * the key is stored in localStorage (so it survives reload + shows a "已配置"
 * hint) AND pushed to the main process via `setProviderApiKey('cinematography-kb',
 * …)`, which injects it at codex spawn via
 * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY` — never written to
 * `~/.codex/config.toml`. Clearing propagates as an empty push (main stops
 * injecting). The bundled cinematography-kb-mcp server queries the shared 运镜与
 * 结构化描述库 (Alibaba Bailian).
 */
function CinematographyKbSection() {
  const addToast = useToastStore((s) => s.addToast)
  const [input, setInput] = React.useState('')
  const [saved, setSaved] = React.useState('')
  const [dvInput, setDvInput] = React.useState('')
  const [dvSaved, setDvSaved] = React.useState('')

  React.useEffect(() => {
    try {
      setSaved((localStorage.getItem(DASHSCOPE_API_KEY_STORAGE) ?? '').trim())
      setDvSaved((localStorage.getItem(DASHVECTOR_API_KEY_STORAGE) ?? '').trim())
    } catch {
      /* ignore */
    }
  }, [])

  const push = (providerId: string, key: string) => {
    const agent = getAgentApi()
    if (agent?.setProviderApiKey) {
      void agent.setProviderApiKey(providerId, key)
    }
  }

  const handleSave = () => {
    const key = input.trim()
    try {
      if (key) {
        localStorage.setItem(DASHSCOPE_API_KEY_STORAGE, key)
        setSaved(key)
        push(CINEMATOGRAPHY_KB_MCP_PROVIDER_ID, key)
        setInput('')
        addToast({ message: '运镜知识库 DASHSCOPE Key 已保存', type: 'success' })
      } else {
        localStorage.removeItem(DASHSCOPE_API_KEY_STORAGE)
        setSaved('')
        push(CINEMATOGRAPHY_KB_MCP_PROVIDER_ID, '')
        addToast({ message: '运镜知识库 DASHSCOPE Key 已清除', type: 'success' })
      }
    } catch (e: any) {
      addToast({ message: `保存失败: ${e?.message ?? String(e)}`, type: 'error' })
    }
  }

  const handleSaveDashVector = () => {
    const key = dvInput.trim()
    try {
      if (key) {
        localStorage.setItem(DASHVECTOR_API_KEY_STORAGE, key)
        setDvSaved(key)
        push(DASHVECTOR_MCP_PROVIDER_ID, key)
        setDvInput('')
        addToast({ message: 'Sakuga 数据集 DashVector Key 已保存', type: 'success' })
      } else {
        localStorage.removeItem(DASHVECTOR_API_KEY_STORAGE)
        setDvSaved('')
        push(DASHVECTOR_MCP_PROVIDER_ID, '')
        addToast({ message: 'Sakuga 数据集 DashVector Key 已清除', type: 'success' })
      }
    } catch (e: any) {
      addToast({ message: `保存失败: ${e?.message ?? String(e)}`, type: 'error' })
    }
  }

  return (
    <section className="space-y-3 pt-4 border-t border-zinc-700">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">🎥</span>
        <span className="font-bold text-white uppercase tracking-tight">运镜知识库（Codex MCP）</span>
        {saved && <span className="text-xs text-green-400">(已配置 {maskKey(saved)})</span>}
      </div>
      <p className="text-xs text-zinc-500">
        为 Codex Agent 的 <code className="text-zinc-400">search_cinematography_kb</code> 工具提供阿里云百炼
        <code className="text-zinc-400"> DASHSCOPE_API_KEY</code>，用于检索「运镜与结构化描述库」（245 个运镜基元 /
        CHAI 五维结构化描述 / 专业范例）。Key 仅存本地并在 codex 启动时注入，绝不写入 config.toml。留空保存可清除。
      </p>
      <div className="flex gap-3">
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={saved ? '已配置，输入新 Key 可覆盖' : '请输入百炼 DASHSCOPE API Key（sk- 开头）'}
          className="flex-1 bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <button
          onClick={handleSave}
          disabled={!input.trim() && !saved}
          className="px-4 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold text-sm uppercase tracking-tight transition-all disabled:opacity-50 rounded"
        >
          {input.trim() ? '💾 保存' : '🗑 清除'}
        </button>
      </div>
      <p className="text-xs text-zinc-500">
        （可选）为 <code className="text-zinc-400">query_sakuga_dataset</code> 工具提供
        <code className="text-zinc-400"> DashVector API Key</code>，用于检索 Sakuga-42M 真实动画数据集
        （110 万条手绘作画片段描述 / 技法标签 / 回源链接）。同样仅本地保存、启动时注入。
        {dvSaved && <span className="text-green-400">（已配置 {maskKey(dvSaved)}）</span>}
      </p>
      <div className="flex gap-3">
        <input
          type="password"
          value={dvInput}
          onChange={(e) => setDvInput(e.target.value)}
          placeholder={dvSaved ? '已配置，输入新 Key 可覆盖' : '请输入 DashVector API Key（可选）'}
          className="flex-1 bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-2 rounded"
        />
        <button
          onClick={handleSaveDashVector}
          disabled={!dvInput.trim() && !dvSaved}
          className="px-4 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold text-sm uppercase tracking-tight transition-all disabled:opacity-50 rounded"
        >
          {dvInput.trim() ? '💾 保存' : '🗑 清除'}
        </button>
      </div>
    </section>
  )
}

export default function SettingsPage() {
  const api = useApi()
  const addToast = useToastStore((s) => s.addToast)

  const sites = useSettingsStore((s) => s.sites)
  const activeSiteKey = useSettingsStore((s) => s.activeSiteKey)
  const apiKey = useSettingsStore((s) => s.apiKey)
  const visionApiKey = useSettingsStore((s) => s.visionApiKey)
  const codexApiKey = useSettingsStore((s) => s.codexApiKey)
  const localPort = useSettingsStore((s) => s.localPort)
  const connectionStatus = useSettingsStore((s) => s.connectionStatus)
  const saving = useSettingsStore((s) => s.saving)
  const loadError = useSettingsStore((s) => s.loadError)

  const {
    switchSite,
    setApiKey,
    setVisionApiKey,
    setCodexApiKey,
    setLocalPort,
    testConnection,
    saveAll,
    loadFromService,
  } = useSettingsStore.getState()

  const [testingCodex, setTestingCodex] = React.useState(false)

  useEffect(() => {
    loadFromService(api)
  }, [])

  const handleTest = async () => {
    if (!apiKey.trim()) {
      addToast({ message: '请先输入 API Key', type: 'warning' })
      return
    }
    const ok = await testConnection(api)
    addToast({
      message: ok ? '连接成功!' : '连接失败',
      type: ok ? 'success' : 'error',
    })
  }

  const handleTestCodex = async () => {
    setTestingCodex(true)
    try {
      const result = await getAgentApi()?.testConnection?.()
      if (result?.ok) {
        addToast({ message: 'Codex 连接成功', type: 'success' })
      } else {
        addToast({ message: `Codex 连接失败: ${result?.error ?? '未知错误'}`, type: 'error' })
      }
    } catch (e: any) {
      addToast({ message: `Codex 连接失败: ${e?.message ?? String(e)}`, type: 'error' })
    } finally {
      setTestingCodex(false)
    }
  }

  const handleSave = async () => {
    try {
      await saveAll(api)
      try {
        await getAgentApi()?.setApiKey?.(codexApiKey)
      } catch (err) {
        console.warn('failed to push codex key to main:', err)
      }
      addToast({ message: '配置已保存', type: 'success' })
      const vanillaApi = (window as any).aiImageAPI
      vanillaApi?.updateApiStatus?.()
      window.dispatchEvent(new CustomEvent('settings-saved'))
    } catch {
      addToast({ message: '保存失败', type: 'error' })
    }
  }

  const isTesting = connectionStatus === 'testing'
  const toolbarEnabled = useUIPrefsStore((s) => s.imageEditorToolbar.enabled)
  const setToolbarEnabled = useUIPrefsStore((s) => s.setImageEditorToolbar)

  return (
    <div className="p-6 space-y-6">
      {loadError && (
        <div className="p-3 bg-red-900/30 border border-red-700 text-red-300 text-sm rounded">
          加载失败: {loadError}
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            1
          </span>
          <span className="font-bold text-white uppercase tracking-tight">选择 API 站点</span>
        </div>
        <SiteGrid
          sites={sites}
          activeSiteKey={activeSiteKey}
          onSelect={(key) => switchSite(key, api)}
        />
        {activeSiteKey === 'local' && (
          <div className="flex items-center gap-3 mt-3">
            <span className="text-sm text-zinc-400 whitespace-nowrap">服务端口</span>
            <input
              type="number"
              min={1}
              max={65535}
              value={localPort}
              onChange={(e) => {
                const v = e.target.value
                if (/^\d*$/.test(v)) setLocalPort(v, api)
              }}
              placeholder="3000"
              className="w-28 px-3 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow text-sm"
              style={{ MozAppearance: 'textfield' } as React.CSSProperties}
            />
            <span className="text-xs text-zinc-500">
              当前: http://127.0.0.1:{localPort || '3000'}
            </span>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            2
          </span>
          <span className="font-bold text-white uppercase tracking-tight">输入 API Key</span>
        </div>
        <ApiKeyInput
          value={apiKey}
          onChange={setApiKey}
          placeholder="请输入您的图片生成 API Key"
        />
      </section>

      <section className="space-y-3">
        <ApiKeyInput
          value={visionApiKey}
          onChange={setVisionApiKey}
          label="图像理解 API Key（可选）"
          placeholder="请输入您的图像理解 API Key（可选）"
          showToggle={false}
        />
        <p className="text-xs text-zinc-500">用于图像理解功能，可选填</p>
      </section>

      <div className="flex gap-3 pt-2">
        <button
          onClick={handleTest}
          disabled={isTesting}
          className="flex-1 py-2.5 px-4 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white font-bold uppercase tracking-tight transition-colors disabled:opacity-50"
        >
          {isTesting ? '测试中...' : '\u{1F50C} 测试连接'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2.5 px-4 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold uppercase tracking-tight transition-all disabled:opacity-50"
        >
          {saving ? '保存中...' : '\u2705 保存配置'}
        </button>
      </div>

      <section className="space-y-3 pt-4 border-t border-zinc-700">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            🤖
          </span>
          <span className="font-bold text-white uppercase tracking-tight">CODEX AGENT</span>
        </div>
        <p className="text-xs text-zinc-500">
          用于 AI Agent (Ctrl+Shift+A)。选择内置 provider 或添加自定义网关，每个 provider 单独存储 key。
        </p>
        <CodexProviderManager />
        <button
          onClick={handleTestCodex}
          disabled={!codexApiKey.trim() || testingCodex}
          className="w-full py-2 px-4 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white font-bold uppercase tracking-tight transition-colors disabled:opacity-50"
        >
          {testingCodex ? '测试中...' : '🔌 测试 Codex 连接'}
        </button>
      </section>

      <CinematographyKbSection />

      <section className="space-y-3 pt-4 border-t border-zinc-700">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            ⚙
          </span>
          <span className="font-bold text-white uppercase tracking-tight">界面偏好</span>
        </div>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <div className="text-sm text-white font-medium">图片编辑工具条</div>
            <div className="text-xs text-zinc-500">
              在图生图 / 批量 / 对比页的提示词框旁，以及结果图悬停时显示「多角度」「打光」助手按钮
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={toolbarEnabled}
            onClick={() => setToolbarEnabled(!toolbarEnabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              toolbarEnabled ? 'bg-cyberpunk-yellow' : 'bg-zinc-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                toolbarEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>
      </section>

      <SeedanceSection />

      <TencentCloudSection />
    </div>
  )
}
