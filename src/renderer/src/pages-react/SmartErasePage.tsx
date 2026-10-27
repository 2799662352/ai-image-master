import { useEffect, useState } from 'react'
import { useEraseSessionStore } from '../stores/useEraseSessionStore'
import { useErasePersistStore } from '../stores/useErasePersistStore'
import { useToastStore } from '../stores'
import DonorShell from '../components/donor/DonorShell'
import { EraseUploader } from './smart-erase/EraseUploader'
import { EraseQueue } from './smart-erase/EraseQueue'
import { EraseResultGrid } from './smart-erase/EraseResultGrid'
import { EraseResultModal } from './smart-erase/EraseResultModal'
import { EraseHistoryDrawer } from './smart-erase/EraseHistoryDrawer'
import { useEraseEvents } from './smart-erase/useEraseEvents'

const api = (window as any).electronAPI

interface CredentialState {
  hasCredentials: boolean
  secretId?: string
  bucket?: string
  region?: string
}

export default function SmartErasePage() {
  // Subscribe once to the IPC stream.
  useEraseEvents()

  const activeTasks = useEraseSessionStore((s) => s.activeTasks)
  const tool = useEraseSessionStore((s) => s.tool)
  const history = useErasePersistStore((s) => s.history)
  const hydrated = useErasePersistStore((s) => s._hasHydrated)

  const [credentialState, setCredentialState] = useState<CredentialState | null>(null)

  useEffect(() => {
    api?.smartEraseGetConfig?.().then((res: any) => {
      if (res?.success) setCredentialState(res.credentials ?? null)
    })
  }, [])

  const credentialsReady =
    credentialState !== null && credentialState.hasCredentials === true
  // 腾讯云密钥只有去字幕(MPS 直连)要。高清走平台 STS 中转 + Miau 网关,与这把
  // 密钥无关 —— 不能让它把默认工具也一起挡住。
  const credentialsBlocked =
    tool === 'erase' && credentialState !== null && credentialState.hasCredentials === false

  return (
    <DonorShell>
      <div
        aria-hidden="true"
        className="pointer-events-none select-none d-mono font-black leading-none"
        style={{
          position: 'absolute',
          right: '12px',
          top: '-8px',
          fontSize: '180px',
          opacity: 0.08,
          color: 'var(--donor-cyan)',
          zIndex: 1,
        }}
      >
        08
      </div>

      <header className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div className="flex items-baseline gap-3">
          <h1 className="d-mono text-lg tracking-widest uppercase text-[color:var(--donor-cyan)]">
            ✂ 智能去字幕 / 高清
          </h1>
          <span className="d-mono text-[10px] tracking-widest text-[color:var(--donor-ink-mute)]">
            {tool === 'enhance' ? '// VIDEO_ENHANCE · 火山 MediaKit' : '// SMART_ERASE_v1.0 · 模板 303'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {tool === 'erase' && credentialsReady && (
            <span className="d-mono text-[10px] tracking-widest text-[color:var(--donor-green)]">
              ◉ {credentialState?.bucket} @ {credentialState?.region}
            </span>
          )}
          <EraseHistoryDrawer />
        </div>
      </header>

      {credentialsBlocked && (
        <CredentialSetupPanel
          onSaved={(creds) => {
            setCredentialState({
              hasCredentials: true,
              secretId: creds.secretId.slice(0, 4) + '****',
              bucket: creds.bucket,
              region: creds.region,
            })
          }}
        />
      )}

      <div className="space-y-4 relative" style={{ zIndex: 2 }}>
        <EraseUploader disabled={credentialsBlocked} />
        <EraseQueue />
        <EraseResultGrid />
        <EraseResultModal />
      </div>

      <footer className="mt-6 pt-3 border-t border-[color:var(--donor-magenta-dim)] d-mono text-[10px] text-[color:var(--donor-ink-mute)] flex items-center justify-between flex-wrap gap-2">
        <span>
          // SMART_ERASE_v1.0 — active {activeTasks.length} / archive{' '}
          {hydrated ? history.length : '…'}
        </span>
        <span className="d-neon-text-c">[ EOF ]</span>
      </footer>
    </DonorShell>
  )
}

function CredentialSetupPanel({
  onSaved,
}: {
  onSaved: (creds: { secretId: string; secretKey: string; bucket: string; region: string }) => void
}) {
  const [secretId, setSecretId] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [bucket, setBucket] = useState('')
  const [region, setRegion] = useState('ap-guangzhou')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const addToast = useToastStore((s) => s.addToast)

  const handleSave = async () => {
    if (!secretId.trim() || !secretKey.trim() || !bucket.trim() || !region.trim()) {
      setError('全部字段必填')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await api?.smartEraseSetCredentials?.({
        secretId: secretId.trim(),
        secretKey: secretKey.trim(),
        bucket: bucket.trim(),
        region: region.trim(),
      })
      if (res?.success) {
        onSaved({
          secretId: secretId.trim(),
          secretKey: secretKey.trim(),
          bucket: bucket.trim(),
          region: region.trim(),
        })
        addToast({ message: '密钥已保存', type: 'success' })
      } else {
        setError('保存失败，请重试')
      }
    } catch {
      setError('保存失败，请检查网络')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="d-neon-frame p-6 mb-4" style={{ borderColor: 'var(--donor-red)' }}>
      <div className="d-mono text-sm text-[color:var(--donor-red)] tracking-widest mb-4 flex items-center gap-2">
        <span style={{ fontSize: '18px' }}>⚠</span>
        <span>未配置腾讯云密钥 — 智能去字幕需要 COS / MPS 服务</span>
      </div>

      <div className="text-[color:var(--donor-ink-dim)] text-xs mb-4 leading-relaxed">
        请前往
        <a
          href="https://console.cloud.tencent.com/cam/capi"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--donor-cyan)] underline mx-1"
        >
          腾讯云控制台 → 访问管理 → API密钥
        </a>
        获取 SecretId / SecretKey，然后填入下方。同时确保 MPS 服务已开通（
        <a
          href="https://console.cloud.tencent.com/mps/state"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[color:var(--donor-cyan)] underline mx-1"
        >
          MPS 控制台
        </a>
        ）。
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <Field label="SECRET_ID *" value={secretId} onChange={setSecretId} placeholder="AKIDxxxxxxxxxxxxxxxx" />
        <Field label="SECRET_KEY *" value={secretKey} onChange={setSecretKey} type="password" placeholder="xxxxxxxxxxxxxxxxxxxxxxxx" />
        <Field label="BUCKET *" value={bucket} onChange={setBucket} placeholder="my-bucket-1300000000" />
        <Field label="REGION *" value={region} onChange={setRegion} placeholder="ap-guangzhou" />
      </div>

      {error && (
        <div className="d-mono text-[11px] text-[color:var(--donor-red)] mb-3">{error}</div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="d-mono text-xs tracking-widest uppercase px-6 py-2 border border-[color:var(--donor-cyan)] text-[color:var(--donor-cyan)] hover:bg-[color:var(--donor-cyan)] hover:text-[color:var(--donor-bg-0)] transition-colors disabled:opacity-50"
      >
        {saving ? 'SAVING...' : '[ SAVE & ACTIVATE ]'}
      </button>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <div>
      <label className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] tracking-widest block mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-[color:var(--donor-bg-0)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-xs focus:outline-none focus:border-[color:var(--donor-cyan)]"
      />
    </div>
  )
}
