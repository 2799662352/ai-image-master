// 全屏登录覆盖层 —— 未登录时盖在全部界面之上。
//
// 不是一个标签页,所以容器不进 tab-panel,而是挂在 body 末尾紧邻 global-toast-root
// (见 index.html)。层级刻意比 toast 低一档:「链接已复制」这类反馈要能盖在它上面。
//
// **四态一律从 store 派生,组件自己不留一份登录状态。** `startLogin()` 在浏览器
// 弹出的那一刻就 resolve 了,它返回的是授权链接、不是登录结果 —— 真正的成败经
// `auth:login-result` 推送落进 store 的 `error` / `authenticated`。把 await 的
// 「没抛异常」当成功,界面就会在用户还盯着浏览器标签页的时候宣布登录完成。
//
// `error` 里已经是主进程按后端 code 映射好的中文文案,这里原样显示。渲染层再按
// code 映射一遍就是两处文案各自漂移的开始。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../stores/useAuthStore'
import { useToastStore } from '../stores/useToastStore'

/** 登录成功后覆盖层自行退场前的停留时长,只为让用户看见「成功」这一眼。 */
const SUCCESS_HOLD_MS = 1800
const COPIED_HOLD_MS = 1600

const PANEL = 'bg-[#18181B] border border-[#3F3F46]'
const ACCENT_BTN =
  'bg-[#FCE300] text-[#09090B] font-bold tracking-wide hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed'
const GHOST_BTN =
  'bg-transparent border border-[#3F3F46] text-white/75 hover:bg-white/5 hover:text-white transition-colors disabled:opacity-40'

type LoginView = 'idle' | 'waiting' | 'success' | 'error'

export default function DesktopLoginPage() {
  const authenticated = useAuthStore((s) => s.authenticated)
  const pending = useAuthStore((s) => s.pending)
  const error = useAuthStore((s) => s.error)
  const authorizeUrl = useAuthStore((s) => s.authorizeUrl)
  const sessionOnly = useAuthStore((s) => s.sessionOnly)
  const displayName = useAuthStore((s) => s.displayName)
  const username = useAuthStore((s) => s.username)

  const hydrate = useAuthStore((s) => s.hydrate)
  const ensureSubscriptions = useAuthStore((s) => s.ensureSubscriptions)
  const startLogin = useAuthStore((s) => s.startLogin)
  const cancelLogin = useAuthStore((s) => s.cancelLogin)
  const submitCode = useAuthStore((s) => s.submitCode)

  const addToast = useToastStore((s) => s.addToast)

  const [codeOpen, setCodeOpen] = useState(false)
  const [code, setCode] = useState('')
  const [copied, setCopied] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  // 只有「这一次真的走过等待态」才配得上一句成功提示。启动时就已登录的场景
  // 不该在用户眼前闪一下「登录成功」。
  const [loginStartedHere, setLoginStartedHere] = useState(false)

  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 接推送 + 拉当前状态,两者缺一不可:漏前者则登录完成后界面不动,
  // 漏后者则重启后已登录也显示未登录。ensureSubscriptions 幂等。
  useEffect(() => {
    ensureSubscriptions()
    void hydrate()
  }, [ensureSubscriptions, hydrate])

  useEffect(() => {
    if (pending) setLoginStartedHere(true)
  }, [pending])

  // 退出等待态时把手动输码的展开与残留值收干净,免得下一轮带着上次的码进来。
  useEffect(() => {
    if (pending) return
    setCodeOpen(false)
    setCode('')
    setCopied(false)
    setSubmitting(false)
  }, [pending])

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  const view: LoginView = error
    ? 'error'
    : pending
      ? 'waiting'
      : authenticated
        ? 'success'
        : 'idle'

  useEffect(() => {
    if (view !== 'success' || !loginStartedHere) return
    const t = setTimeout(() => setLoginStartedHere(false), SUCCESS_HOLD_MS)
    return () => clearTimeout(t)
  }, [view, loginStartedHere])

  const handleCopy = useCallback(async () => {
    if (!authorizeUrl) return
    try {
      await navigator.clipboard.writeText(authorizeUrl)
      setCopied(true)
      addToast({ message: '授权链接已复制', type: 'success' })
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), COPIED_HOLD_MS)
    } catch {
      addToast({ message: '复制失败,请手动选中链接', type: 'error' })
    }
  }, [authorizeUrl, addToast])

  const handleSubmitCode = useCallback(async () => {
    const trimmed = code.trim()
    if (!trimmed) return
    setSubmitting(true)
    // 成败仍由 auth:login-result 汇报,这里只负责把码递进去。
    await submitCode(trimmed)
    setSubmitting(false)
  }, [code, submitCode])

  // 已登录且这一次没走过登录流程 —— 覆盖层没有存在的理由。
  if (view === 'success' && !loginStartedHere) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="桌面端登录"
      className="fixed inset-0 z-[75000] flex items-center justify-center bg-[#09090B] px-6"
    >
      {/* 背景:一道极淡的黄色扫光,避免整块纯黑显得像加载失败 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(circle at 50% 0%, rgba(252,227,0,0.08), transparent 55%)',
        }}
      />

      <div className={`relative w-full max-w-md ${PANEL}`}>
        <div className="border-b border-[#3F3F46] px-8 py-6">
          <div className="flex items-baseline gap-3">
            <span className="h-5 w-1.5 bg-[#FCE300]" aria-hidden="true" />
            <h1 className="text-lg font-black uppercase tracking-[0.2em] text-white">
              CATIMATION
            </h1>
          </div>
          <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.25em] text-white/40">
            // DESKTOP_AUTH
          </p>
        </div>

        <div className="px-8 py-7">
          {view === 'idle' && (
            <IdleView onLogin={() => void startLogin()} />
          )}
          {view === 'waiting' && (
            <WaitingView
              authorizeUrl={authorizeUrl}
              copied={copied}
              codeOpen={codeOpen}
              code={code}
              submitting={submitting}
              onCopy={() => void handleCopy()}
              onOpenCode={() => setCodeOpen(true)}
              onCodeChange={setCode}
              onSubmitCode={() => void handleSubmitCode()}
              onCancel={() => void cancelLogin()}
            />
          )}
          {view === 'success' && (
            <SuccessView name={displayName ?? username} sessionOnly={sessionOnly} />
          )}
          {view === 'error' && (
            // error 是主进程映射好的文案,原样呈现。
            <ErrorView message={error as string} onRetry={() => void startLogin()} />
          )}
        </div>
      </div>
    </div>
  )
}

function IdleView({ onLogin }: { onLogin: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-bold text-white">登录以继续</h2>
        <p className="text-sm leading-relaxed text-white/60">
          将在系统浏览器中打开登录页,完成后自动回到应用。凭证只保存在本机。
        </p>
      </div>
      <button type="button" onClick={onLogin} className={`w-full py-3 text-sm ${ACCENT_BTN}`}>
        使用浏览器登录
      </button>
    </div>
  )
}

function WaitingView({
  authorizeUrl,
  copied,
  codeOpen,
  code,
  submitting,
  onCopy,
  onOpenCode,
  onCodeChange,
  onSubmitCode,
  onCancel,
}: {
  authorizeUrl: string | null
  copied: boolean
  codeOpen: boolean
  code: string
  submitting: boolean
  onCopy: () => void
  onOpenCode: () => void
  onCodeChange: (v: string) => void
  onSubmitCode: () => void
  onCancel: () => void
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-base font-bold text-white">
          <span className="h-2 w-2 animate-pulse bg-[#FCE300]" aria-hidden="true" />
          已在浏览器中打开登录页
        </h2>
        <p className="text-sm leading-relaxed text-white/60">
          请在浏览器里完成授权,然后回到这里,应用会自动继续。
        </p>
      </div>

      {authorizeUrl && (
        <p className="break-all border-l-2 border-[#3F3F46] bg-[#09090B] px-3 py-2 font-mono text-[11px] leading-relaxed text-white/40">
          {authorizeUrl}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onCancel} className={`px-4 py-2 text-xs ${GHOST_BTN}`}>
          取消
        </button>
        <button
          type="button"
          onClick={onCopy}
          disabled={!authorizeUrl}
          className={`px-4 py-2 text-xs ${GHOST_BTN}`}
        >
          {copied ? '已复制' : '复制链接'}
        </button>
        {!codeOpen && (
          <button type="button" onClick={onOpenCode} className={`px-4 py-2 text-xs ${GHOST_BTN}`}>
            手动输入授权码
          </button>
        )}
      </div>

      {codeOpen && (
        <div className="space-y-2 border-t border-[#3F3F46] pt-4">
          <p className="text-xs text-white/60">
            浏览器没能自动跳回时,把页面上给出的授权码粘到这里。
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              aria-label="授权码"
              value={code}
              onChange={(e) => onCodeChange(e.target.value)}
              placeholder="粘贴授权码"
              className="min-w-0 flex-1 border border-[#3F3F46] bg-[#09090B] px-3 py-2 font-mono text-xs text-white placeholder-white/25 focus:border-[#FCE300] focus:outline-none"
            />
            <button
              type="button"
              onClick={onSubmitCode}
              disabled={!code.trim() || submitting}
              className={`whitespace-nowrap px-4 py-2 text-xs ${ACCENT_BTN}`}
            >
              提交授权码
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SuccessView({ name, sessionOnly }: { name: string | null; sessionOnly: boolean }) {
  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-base font-bold text-[#FCE300]">
        <span aria-hidden="true">✓</span>
        登录成功
      </h2>
      <p className="text-sm text-white/75">{name ? `欢迎回来,${name}。` : '正在进入应用…'}</p>
      {sessionOnly && (
        <p className="border-l-2 border-[#FCE300] bg-[#FCE300]/5 px-3 py-2 text-xs leading-relaxed text-white/60">
          凭证仅本次会话有效,重启后需重新登录。
        </p>
      )}
    </div>
  )
}

function ErrorView({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-base font-bold text-white">登录未完成</h2>
        {/* 主进程给的原文案。渲染层不再按 code 映射一遍。 */}
        <p
          role="alert"
          className="border-l-2 border-red-500 bg-red-500/5 px-3 py-2 text-sm leading-relaxed text-red-300"
        >
          {message}
        </p>
      </div>
      {/* 重试一律重新发起 —— 授权码一次性,重放 submitCode 只会拿到 409。 */}
      <button type="button" onClick={onRetry} className={`w-full py-3 text-sm ${ACCENT_BTN}`}>
        重试
      </button>
    </div>
  )
}
