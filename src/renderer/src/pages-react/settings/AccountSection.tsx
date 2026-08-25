// 设置页 · 账号分区。身份先于 API 站点,所以排在设置页第一节。
//
// 独立成文件而不是写在 SettingsPage(621 行)里,一是那文件已经够长,二是分区
// 只依赖 auth 桥、能单测 —— 整页搬进 jsdom 得先喂饱四套无关 IPC。
//
// 配色跟随所在页面,用设置页那套主题 token(bg-cyberpunk-yellow / border-zinc-700
// ……),不要混进全屏登录页的字面 hex。

import { useEffect } from 'react'
import { useAuthStore } from '../../stores/useAuthStore'

export function AccountSection() {
  const authenticated = useAuthStore((s) => s.authenticated)
  const username = useAuthStore((s) => s.username)
  const displayName = useAuthStore((s) => s.displayName)
  const role = useAuthStore((s) => s.role)
  const pending = useAuthStore((s) => s.pending)
  const error = useAuthStore((s) => s.error)
  const sessionOnly = useAuthStore((s) => s.sessionOnly)

  const hydrate = useAuthStore((s) => s.hydrate)
  const ensureSubscriptions = useAuthStore((s) => s.ensureSubscriptions)
  const startLogin = useAuthStore((s) => s.startLogin)
  const logout = useAuthStore((s) => s.logout)

  // 接推送 + 拉当前状态,缺一不可:漏前者则登录完成后这一块不动,
  // 漏后者则重启后已登录也显示未登录。ensureSubscriptions 幂等。
  useEffect(() => {
    ensureSubscriptions()
    void hydrate()
  }, [ensureSubscriptions, hydrate])

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 bg-cyberpunk-yellow text-cyberpunk-black flex items-center justify-center text-sm font-bold">
          1
        </span>
        <span className="font-bold text-white uppercase tracking-tight">账号</span>
      </div>

      {authenticated ? (
        <div className="flex items-center justify-between gap-4 bg-zinc-800 border-2 border-zinc-700 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm text-white font-medium truncate">
              {displayName ?? username ?? '已登录'}
            </div>
            <div className="text-xs text-zinc-400 mt-0.5">
              {role ? `角色 ${role}` : '已登录'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void logout()}
            className="shrink-0 px-4 py-2 bg-zinc-800 border-2 border-zinc-700 hover:bg-zinc-700 text-white text-sm font-bold uppercase tracking-tight transition-colors"
          >
            退出登录
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">
            登录后可使用云端出图与素材同步。将在系统浏览器中完成授权,凭证只保存在本机。
          </p>
          <button
            type="button"
            onClick={() => void startLogin()}
            disabled={pending}
            className="px-6 py-2 bg-cyberpunk-yellow hover:opacity-90 text-cyberpunk-black text-sm font-bold uppercase tracking-tight transition-all disabled:opacity-50"
          >
            {pending ? '等待浏览器授权…' : '登录'}
          </button>
        </div>
      )}

      {/* safeStorage 不可用(典型是 Linux 没有系统密码管理器)时的降级。
          不提示的话用户会以为登录压根没生效。 */}
      {sessionOnly && (
        <p className="text-xs text-yellow-300/80 border-l-2 border-cyberpunk-yellow pl-3 py-1">
          凭证仅本次会话有效,重启后需重新登录。
        </p>
      )}

      {/* error 已是主进程按后端 code 映射好的文案,原样显示。 */}
      {error && (
        <p className="text-xs text-red-300 border-l-2 border-red-700 pl-3 py-1">{error}</p>
      )}
    </section>
  )
}
