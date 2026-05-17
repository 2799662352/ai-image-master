import React, { useEffect } from 'react'
import { useToastStore } from '../stores'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useUIPrefsStore } from '../stores/useUIPrefsStore'
import { useApi } from '../hooks/useService'
import { SiteGrid } from './settings/SiteGrid'
import { ApiKeyInput } from './settings/ApiKeyInput'
import { CodexProviderManager } from './settings/CodexProviderManager'

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

  return (
    <section className="space-y-3 pt-4 border-t border-zinc-700">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">☁</span>
        <span className="font-bold text-white uppercase tracking-tight">腾讯云 COS / MPS</span>
        {source && source !== 'none' && (
          <span className="text-xs text-green-400">({source === 'env' ? '.env 已配置' : '已保存'})</span>
        )}
      </div>
      <p className="text-xs text-zinc-500">用于宫格拆图功能。留空则使用 .env 环境变量。</p>
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
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold text-sm uppercase tracking-tight transition-all disabled:opacity-50 rounded"
      >
        {saving ? '保存中...' : '💾 保存腾讯云配置'}
      </button>
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
      const electronAPI = (window as any).electronAPI
      const result = await electronAPI?.agent?.testConnection?.()
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
        await (window as any).electronAPI?.agent?.setApiKey?.(codexApiKey)
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

      <TencentCloudSection />
    </div>
  )
}
