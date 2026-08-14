import { useEffect } from 'react'
import { useFileExplorerStore } from './store'

/**
 * 「这个文件打不开」的提示条,压在预览横幅上方。
 *
 * 为什么需要它:`openTab` 撞到 `fs:stat` 失败时以前是直接 return 的 —— 而调用方
 * (revealPath)已经把面板打开、把路径选中了,于是用户看到的是「面板弹出来了,
 * 然后什么都没发生」。这和「链接点了没反应」在感知上是同一件事,只是成因不同。
 *
 * 会走到这里的三种情况,对用户都是有意义的信息:
 *  - 文件被移走或删掉(agent 重构、清理,或者外部改动)
 *  - 路径落在 allowed roots 之外(主进程的安全闸拒了)
 *  - 那是个目录,不是文件
 *
 * 不用 `window.alert`:它会阻塞渲染进程,而且 jsdom 里被禁用、测不了 —— 本仓库
 * 之前为同样的理由把确认框改成了内联两步按钮。
 */
const AUTO_DISMISS_MS = 8000

/** `fs:stat` 的 reason 是给开发者看的(`Error: ENOENT ...`),这里翻成人话。 */
export function describeOpenError(reason: string): string {
  if (/outside allowed roots/i.test(reason)) return '这个位置不在允许打开的目录里'
  if (/not a file/i.test(reason)) return '这是一个文件夹,不是文件'
  if (/ENOENT|no such file/i.test(reason)) return '文件不存在,可能已被移动或删除'
  return '打不开这个文件'
}

export function FileOpenErrorBanner() {
  const openError = useFileExplorerStore((s) => s.openError)
  const dismiss = useFileExplorerStore((s) => s.dismissOpenError)

  // token 进依赖:同一个路径连点两次也要把计时器重置,否则第二次的提示会被第一次
  // 的计时器提前撤掉。
  const token = openError?.token
  useEffect(() => {
    if (token === undefined) return
    const timer = setTimeout(() => dismiss(), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [token, dismiss])

  if (!openError) return null

  const name = openError.path.split(/[\\/]/).pop() || openError.path
  return (
    <div
      data-testid="file-open-error"
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-100/90"
    >
      <span className="min-w-0 flex-1 truncate" title={openError.path}>
        {describeOpenError(openError.reason)}:{name}
      </span>
      <button
        type="button"
        onClick={() => dismiss()}
        aria-label="关闭提示"
        className="shrink-0 rounded px-1.5 py-0.5 text-amber-200/80 transition hover:bg-amber-500/15"
      >
        ✕
      </button>
    </div>
  )
}
