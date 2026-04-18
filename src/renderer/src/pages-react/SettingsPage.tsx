import { useEffect } from 'react'
import { useToastStore } from '../stores'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useApi } from '../hooks/useService'
import { SiteGrid } from './settings/SiteGrid'
import { ApiKeyInput } from './settings/ApiKeyInput'

export default function SettingsPage() {
  const api = useApi()
  const addToast = useToastStore((s) => s.addToast)

  const sites = useSettingsStore((s) => s.sites)
  const activeSiteKey = useSettingsStore((s) => s.activeSiteKey)
  const apiKey = useSettingsStore((s) => s.apiKey)
  const visionApiKey = useSettingsStore((s) => s.visionApiKey)
  const connectionStatus = useSettingsStore((s) => s.connectionStatus)
  const saving = useSettingsStore((s) => s.saving)
  const loadError = useSettingsStore((s) => s.loadError)

  const { switchSite, setApiKey, setVisionApiKey, testConnection, saveAll, loadFromService } =
    useSettingsStore.getState()

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

  const handleSave = async () => {
    try {
      await saveAll(api)
      addToast({ message: '配置已保存', type: 'success' })
    } catch {
      addToast({ message: '保存失败', type: 'error' })
    }
  }

  const isTesting = connectionStatus === 'testing'

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      <h1 className="text-2xl font-orbitron text-cyberpunk-yellow flex items-center gap-2">
        <span>{'\u2699\uFE0F'}</span> API 设置
      </h1>

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
    </div>
  )
}
