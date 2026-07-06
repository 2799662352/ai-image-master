import { Component, Suspense, lazy, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * 导演台独立入口 —— 顶栏「导演台 3D」按钮(AGENT 右侧)直接打开,
 * 不依赖生成页的 VisualPromptBar / 参考图。
 *
 * 与 agent-chat 的 mount 同款模式:独立 React root 挂在 body 上,
 * DirectorEditor 本体仍是 lazy chunk,three.js 不进主包。
 */

const DirectorEditor = lazy(() => import('../../components/shared/image-editors/director/DirectorEditor'))

let root: Root | null = null
let host: HTMLDivElement | null = null

class DirectorErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  render() {
    return this.state.hasError ? (
      <div style={{ color: '#a1a1aa', padding: 32, textAlign: 'center' }}>
        3D 预览加载失败(可能硬件加速未开启)
      </div>
    ) : (
      this.props.children
    )
  }
}

export function closeDirectorOverlay(): void {
  // 关闭按钮回调发生在该 root 自己的渲染周期内,同步 unmount 会触发
  // React 告警,推迟到下一拍执行。
  setTimeout(() => {
    root?.unmount()
    root = null
    host?.remove()
    host = null
  }, 0)
}

export function openDirectorOverlay(): void {
  if (root) return
  host = document.createElement('div')
  host.id = 'director-overlay-root'
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.85)',
      }}
    >
      <DirectorErrorBoundary>
        <Suspense fallback={<div style={{ color: '#71717a', fontSize: 14 }}>导演台加载中…</div>}>
          <DirectorEditor entry="native" onClose={closeDirectorOverlay} />
        </Suspense>
      </DirectorErrorBoundary>
    </div>,
  )
}
