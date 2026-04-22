import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getR2StorageService } from '../../services/r2-storage'

const DEFAULT_WORKER_URL = 'https://ai-image-proxy.uchihasasiky.workers.dev'

type Mode = 'default' | 'custom-r2' | 'oss'

interface Props {
  onClose: () => void
  onSaved?: () => void
}

/**
 * 云存储配置弹窗 - 三选一
 * - default: 使用内置默认 R2 Worker
 * - custom-r2: 用户自建 Cloudflare R2 Worker URL
 * - oss: 阿里云 OSS / 其他 S3 兼容(暂保留占位 UI,持久化 localStorage)
 */
export default function DonorStorageModal({ onClose, onSaved }: Props) {
  const [mode, setMode] = useState<Mode>('default')
  const [customUrl, setCustomUrl] = useState('')
  const [ossEndpoint, setOssEndpoint] = useState('')
  const [ossAk, setOssAk] = useState('')
  const [ossSk, setOssSk] = useState('')
  const [ossBucket, setOssBucket] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    const current = localStorage.getItem('worker_url')
    const savedMode = localStorage.getItem('storage_mode') as Mode | null
    if (savedMode === 'oss') {
      setMode('oss')
      setOssEndpoint(localStorage.getItem('oss_endpoint') || '')
      setOssAk(localStorage.getItem('oss_ak') || '')
      setOssSk('') // 不回显 SK
      setOssBucket(localStorage.getItem('oss_bucket') || '')
    } else if (current && current !== DEFAULT_WORKER_URL) {
      setMode('custom-r2')
      setCustomUrl(current)
    } else {
      setMode('default')
    }
  }, [])

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }
  useEffect(() => {
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const test = async () => {
    const url = mode === 'custom-r2' ? customUrl.trim() : DEFAULT_WORKER_URL
    if (!url) {
      setTestResult({ ok: false, msg: 'URL 为空' })
      return
    }
    setTesting(true)
    setTestResult(null)
    /**
     * 可达性测试策略 (绕开 CORS):
     * 1) 优先用 mode:'no-cors' fetch — 不需要 CORS header,只判网络可达 (opaque response 即视为通)
     * 2) 失败时回退到 Image ping (favicon.ico) — 任何 200/404 都算可达
     * 3) 都失败才视为不可达
     */
    try {
      let reachable = false
      let detail = ''
      try {
        await fetch(url, { method: 'GET', mode: 'no-cors', cache: 'no-store' })
        reachable = true
        detail = 'opaque OK'
      } catch (err: any) {
        detail = err?.message || 'fetch failed'
        reachable = await pingByImage(url)
        if (reachable) detail = 'image ping OK'
      }
      setTestResult({
        ok: reachable,
        msg: reachable ? `连接成功 / REACHABLE (${detail})` : `无法访问 / UNREACHABLE (${detail})`,
      })
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message || '请求失败' })
    } finally {
      setTesting(false)
    }
  }

  const save = () => {
    try {
      if (mode === 'default') {
        localStorage.setItem('worker_url', DEFAULT_WORKER_URL)
        localStorage.setItem('storage_mode', 'default')
        getR2StorageService().setWorkerUrl(DEFAULT_WORKER_URL)
      } else if (mode === 'custom-r2') {
        const url = customUrl.trim().replace(/\/$/, '')
        if (!url) {
          setTestResult({ ok: false, msg: 'Worker URL 不能为空' })
          return
        }
        localStorage.setItem('worker_url', url)
        localStorage.setItem('storage_mode', 'custom-r2')
        getR2StorageService().setWorkerUrl(url)
      } else if (mode === 'oss') {
        localStorage.setItem('storage_mode', 'oss')
        localStorage.setItem('oss_endpoint', ossEndpoint.trim())
        localStorage.setItem('oss_ak', ossAk.trim())
        if (ossSk) localStorage.setItem('oss_sk', ossSk) // 仅当用户输入时写入
        localStorage.setItem('oss_bucket', ossBucket.trim())
      }
      onSaved?.()
      onClose()
    } catch (e: any) {
      setTestResult({ ok: false, msg: e?.message || '保存失败' })
    }
  }

  return createPortal(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
        backgroundColor: 'rgba(10, 5, 16, 0.92)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="donor-theme d-neon-frame d-clip-corner-tl relative w-full max-w-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[color:var(--donor-magenta-dim)]">
          <div>
            <div className="d-mono text-[10px] text-[color:var(--donor-cyan)] tracking-widest">CONFIG // 設定</div>
            <h2
              className="d-chromatic font-black text-[22px] leading-none mt-1"
              data-text="STORAGE.CFG"
              style={{ fontFamily: 'var(--donor-font-jp)' }}
            >
              STORAGE.CFG
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="d-hover-invert px-3 py-1 d-mono text-[11px] tracking-widest uppercase"
          >
            [ ESC ]
          </button>
        </div>

        {/* Mode 选择 */}
        <div className="px-5 py-4 max-h-[72vh] overflow-y-auto">
          <div className="d-mono text-[11px] text-[color:var(--donor-ink-dim)] mb-2 tracking-widest">
            MODE // ストレージ方式
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <ModeTile
              active={mode === 'default'}
              onClick={() => setMode('default')}
              label="DEFAULT_R2"
              labelJp="既定"
              desc="内置 Cloudflare R2 Worker,开箱即用"
            />
            <ModeTile
              active={mode === 'custom-r2'}
              onClick={() => setMode('custom-r2')}
              label="CUSTOM_R2"
              labelJp="自前 R2"
              desc="自建 Cloudflare Worker + R2"
            />
            <ModeTile
              active={mode === 'oss'}
              onClick={() => setMode('oss')}
              label="ALIYUN_OSS"
              labelJp="OSS"
              desc="阿里云 OSS / S3 兼容"
            />
          </div>

          {/* ===== Default ===== */}
          {mode === 'default' && (
            <div className="mt-4 p-3 border border-[color:var(--donor-cyan-dim)] bg-[color:var(--donor-bg-1)]/60">
              <div className="d-mono text-[11px] text-[color:var(--donor-cyan)] mb-1">WORKER_URL (READONLY)</div>
              <code className="block d-mono text-[12px] text-[color:var(--donor-ink)] break-all">
                {DEFAULT_WORKER_URL}
              </code>
              <p className="mt-2 d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
                // 默认共享实例,免配置;如需私有化请切换至 CUSTOM_R2
              </p>
            </div>
          )}

          {/* ===== Custom R2 ===== */}
          {mode === 'custom-r2' && (
            <div className="mt-4 space-y-3">
              <Field label="WORKER_URL" labelJp="Worker 地址" required>
                <input
                  type="url"
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://your-worker.your-subdomain.workers.dev"
                  className={inputCls}
                />
              </Field>
              <p className="d-mono text-[10px] text-[color:var(--donor-ink-mute)]">
                // 需在 Cloudflare 自建 Worker 并绑定 R2 bucket,参考项目 docs/cloudflare-worker.md
              </p>
            </div>
          )}

          {/* ===== OSS ===== */}
          {mode === 'oss' && (
            <div className="mt-4 space-y-3">
              <Field label="ENDPOINT" labelJp="エンドポイント" required>
                <input
                  type="url"
                  value={ossEndpoint}
                  onChange={(e) => setOssEndpoint(e.target.value)}
                  placeholder="https://oss-cn-hangzhou.aliyuncs.com"
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="ACCESS_KEY" labelJp="AK" required>
                  <input
                    type="text"
                    value={ossAk}
                    onChange={(e) => setOssAk(e.target.value)}
                    autoComplete="off"
                    className={inputCls}
                  />
                </Field>
                <Field label="SECRET_KEY" labelJp="SK" required>
                  <input
                    type="password"
                    value={ossSk}
                    onChange={(e) => setOssSk(e.target.value)}
                    placeholder="(留空保持不变)"
                    autoComplete="new-password"
                    className={inputCls}
                  />
                </Field>
              </div>
              <Field label="BUCKET" labelJp="バケット" required>
                <input
                  type="text"
                  value={ossBucket}
                  onChange={(e) => setOssBucket(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <p className="d-mono text-[10px] text-[color:var(--donor-amber)]">
                // ⚠ OSS 直传需后端签名服务支持;当前版本仅保存配置,运行时接入待后续版本
              </p>
            </div>
          )}

          {/* Test result */}
          {testResult && (
            <div
              className={`mt-4 p-2 border d-mono text-[11px] ${
                testResult.ok
                  ? 'border-[color:var(--donor-green)] text-[color:var(--donor-green)]'
                  : 'border-[color:var(--donor-red)] text-[color:var(--donor-red)]'
              }`}
            >
              {testResult.ok ? '✓ ' : '✕ '}
              {testResult.msg}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[color:var(--donor-magenta-dim)] flex items-center justify-end gap-2">
          {(mode === 'default' || mode === 'custom-r2') && (
            <button
              type="button"
              onClick={test}
              disabled={testing}
              className="d-hover-invert-cyan px-4 py-2 d-mono text-[12px] tracking-widest uppercase disabled:opacity-50"
            >
              {testing ? '[ TESTING... ]' : '[ TEST ]'}
            </button>
          )}
          <button
            type="button"
            onClick={save}
            className="d-hover-invert px-4 py-2 d-mono text-[12px] tracking-widest uppercase"
          >
            [ SAVE ]
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/** Image ping 兜底:加载 worker_url + favicon.ico,任何 onload/onerror(403/404 都算)都视为可达,只有超时才不可达 */
function pingByImage(url: string, timeoutMs = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      resolve(ok)
    }
    const img = new Image()
    img.onload = () => finish(true)
    img.onerror = () => finish(true) // 任何 HTTP 响应(包括 403/404)都说明网络可达
    try {
      const u = new URL(url)
      img.src = `${u.origin}/favicon.ico?_=${Date.now()}`
    } catch {
      finish(false)
      return
    }
    setTimeout(() => finish(false), timeoutMs)
  })
}

const inputCls =
  'w-full px-3 py-2 bg-[color:var(--donor-bg-1)]/80 border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[13px] placeholder:text-[color:var(--donor-ink-mute)] focus:border-[color:var(--donor-cyan)] focus:outline-none transition-colors'

function ModeTile({
  active,
  onClick,
  label,
  labelJp,
  desc,
}: {
  active: boolean
  onClick: () => void
  label: string
  labelJp: string
  desc: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`d-clip-tag px-3 py-3 text-left border transition-colors cursor-pointer ${
        active
          ? 'bg-[color:var(--donor-magenta)] text-[color:var(--donor-bg-0)] border-[color:var(--donor-magenta)]'
          : 'bg-[color:var(--donor-bg-1)]/60 text-[color:var(--donor-ink-dim)] border-[color:var(--donor-magenta-dim)] hover:border-[color:var(--donor-magenta)] hover:text-[color:var(--donor-magenta)]'
      }`}
    >
      <div className="d-mono text-[11px] tracking-widest flex items-center gap-2">
        {active && <span>▶</span>}
        <span>{labelJp}</span>
        <em className="not-italic opacity-70">/{label}</em>
      </div>
      <div className="mt-1 text-[11px] leading-snug">{desc}</div>
    </button>
  )
}

function Field({
  label,
  labelJp,
  required,
  children,
}: {
  label: string
  labelJp: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="d-mono text-[11px] mb-1 tracking-widest flex items-center gap-2">
        <span className="text-[color:var(--donor-cyan)]">{labelJp}</span>
        <em className="not-italic text-[color:var(--donor-ink-dim)]">/{label}</em>
        {required && <span className="text-[color:var(--donor-red)]">*</span>}
      </div>
      {children}
    </label>
  )
}
