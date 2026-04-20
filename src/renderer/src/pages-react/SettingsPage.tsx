import { useEffect } from 'react'
import { useToastStore } from '../stores'
import { useSettingsStore } from '../stores/useSettingsStore'
import { useUIPrefsStore } from '../stores/useUIPrefsStore'
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
            ⚙
          </span>
          <span className="font-bold text-white uppercase tracking-tight">界面偏好</span>
        </div>
        <label className="flex items-center justify-between gap-4 cursor-pointer">
          <div>
            <div className="text-sm text-white font-medium">图片编辑工具条</div>
            <div className="text-xs text-zinc-500">悬停图片时显示"多角度"和"打光"提示词助手按钮</div>
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
    </div>
  )
}
