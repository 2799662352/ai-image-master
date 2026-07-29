import { createRoot, type Root } from 'react-dom/client'
import { AgentChatPanel } from './AgentChatPanel'
import { mountAgentToolExecutor } from './AgentToolExecutor'
import { mountSeedanceTaskListener } from './SeedanceTaskListener'
import { mountWorkbenchBatchWatcher } from '../video-workbench/batchCompletion'
import { useAgentChatStore } from './store'

let root: Root | null = null
let host: HTMLDivElement | null = null

/**
 * element-fullscreen 兼容:浏览器全屏(如导演台「⛶ 全屏」= shell.requestFullscreen)
 * 期间只渲染 `document.fullscreenElement` 的后代 —— 挂在 body 下的 agent 面板
 * 无论 z-index 多高都画不出来(Ctrl+Shift+A 切了状态但看不见)。标准解法:
 * 进全屏把面板 host 搬进全屏元素,退出搬回 body。移动容器 DOM 不会卸载
 * React root,面板状态原样保留。
 */
export function syncAgentHostIntoFullscreen(hostEl: HTMLElement | null = host): void {
  if (!hostEl) return
  const fsEl = document.fullscreenElement
  if (fsEl && !fsEl.contains(hostEl)) {
    fsEl.appendChild(hostEl)
  } else if (!fsEl && hostEl.parentElement !== document.body) {
    document.body.appendChild(hostEl)
  }
}

export function mountAgentChatRuntime(): () => void {
  if (root) return () => undefined

  host = document.createElement('div')
  host.id = 'agent-chat-root'
  document.body.appendChild(host)

  root = createRoot(host)
  root.render(<AgentChatPanel />)

  const unmountToolExecutor = mountAgentToolExecutor()
  const unmountSeedanceListener = mountSeedanceTaskListener()
  // 视频工作台批次跑完 → 推给发起它的线程（turn 在跑就 steer 插话，闲着就随
  // 下一条消息带走）。取代让模型轮询 video_workbench_status —— 轮询会把 turn
  // 长期占在工具调用里，用户就插不进话了。
  const unmountWorkbenchWatcher = mountWorkbenchBatchWatcher((notice) => {
    useAgentChatStore.getState().notifyWorkbenchBatchDone(notice.text, notice.threadId)
  })
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      // 全屏中呼出时先确保面板已在全屏元素内(fullscreenchange 之外的兜底)。
      syncAgentHostIntoFullscreen()
      useAgentChatStore.getState().toggle()
    }
  }
  window.addEventListener('keydown', onKeyDown)
  const onFullscreenChange = () => syncAgentHostIntoFullscreen()
  document.addEventListener('fullscreenchange', onFullscreenChange)

  return () => {
    window.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    unmountSeedanceListener()
    unmountWorkbenchWatcher()
    unmountToolExecutor()
    root?.unmount()
    root = null
    host?.remove()
    host = null
  }
}
