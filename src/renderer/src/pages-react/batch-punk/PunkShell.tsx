import { type ReactNode } from 'react'

/**
 * PunkShell - donor-punk 主题的根作用域容器
 *
 * 在父级 <main class="container mx-auto"> 内部以容器宽度呈现 (不再脱离 container),
 * 仅保留上下危险带和内部拼贴装饰。
 */
export default function PunkShell({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`donor-punk ${className}`}
      style={{
        width: '100%',
        marginTop: '-1rem',
        minHeight: 'calc(100vh - 100px)',
      }}
    >
      {/* 顶端横贯危险带 */}
      <div
        aria-hidden="true"
        className="p-hazard"
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 18, zIndex: 10 }}
      />
      {/* 底端横贯危险带 */}
      <div
        aria-hidden="true"
        className="p-hazard"
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 18, zIndex: 10 }}
      />

      {/* 内容区,留出上下边距给危险带 */}
      <div
        style={{
          position: 'relative',
          zIndex: 5,
          padding: '36px 24px 36px',
        }}
      >
        {children}
      </div>
    </div>
  )
}
