// 渲染进程「消失即清账」接线（Electron 官方推荐事件组合）。
//
// 背景:generate_image / generate_images 的后台渲染 Promise 活在渲染进程里,
// 终态靠一条 `image:task-update` 广播送回主进程;ask_user 等渲染层工具靠一条
// `agent:tool-response` 回包。渲染进程一旦重载(F5 / Ctrl+R / 崩溃恢复),这些
// 回包永远不会到达 —— 此前只能靠 30 分钟(图片)/ 33 分钟~6 小时(工具)超时
// 兜底,用户看到的就是「挂住」。
//
// 事件语义(Electron docs, api/web-contents.md):
// - `render-process-gone`:渲染进程崩溃/被杀,回包必丢。
// - `did-start-navigation`(main frame && !sameDocument):整页重载/导航,
//   旧 JS 上下文销毁,回包同样必丢。in-page hash 变化(本 app 的 tab 路由)
//   是 same-document,明确排除。
// 首次加载也会触发 did-start-navigation —— 此时任务表/pending 均为空,天然 no-op。

import type { WebContents } from 'electron'
import { IMAGE_TASK_RENDERER_GONE_ERROR } from './tools/imageTaskRegistry'

export interface RendererLifecycleDeps {
  /** 把所有 running 图片任务判失败,返回数量(imageTaskManager.failAllRunning)。 */
  failAllRunningImageTasks: (error: string) => number
  /** 惰性取 ToolRouter(MCP 监听失败时为 null)。 */
  getRouter: () => { failAllPending: (reason: string) => number } | null
}

const wired = new WeakSet<object>()

function settle(deps: RendererLifecycleDeps, cause: string): void {
  const failedTasks = deps.failAllRunningImageTasks(IMAGE_TASK_RENDERER_GONE_ERROR)
  const rejectedCalls = deps.getRouter()?.failAllPending(
    `Renderer ${cause} while this tool call was pending; its response can no longer arrive. ` +
      'The work may have partially completed before the reload — verify with the user before retrying.',
  ) ?? 0
  if (failedTasks > 0 || rejectedCalls > 0) {
    console.warn(
      `[RendererLifecycle] renderer ${cause}: failed ${failedTasks} running image task(s), ` +
        `rejected ${rejectedCalls} pending renderer tool call(s)`,
    )
  }
}

/**
 * 在主窗口 webContents 上挂接「渲染进程消失」清账逻辑。幂等:同一个
 * webContents 重复接线(dev reload / initAgentRuntime 重入)不会叠加监听器。
 */
export function wireRendererLifecycle(contents: WebContents, deps: RendererLifecycleDeps): void {
  if (wired.has(contents)) return
  wired.add(contents)

  contents.on('render-process-gone', (_event, details) => {
    const reason = (details as { reason?: string } | undefined)?.reason ?? 'gone'
    settle(deps, `process gone (${reason})`)
  })

  // Electron >=25 把导航参数并进结构化 event 对象;更早版本用位置参数
  // (event, url, isInPlace, isMainFrame)。两种形态都覆盖,避免升级回归。
  contents.on('did-start-navigation', (event: unknown, ...legacy: unknown[]) => {
    const structured = event as { isMainFrame?: boolean; isSameDocument?: boolean }
    let isMainFrame: boolean
    let isSameDocument: boolean
    if (typeof structured?.isMainFrame === 'boolean') {
      isMainFrame = structured.isMainFrame
      isSameDocument = structured.isSameDocument === true
    } else {
      // legacy: [url, isInPlace, isMainFrame, ...]
      isSameDocument = legacy[1] === true
      isMainFrame = legacy[2] === true
    }
    if (!isMainFrame || isSameDocument) return
    settle(deps, 'reloaded')
  })
}
