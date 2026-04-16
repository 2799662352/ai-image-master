import { useState, useCallback, useEffect } from 'react'
import { useToastStore } from '../stores'

interface SiteInfo {
  key: string
  name: string
  baseURL: string
  description?: string
  isCustom?: boolean
}

export default function SettingsPage() {
  const addToast = useToastStore((s) => s.addToast)
  const [apiKey, setApiKey] = useState('')
  const [visionApiKey, setVisionApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [sites, setSites] = useState<SiteInfo[]>([])
  const [activeSite, setActiveSite] = useState('')
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const api = (window as any).aiImageAPI
    if (!api) return

    const siteList: SiteInfo[] = []
    const siteConfigs = api.getAllSites?.() ?? {}
    for (const [key, cfg] of Object.entries(siteConfigs)) {
      const c = cfg as any
      siteList.push({ key, name: c.name, baseURL: c.baseURL, description: c.description, isCustom: c.isCustom })
    }
    setSites(siteList)

    const current = api.currentSite ?? ''
    setActiveSite(current)

    const stored = api.getStoredApiKey?.(current)
    const site = api.getCurrentSite?.()
    setApiKey(stored || site?.defaultApiKey || '')
  }, [])

  const handleSelectSite = useCallback((key: string) => {
    const api = (window as any).aiImageAPI
    if (!api) return
    api.switchSite?.(key)
    setActiveSite(key)
    const stored = api.getStoredApiKey?.(key)
    const site = api.getSiteConfig?.(key)
    setApiKey(stored || site?.defaultApiKey || '')
  }, [])

  const handleTest = useCallback(async () => {
    if (!apiKey.trim()) {
      addToast({ message: '请先输入 API Key', type: 'warning' })
      return
    }
    setTesting(true)
    try {
      const api = (window as any).aiImageAPI
      const ok = await api?.testConnection?.(apiKey)
      addToast({ message: ok ? '连接成功!' : '连接失败', type: ok ? 'success' : 'error' })
    } catch {
      addToast({ message: '测试连接失败', type: 'error' })
    } finally {
      setTesting(false)
    }
  }, [apiKey, addToast])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      const api = (window as any).aiImageAPI
      await api?.saveApiKey?.(apiKey)
      if (visionApiKey) {
        await api?.saveVisionApiKey?.(visionApiKey)
      }
      addToast({ message: '配置已保存', type: 'success' })
    } catch {
      addToast({ message: '保存失败', type: 'error' })
    } finally {
      setSaving(false)
    }
  }, [apiKey, visionApiKey, addToast])

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow flex items-center gap-2">
        <span>⚙️</span> API 设置
      </h1>

      {/* Step 1: Select API Site */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            1
          </span>
          <span className="font-bold text-white uppercase tracking-tight">选择 API 站点</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {sites.map((site) => (
            <button
              key={site.key}
              onClick={() => handleSelectSite(site.key)}
              className={`p-3 border-2 rounded text-left transition-all text-sm ${
                activeSite === site.key
                  ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/10 text-cyberpunk-yellow'
                  : 'border-zinc-700 bg-zinc-900 text-gray-400 hover:border-zinc-500'
              }`}
            >
              <div className="font-semibold truncate">{site.name}</div>
              {site.description && (
                <div className="text-xs mt-1 opacity-70 truncate">{site.description}</div>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* Step 2: API Key */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
            2
          </span>
          <span className="font-bold text-white uppercase tracking-tight">输入 API Key</span>
        </div>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="请输入您的图片生成 API Key"
            className="w-full px-4 py-3 pr-10 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
          />
          <button
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-cyberpunk-yellow"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? '🙈' : '👁️'}
          </button>
        </div>
      </section>

      {/* Vision API Key */}
      <section className="space-y-3">
        <label className="block text-sm font-bold text-white">
          图像理解 API Key（可选）
        </label>
        <input
          type="password"
          value={visionApiKey}
          onChange={(e) => setVisionApiKey(e.target.value)}
          placeholder="请输入您的图像理解 API Key（可选）"
          className="w-full px-3 py-2 bg-zinc-800 border-2 border-zinc-700 text-white placeholder-zinc-500 focus:outline-none focus:border-cyberpunk-yellow"
        />
        <p className="text-xs text-zinc-500">用于图像理解功能，可选填</p>
      </section>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="flex-1 py-2.5 px-4 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white font-bold uppercase tracking-tight transition-colors disabled:opacity-50"
        >
          {testing ? '测试中...' : '🔌 测试连接'}
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2.5 px-4 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black font-bold uppercase tracking-tight transition-all disabled:opacity-50"
        >
          {saving ? '保存中...' : '✅ 保存配置'}
        </button>
      </div>
    </div>
  )
}
